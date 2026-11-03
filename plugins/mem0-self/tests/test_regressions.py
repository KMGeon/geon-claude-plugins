"""Offline regressions for OSS scope, pause boundaries, and flush ownership."""

import contextlib
from dataclasses import replace
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

PLUGIN = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PLUGIN / "core"))
import memory_core as core


class IsolatedTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="mem0-regression-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.env_patch = patch.dict(os.environ, {
            "PATH": os.environ.get("PATH", ""),
            "SYSTEMROOT": os.environ.get("SYSTEMROOT", ""),
            "MEM0_CODE_DATA_DIR": str(self.root / "data"),
            "MEM0_CODE_USER_ID": "test-user",
            "MEM0_TELEMETRY": "false",
            "MEM0_CODE_AUTO_FLUSH": "false",
            "PYTHONDONTWRITEBYTECODE": "1",
        }, clear=True)
        self.env_patch.start()
        self.addCleanup(self.env_patch.stop)
        self.repo = core.RepoContext(str(self.root), str(self.root), "local:test-repo",
                                     "repo-a", "main", "", "repo-a", "")


class ScopeTests(IsolatedTest):
    def test_forget_excludes_other_and_unknown_projects(self):
        memories = [
            {"id": "own", "metadata": {"project": "repo-a"}},
            {"id": "nested", "metadata": {"project": "repo-a/pkg"}},
            {"id": "other", "metadata": {"project": "repo-b"}},
            {"id": "prefix", "metadata": {"project": "repo-ab"}},
            {"id": "unknown"},
            {"id": "legacy", "app_id": "repo-a"},
            {"id": "project-own", "agent_id": "repo-a"},
            {"id": "project-other", "agent_id": "repo-b"},
        ]
        with patch.object(core, "_oss_http", return_value=({"results": memories}, 0, 0)):
            personal = core._scoped_memory_ids("http://fixture", "key", "test-user", self.repo, False)
            shared = core._scoped_memory_ids("http://fixture", "key", "test-user", self.repo, True)
        self.assertEqual(set(personal), {"own", "nested", "legacy"})
        self.assertEqual(set(shared), {"own", "nested", "legacy", "project-own"})

    def test_repository_search_is_not_starved_by_other_repositories(self):
        other = [{"id": str(i), "agent_id": "repo-b", "score": 1.0} for i in range(20)]
        own = {"id": "own", "agent_id": "repo-a", "score": 0.8}
        personal = {"id": "personal", "score": 0.9}
        calls = []
        def http(method, url, key, payload, timeout):
            calls.append(payload)
            rows = [own] if payload["filters"].get("agent_id") == "repo-a" else [personal, *other, own]
            return {"results": rows[:payload["top_k"]]}, 0, 0
        filters = core._search_filters("test-user", self.repo, "repo")
        with patch.object(core, "_oss_http", side_effect=http):
            response, _, _ = core._oss_search("http://fixture", "key", {
                "query": "build", "filters": filters, "top_k": 3, "rerank": False}, 1)
        self.assertEqual({m["id"] for m in response["results"]}, {"own", "personal"})
        self.assertTrue(any(p["filters"].get("agent_id") == "repo-a" for p in calls))

    def test_directory_search_keeps_personal_memories_and_scopes_server_requests(self):
        repo = replace(self.repo, directory="src")
        own = {"id": "own", "agent_id": "repo-a", "score": 0.8,
               "metadata": {"dirs": ["src"], "session_id": "session-a"}}
        personal = {"id": "personal", "score": 0.9, "metadata": {"session_id": "session-a"}}
        wrong_dir = {"id": "wrong-dir", "agent_id": "repo-a", "score": 1.0,
                     "metadata": {"dirs": ["docs"], "session_id": "session-a"}}
        wrong_session = {"id": "wrong-session", "score": 1.0,
                         "metadata": {"session_id": "session-b"}}
        calls = []
        def http(method, url, key, payload, timeout):
            calls.append(payload)
            return {"results": [own, personal, wrong_dir, wrong_session]}, 0, 0
        filters = {"AND": [core._search_filters("test-user", repo, "dir"), {"run_id": "session-a"}]}
        with patch.object(core, "_oss_http", side_effect=http):
            response, _, _ = core._oss_search("http://fixture", "key", {
                "query": "build", "filters": filters, "top_k": 3, "rerank": False}, 1)
        self.assertEqual([m["id"] for m in response["results"]], ["personal", "own"])
        project_call = next(p for p in calls if p["filters"].get("agent_id"))
        personal_call = next(p for p in calls if not p["filters"].get("agent_id"))
        self.assertEqual(project_call["filters"]["dirs"], "src")
        self.assertNotIn("dirs", personal_call["filters"])
        self.assertTrue(all(p["filters"]["session_id"] == "session-a" for p in calls))
        self.assertTrue(all(p["rerank"] is False for p in calls))


