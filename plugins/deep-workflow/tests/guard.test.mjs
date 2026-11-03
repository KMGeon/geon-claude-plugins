import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { CORE_IDS, SID, allYes, choose, cli, confirmSpec, recordRound, say, startWithScope, tempProject } from "./helpers.mjs";
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
	// 조기 종료여도 한 문장 맞춰 보기 확인("네, 이대로" 선택)은 있어야 한다.
	assert.match(call(root, "Write", { file_path: spec(root) }), /"네, 이대로"를 고른 기록이 없습니다/);
	confirmSpec(root);
	assert.equal(call(root, "Write", { file_path: spec(root) }), null);
});

test("스펙 저장: 마지막 라운드 뒤 사용자가 선택지 창에서 '네, 이대로'를 골라야 한다", () => {
	const root = tempProject();
	startWithScope(root);
	recordRound(root, 1, allYes(CORE_IDS));
	assert.match(call(root, "Write", { file_path: spec(root) }), /고른 기록이 없습니다/);
	// 되물음, 채팅 답, 다른 선택지는 확인이 아니다.
	say(root, "그게 무슨 뜻이에요?");
	assert.match(call(root, "Write", { file_path: spec(root) }), /고른 기록이 없습니다/);
	say(root, "네, 이대로");
	assert.match(call(root, "Write", { file_path: spec(root) }), /고른 기록이 없습니다/);
	choose(root, "확인", "표현 고치기");
	assert.match(call(root, "Write", { file_path: spec(root) }), /고른 기록이 없습니다/);
	confirmSpec(root);
	assert.equal(call(root, "Write", { file_path: spec(root) }), null);
	// 확인 뒤에 사용자가 다른 말을 하면 다시 확인받아야 한다.
	say(root, "아 잠깐, 하나 더");
	assert.match(call(root, "Write", { file_path: spec(root) }), /고른 기록이 없습니다/);
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

/** git 저장소인 임시 폴더. 색인(DEEP_WORKFLOW_HOME)은 tempProject가 새로 잡는다. */
function gitProject(make = tempProject) {
	const root = fs.realpathSync(make());
	execFileSync("git", ["init", "-q"], { cwd: root });
	return root;
}
/** 색인을 그대로 둔 채 두 번째 git 저장소를 만든다. */
const anotherGitProject = () => gitProject(() => fs.mkdtempSync(path.join(os.tmpdir(), "elsewhere-")));
/** 임시 폴더가 아닌 소스 경로 (가드의 임시 폴더 예외에 걸리지 않게). 실제로 만들지는 않는다. */
const sourceFile = path.join(os.homedir(), "deep-workflow-guard-test-never-created", "src", "a.ts");

test("cd로 다른 저장소에 가도 이 세션의 인터뷰가 막는다 (세션 색인)", () => {
	const home = gitProject();
	const elsewhere = anotherGitProject();
	run(["start", "--session", SID], home);
	// cwd가 다른 저장소여도 훅, 답 기록, 상태 명령 모두 인터뷰가 있는 루트를 본다.
	assert.match(evaluate({ session_id: SID, cwd: elsewhere, tool_name: "Bash", tool_input: { command: "npm test" } }), /딥 인터뷰 진행 중/);
	assert.match(evaluate({ session_id: SID, cwd: elsewhere, tool_name: "Write", tool_input: { file_path: sourceFile } }), /딥 인터뷰 진행 중/);
	assert.equal(say(elsewhere, "맞아요"), true);
	assert.equal(run(["status", "--session", SID], elsewhere).answers_recorded, 1);
	assert.equal(run(["start", "--session", SID], elsewhere).already_active, true);
	assert.equal(fs.existsSync(path.join(elsewhere, ".deep-interview")), false);
});

test("인터뷰가 끝나면 색인은 비켜나고, cwd의 저장소에 새로 시작할 수 있다", () => {
	const first = gitProject();
	const second = anotherGitProject();
	run(["start", "--session", SID], first);
	run(["end", "--session", SID, "--status", "cancelled"], first);
	assert.equal(evaluate({ session_id: SID, cwd: second, tool_name: "Bash", tool_input: { command: "npm test" } }), null);
	assert.equal(run(["start", "--session", SID], second).already_active, false);
	assert.ok(fs.existsSync(path.join(second, ".deep-interview/sessions", SID, "state.json")));
	// 이제 진행 중인 인터뷰는 second에 있다. 세션에 진행 중인 인터뷰가 있으면 first로 돌아가도 막는다.
	assert.match(evaluate({ session_id: SID, cwd: first, tool_name: "Bash", tool_input: { command: "npm test" } }), /딥 인터뷰 진행 중/);
});
