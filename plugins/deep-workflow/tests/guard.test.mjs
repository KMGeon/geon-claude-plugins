import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { CORE_IDS, SID, allYes, cli, recordRound, say, startWithScope, tempProject } from "./helpers.mjs";
import { evaluate } from "../hooks/guard.mjs";
import { run } from "../skills/deep-interview/scripts/interview.mjs";

/** 가드 훅에 도구 호출 하나를 넣어 판정 결과를 받는다 (null = 허용). */
const call = (root, tool_name, tool_input, session_id = SID) => evaluate({ session_id, cwd: root, tool_name, tool_input });
const spec = root => path.join(root, ".deep-interview/specs/deep-interview-x.md");

/** 인터뷰 중인 프로젝트. */
function activeProject() {
	const root = tempProject();
	cli(root, "start");
	return root;
}

test("인터뷰 중이 아니면 코드 수정을 막지 않는다", () => {
	const root = tempProject();
	assert.equal(call(root, "Edit", { file_path: path.join(root, "src/app.ts") }), null);
	cli(root, "start");
	cli(root, "end", "--status", "cancelled");
	assert.equal(call(root, "Bash", { command: "npm install" }), null);
});

test("인터뷰 중에는 소스 수정과 쓰기 명령을 막는다", () => {
	const root = activeProject();
	assert.match(call(root, "Edit", { file_path: path.join(root, "src/app.ts") }), /딥 인터뷰 진행 중/);
	assert.match(call(root, "Write", { file_path: "README.md" }), /딥 인터뷰 진행 중/);
	assert.match(call(root, "Bash", { command: "npm test" }), /실행할 수 없습니다/);
	assert.equal(call(root, "Bash", { command: "git diff" }), null);
});

test("막을 때 취소 명령을 알려준다", () => {
	const root = activeProject();
	assert.match(call(root, "Edit", { file_path: path.join(root, "a.ts") }), /interview\.mjs" end --session test-session --status cancelled/);
});

test("상태 폴더는 언제나 직접 고칠 수 없다", () => {
	const root = activeProject();
	const state = path.join(root, ".deep-interview/sessions", SID, "state.json");
	assert.match(call(root, "Write", { file_path: state }), /직접 고칠 수 없습니다/);
	assert.match(call(root, "Edit", { file_path: state }, "other-session"), /직접 고칠 수 없습니다/);
	// 프로젝트 루트를 못 찾거나 세션 ID가 없어도 경로만 보고 막는다.
	assert.match(evaluate({ cwd: "/tmp", tool_name: "Write", tool_input: { file_path: "/tmp/no-root/.deep-interview/sessions/s1/state.json" } }), /직접 고칠 수 없습니다/);
});

test("훅은 인터뷰 CLI와 같은 루트(git 최상위)를 본다: 하위 폴더에 다른 .deep-interview가 있어도", () => {
	const root = tempProject();
	execFileSync("git", ["init", "-q"], { cwd: root });
	const sub = path.join(root, "packages/app");
	fs.mkdirSync(path.join(sub, ".deep-interview"), { recursive: true });
	run(["start", "--session", SID], sub); // CLI는 git 최상위(root)에 상태를 쓴다
	assert.ok(fs.existsSync(path.join(root, ".deep-interview/sessions", SID, "state.json")));
	assert.match(evaluate({ session_id: SID, cwd: sub, tool_name: "Write", tool_input: { file_path: path.join(sub, "src/a.ts") } }), /딥 인터뷰 진행 중/);
	assert.equal(say(sub, "맞아요"), true);
});

test("프로젝트 밖 임시 폴더는 허용하고, 프로젝트 안은 막는다", () => {
	const root = activeProject();
	const outside = fs.mkdtempSync(path.join(os.tmpdir(), "scratch-"));
	assert.equal(call(root, "Write", { file_path: path.join(outside, "draft.md") }), null);
	assert.match(call(root, "Write", { file_path: path.join(root, "notes.md") }), /딥 인터뷰 진행 중/);
});

test("스펙 저장: 기록이 없으면 막는다", () => {
	const root = tempProject();
	startWithScope(root);
	assert.match(call(root, "Write", { file_path: spec(root) }), /기록된 라운드가 없습니다/);
});

test("스펙 저장: 모호도가 기준보다 높으면 막고, 조기 종료 표시 후에는 허용한다", () => {
	const root = tempProject();
	startWithScope(root);
	for (const round of [1, 2, 3]) recordRound(root, round, { g1: "근거" });
	say(root, "이 정도면 됐어");
	assert.match(call(root, "Write", { file_path: spec(root) }), /기준값 20%보다 높습니다/);
	cli(root, "early-exit");
	assert.equal(call(root, "Write", { file_path: spec(root) }), null);
});

test("스펙 저장: 마지막 라운드 뒤 사용자 확인이 없으면 막는다", () => {
	const root = tempProject();
	startWithScope(root);
	recordRound(root, 1, allYes(CORE_IDS));
	assert.match(call(root, "Write", { file_path: spec(root) }), /사용자 답이 없습니다/);
	say(root, "네, 이대로");
	assert.equal(call(root, "Write", { file_path: spec(root) }), null);
});

test("다른 세션은 막지 않는다", () => {
	const root = activeProject();
	assert.equal(call(root, "Edit", { file_path: path.join(root, "src/app.ts") }, "other-session"), null);
});

test("하위 폴더에서 작업해도 막는다", () => {
	const root = activeProject();
	const sub = path.join(root, "packages/app");
	fs.mkdirSync(sub, { recursive: true });
	assert.match(evaluate({ session_id: SID, cwd: sub, tool_name: "Edit", tool_input: { file_path: "index.ts" } }), /딥 인터뷰 진행 중/);
});