class PauseTests(IsolatedTest):
    def setUp(self):
        super().setUp()
        self.transcript = self.root / "transcript.jsonl"
        self.transcript.write_text("")
        self.session = "pause-test"
        self.parent = None
        self.number = 0

    def append(self, role, text):
        self.number += 1
        uuid = str(self.number)
        row = {"uuid": uuid, "parentUuid": self.parent, "sessionId": self.session,
               "type": role, "message": {"role": role, "content": text if role == "user"
                                          else [{"type": "text", "text": text}]}}
        with self.transcript.open("a") as f:
            f.write(json.dumps(row) + "\n")
        self.parent = uuid

    def hook(self, action, **extra):
        payload = {"session_id": self.session, "cwd": str(self.root),
                   "transcript_path": str(self.transcript), **extra}
        subprocess.run([sys.executable, "-B", str(PLUGIN / "adapters/claude/hook.py"), action],
                       input=json.dumps(payload), text=True, capture_output=True, check=True,
                       cwd=self.root, timeout=5)
        errors = self.root / "data/plugin-errors.log"
        self.assertFalse(errors.exists(), errors.read_text() if errors.exists() else "")

    def control(self, command):
        subprocess.run([sys.executable, "-B", str(PLUGIN / "core/memory_cli.py"), command],
                       cwd=self.root, capture_output=True, check=True, timeout=5)

    def exchange(self, label):
        self.append("user", label)
        self.hook("user-prompt", prompt=label)
        self.append("assistant", label + " reply")
        self.hook("stop", last_assistant_message=label + " reply")

    def captured(self):
        with sqlite3.connect(self.root / "data/evidence.sqlite3") as c:
            return str(c.execute("SELECT payload_json FROM events").fetchall())

    def test_resume_never_captures_paused_messages(self):
        self.hook("session-start")
        self.exchange("PUBLIC_BEFORE")
        self.control("pause")
        self.exchange("PRIVATE_MARKER")
        self.assertNotIn("PRIVATE_MARKER", self.captured())
        # A transcript row can arrive after the final paused hook.
        self.append("assistant", "PRIVATE_LATE_MARKER")
        self.control("resume")
        self.exchange("PUBLIC_AFTER")
        captured = self.captured()
        self.assertIn("PUBLIC_BEFORE", captured)
        self.assertIn("PUBLIC_AFTER", captured)
        self.assertNotIn("PRIVATE_MARKER", captured)
        self.assertNotIn("PRIVATE_LATE_MARKER", captured)

    def test_session_started_while_paused_has_no_retroactive_capture(self):
        self.control("pause")
        self.hook("session-start")
        self.exchange("PRIVATE_NEW_SESSION")
        self.control("resume")
        self.exchange("PUBLIC_AFTER")
        self.assertNotIn("PRIVATE_NEW_SESSION", self.captured())
        self.assertIn("PUBLIC_AFTER", self.captured())

    def test_repeated_pause_cycles_skip_each_private_segment(self):
        self.hook("session-start")
        for cycle in range(3):
            self.exchange(f"PUBLIC_BEFORE_{cycle}")
            self.control("pause")
            self.exchange(f"PRIVATE_{cycle}")
            self.control("resume")
            self.exchange(f"PUBLIC_AFTER_{cycle}")
        captured = self.captured()
        self.assertNotIn("PRIVATE_", captured)
        for cycle in range(3):
            self.assertIn(f"PUBLIC_BEFORE_{cycle}", captured)
            self.assertIn(f"PUBLIC_AFTER_{cycle}", captured)

    def test_resume_while_active_does_not_skip_pending_public_response(self):
        self.hook("session-start")
        self.control("pause")
        self.exchange("PRIVATE_MARKER")
        self.control("resume")
        self.append("user", "PUBLIC_AFTER")
        self.hook("user-prompt", prompt="PUBLIC_AFTER")
        self.append("assistant", "PUBLIC_PENDING_RESPONSE")
        self.control("resume")
        self.hook("stop", last_assistant_message="PUBLIC_PENDING_RESPONSE")
        self.assertIn("PUBLIC_PENDING_RESPONSE", self.captured())
        self.assertNotIn("PRIVATE_MARKER", self.captured())


class FlushTests(IsolatedTest):
    def test_failed_flush_releases_session_for_retry(self):
        with contextlib.closing(core.EvidenceStore()) as store:
            repo = store.repo_for_session("retry", str(self.root))
            store.record_event(repo, "retry", "user_prompt", {"text": "use the test-build command"})
            store.record_assistant_response(repo, "retry", "Use test-build for this repository.")
            hook_input = {"session_id": "retry", "cwd": str(self.root)}
            with patch.object(core, "api_key", return_value="key"), patch.object(
                core, "_request_json", side_effect=TimeoutError("fixture network timeout")
            ):
                failed = core.checkpoint_session(store, hook_input, "session-end")
            self.assertNotEqual(failed["status"], "semantic-succeeded")
            with patch.object(core, "api_key", return_value="key"), patch.object(
                core, "_request_json", return_value=({"event_id": "sync:1"}, 10, 10)
            ) as send:
                retried = core.checkpoint_session(store, hook_input, "session-end")
            self.assertEqual(retried["status"], "semantic-succeeded")
            self.assertEqual(send.call_count, 1)

    def test_paused_checkpoint_never_sends(self):
        with contextlib.closing(core.EvidenceStore()) as store:
            repo = store.repo_for_session("paused", str(self.root))
            store.record_event(repo, "paused", "user_prompt", {"text": "public pending fact"})
            store.set_setting("paused", "true")
            with patch.object(core, "api_key", return_value="key"), patch.object(core, "_request_json") as send:
                result = core.checkpoint_session(store, {"session_id": "paused", "cwd": str(self.root)}, "session-end")
            send.assert_not_called()
            self.assertEqual(result["status"], "paused")

    def test_two_handoffs_cannot_send_the_same_packet(self):
        first_seen = threading.Event()
        release = threading.Event()
        bodies = []
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                bodies.append(body)
                if len(bodies) == 1:
                    first_seen.set()
                    release.wait(8)
                result = b'{"results":[{"id":"test-memory"}]}'
                self.send_response(200)
                self.send_header("Content-Length", str(len(result)))
                self.end_headers()
                self.wfile.write(result)
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        data = self.root / "data"
        with contextlib.closing(core.EvidenceStore()) as store:
            repo = store.repo_for_session("concurrent", str(self.root))
            store.record_event(repo, "concurrent", "user_prompt", {"text": "the repository uses test-build"})
            store.record_assistant_response(repo, "concurrent", "The repository uses test-build.")
            store.prepare_flush(repo, "concurrent", "pre-compact")
        (data / "api-key").write_text("fixture-key")
        env = dict(os.environ, MEM0_API_URL=f"http://127.0.0.1:{server.server_port}",
                   MEM0_CODE_EXTRACTION_WAIT_SECONDS="0.05")
        paths = [data / "first.running", data / "second.running"]
        for i, p in enumerate(paths):
            p.write_text(json.dumps({"hook_input": {"session_id": "concurrent", "cwd": str(self.root)},
                                     "reason": "session-end" if i else "pre-compact", "wait_for_inflight": bool(i)}))
        workers = []
        def start(p):
            worker = subprocess.Popen([sys.executable, "-B", str(PLUGIN / "core/flush_worker.py"), str(p)],
                                      env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            workers.append(worker)
            return worker
        try:
            first = start(paths[0])
            self.assertTrue(first_seen.wait(5))
            second = start(paths[1])
            output, errors = second.communicate(timeout=5)
            self.assertEqual(second.returncode, 0, errors)
            self.assertEqual(json.loads(output)["status"], "busy")
            self.assertEqual(len(bodies), 1)
            self.assertTrue(paths[1].with_suffix(".json").exists())
            release.set()
            output, errors = first.communicate(timeout=5)
            self.assertEqual(first.returncode, 0, errors)
            retry = start(paths[1].with_suffix(".json"))
            output, errors = retry.communicate(timeout=5)
            self.assertEqual(retry.returncode, 0, errors)
            self.assertEqual(json.loads(output)["status"], "nothing-to-flush")
            self.assertEqual(len(bodies), 1)
        finally:
            release.set()
            for worker in workers:
                if worker.poll() is None:
                    worker.terminate()
                worker.communicate(timeout=5)


if __name__ == "__main__":
    unittest.main()
