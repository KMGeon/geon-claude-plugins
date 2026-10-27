import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkDesign, checkPlan, parseSpec, readState, run } from "../skills/deep-build/scripts/build.mjs";
import { evaluate } from "../hooks/guard.mjs";

const SID = "build-session";

const SPEC = `# 사내 휴가 신청 기능 — 딥 인터뷰 스펙

## 한눈에 보기
- 문제(왜): 기록이 없다
- 한 문장 요약: 직원이 신청하면 팀장이 승인한다.
- 결과: 기준 통과

## 무엇을 만드나
설명

**고정 항목**
- \`화면:신청폼\` — 직원이 휴가를 신청하는 화면
- \`연결:슬랙\` — 슬랙 DM 알림

## 경계
**지킬 조건**
- 팀장 1단계

## 다 됐다는 기준
- [ ] 신청하면 팀장 DM이 온다
- [ ] 승인하면 남은 일수가 준다
- [x] 과거 날짜는 거부된다

## 남은 질문
- [ ] 팀장 정보 출처 — 무건님
`;

const DESIGN_OK = `# 설계

## 시퀀스
\`\`\`mermaid
sequenceDiagram
  직원->>서버: 신청
\`\`\`

## 상태
\`\`\`mermaid
stateDiagram-v2
  대기 --> 승인
\`\`\`

## ERD
생략: 이번엔 메모리 저장만 쓴다

## API
| 이름 | 입력 | 출력 | 오류 |
|:---|:---|:---|:---|
| createRequest | 날짜 | id | 과거 날짜 |
`;

/** 스펙 파일이 있는 임시 프로젝트를 만든다. */
function project(spec = SPEC) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "deep-build-test-"));
	fs.mkdirSync(path.join(root, ".deep-interview/specs"), { recursive: true });
	fs.writeFileSync(path.join(root, ".deep-interview/specs/deep-interview-leave.md"), spec);
	return root;
}
const cli = (root, ...args) => run([...args, "--session", SID, "--root", root], root);
const jsonFile = (root, name, value) => {
	const file = path.join(root, name);
	fs.writeFileSync(file, JSON.stringify(value));
	return `@${file}`;
};
const started = root => cli(root, "start", "--spec", ".deep-interview/specs/deep-interview-leave.md");
const withDesign = root => {
	started(root);
	fs.mkdirSync(path.join(root, ".deep-interview/designs"), { recursive: true });
	fs.writeFileSync(path.join(root, ".deep-interview/designs/leave.md"), DESIGN_OK);
	return cli(root, "design", "--file", ".deep-interview/designs/leave.md");
};
const task = (id, covers, extra = {}) => ({ id, title: `작업 ${id}`, files: ["src/a.ts"], interface: "f() → x", test: "실패 테스트", covers, depends_on: [], ...extra });
const FULL_PLAN = { tasks: [task("T1", { fixed: ["화면:신청폼"], criteria: ["AC-1", "AC-3"] }), task("T2", { fixed: ["연결:슬랙"], criteria: ["AC-2"] }, { depends_on: ["T1"] })] };

test("parseSpec: 제목, 결과, 고정 항목, 완료 기준(AC-n)을 뽑는다", () => {
	const spec = parseSpec(SPEC);
	assert.equal(spec.title, "사내 휴가 신청 기능");
	assert.equal(spec.passed, true);
	assert.deepEqual(spec.fixed_items.map(i => i.id), ["화면:신청폼", "연결:슬랙"]);
	assert.deepEqual(spec.criteria.map(c => c.id), ["AC-1", "AC-2", "AC-3"]);
	assert.equal(spec.criteria[2].text, "과거 날짜는 거부된다");
	// 남은 질문의 체크박스는 완료 기준으로 세지 않는다
});

test("start: 기준 미달 스펙은 --force 없이 거부한다", () => {
	const root = project(SPEC.replace("기준 통과", "기준 미달로 조기 종료"));
	assert.throws(() => started(root), /조기 종료된 스펙/);
	const forced = cli(root, "start", "--spec", ".deep-interview/specs/deep-interview-leave.md", "--force");
	assert.equal(forced.status, "designing");
	assert.equal(readState(root, SID).forced, true);
});

test("start: 완료 기준 ID와 고정 항목을 돌려준다", () => {
	const root = project();
	const r = started(root);
	assert.equal(r.slug, "leave");
	assert.deepEqual(r.fixed_items, ["화면:신청폼", "연결:슬랙"]);
	assert.equal(r.criteria.length, 3);
});

test("checkDesign: 네 절이 모두 있고 내용이나 생략 이유가 있어야 한다", () => {
	assert.deepEqual(checkDesign(DESIGN_OK), []);
	const missing = checkDesign(DESIGN_OK.replace("## ERD\n생략: 이번엔 메모리 저장만 쓴다\n", ""));
	assert.match(missing[0], /ERD.*절이 없습니다/);
	const empty = checkDesign(DESIGN_OK.replace("생략: 이번엔 메모리 저장만 쓴다", "나중에"));
	assert.match(empty[0], /ERD.*Mermaid 블록도.*생략/);
});

test("design: 등록하면 planning이 되고, 빈 절이 있으면 거부한다", () => {
	const root = project();
	assert.equal(withDesign(root).status, "planning");
	fs.writeFileSync(path.join(root, ".deep-interview/designs/bad.md"), "# x\n## 시퀀스\n생략: 없음\n");
	assert.throws(() => cli(root, "design", "--file", ".deep-interview/designs/bad.md"), /완성되지 않았습니다/);
});

test("checkPlan: 고정 항목·완료 기준에 담당 작업이 없으면 거부한다", () => {
	const spec = parseSpec(SPEC);
	assert.deepEqual(checkPlan(FULL_PLAN, spec), []);
	const partial = { tasks: [task("T1", { fixed: ["화면:신청폼"], criteria: ["AC-1"] })] };
	const problems = checkPlan(partial, spec);
	assert.ok(problems.some(p => p.includes("고정 항목: 연결:슬랙")));
	assert.ok(problems.some(p => p.includes("완료 기준: AC-2, AC-3")));
});

test("checkPlan: 빈 필드, 없는 ID, 잘못된 의존을 잡는다", () => {
	const spec = parseSpec(SPEC);
	const bad = { tasks: [{ id: "T1", title: "x", files: [], covers: { fixed: ["없음"], criteria: ["AC-9"] }, depends_on: ["T7", "T1"] }] };
	const problems = checkPlan(bad, spec);
	for (const needle of ["files", "interface", "test", "없는 고정 항목 없음", "없는 완료 기준 AC-9", "T7", "자기 자신"]) {
		assert.ok(problems.some(p => p.includes(needle)), needle);
	}
});

test("plan: 통과하면 계획 파일을 쓰고 reviewing이 된다", () => {
	const root = project();
	withDesign(root);
	const r = cli(root, "plan", "--input", jsonFile(root, "plan.json", FULL_PLAN));
	assert.equal(r.status, "reviewing");
	assert.equal(r.task_count, 2);
	const md = fs.readFileSync(path.join(root, r.plan_path), "utf8");
	assert.match(md, /## 연결 표/);
	assert.match(md, /\| AC-2 \| 승인하면 남은 일수가 준다 \| T2 \|/);
	assert.match(md, /먼저 실패할 테스트: 실패 테스트/);
});

test("plan: 설계 전에는 거부하고, 연결이 빠지면 거부한다", () => {
	const root = project();
	started(root);
	assert.throws(() => cli(root, "plan", "--input", jsonFile(root, "p.json", FULL_PLAN)), /planning\/revising 상태/);
	withDesign(project()); // 별도 프로젝트에서 설계 등록 흐름 확인
	const root2 = project();
	withDesign(root2);
	assert.throws(() => cli(root2, "plan", "--input", jsonFile(root2, "p.json", { tasks: [task("T1", { fixed: ["화면:신청폼"], criteria: ["AC-1"] })] })), /담당 작업이 없는/);
});

test("review: pass면 planned, revise는 3회까지, 넘으면 stuck", () => {
	const root = project();
	withDesign(root);
	cli(root, "plan", "--input", jsonFile(root, "plan.json", FULL_PLAN));
	const revise = { verdict: "revise", findings: [{ id: "r1", target: "T1", severity: "blocker", finding: "테스트가 모호함" }] };
	for (const round of [1, 2]) {
		const r = cli(root, "review", "--input", jsonFile(root, "rv.json", revise));
		assert.equal(r.status, "revising");
		assert.equal(r.rounds_left, 3 - round);
		cli(root, "plan", "--input", jsonFile(root, "plan.json", FULL_PLAN)); // 고쳐서 다시 등록
	}
	const third = cli(root, "review", "--input", jsonFile(root, "rv.json", revise));
	assert.equal(third.status, "stuck");
	assert.equal(third.rounds_left, 0);
	assert.throws(() => cli(root, "plan", "--input", jsonFile(root, "plan.json", FULL_PLAN)), /planning\/revising 상태/);

	const root2 = project();
	withDesign(root2);
	cli(root2, "plan", "--input", jsonFile(root2, "plan.json", FULL_PLAN));
	assert.equal(cli(root2, "review", "--input", jsonFile(root2, "rv.json", { verdict: "pass", findings: [], summary: "좋음" })).status, "planned");
});

test("review: revise에는 findings가 있어야 하고, reviewing 상태에서만 기록된다", () => {
	const root = project();
	withDesign(root);
	assert.throws(() => cli(root, "review", "--input", jsonFile(root, "rv.json", { verdict: "pass" })), /reviewing 상태/);
	cli(root, "plan", "--input", jsonFile(root, "plan.json", FULL_PLAN));
	assert.throws(() => cli(root, "review", "--input", jsonFile(root, "rv.json", { verdict: "revise", findings: [] })), /findings가 하나 이상/);
});

test("가드 훅: plans/와 builds/는 직접 쓸 수 없고 designs/는 된다", () => {
	const root = project();
	const call = file => evaluate({ tool_name: "Write", cwd: root, tool_input: { file_path: path.join(root, file) } });
	assert.match(call(".deep-interview/plans/leave.md"), /직접 쓸 수 없습니다/);
	assert.match(call(".deep-interview/builds/x.json"), /직접 쓸 수 없습니다/);
	assert.equal(call(".deep-interview/designs/leave.md"), null);
	assert.equal(call("src/app.ts"), null);
	assert.equal(evaluate({ tool_name: "Bash", cwd: root, tool_input: { command: "ls" } }), null);
});

// ---------------------------------------------------------------------------
// 2단계: 구현 → 완료 판정
// ---------------------------------------------------------------------------
import { taskOrder, runCommand } from "../skills/deep-build/scripts/build.mjs";

/** 검토를 통과해 planned 상태인 프로젝트. */
function planned(root, plan = FULL_PLAN) {
	withDesign(root);
	cli(root, "plan", "--input", jsonFile(root, "plan.json", plan));
	cli(root, "review", "--input", jsonFile(root, "rv.json", { verdict: "pass", findings: [] }));
	return root;
}
const BIG_PLAN = { tasks: [
	task("T1", { fixed: ["화면:신청폼"], criteria: ["AC-1"] }),
	task("T2", { fixed: [], criteria: ["AC-2"] }, { depends_on: ["T1"] }),
	task("T3", { fixed: ["연결:슬랙"], criteria: [] }),
	task("T4", { fixed: [], criteria: ["AC-3"] }, { depends_on: ["T2", "T3"] }),
] };

test("taskOrder: 의존을 지키고 순환은 거부한다", () => {
	assert.deepEqual(taskOrder(BIG_PLAN.tasks), ["T1", "T2", "T3", "T4"]);
	assert.throws(() => taskOrder([task("A", {}, { depends_on: ["B"] }), task("B", {}, { depends_on: ["A"] })]), /순환/);
});

test("runCommand: 종료 코드와 출력 끝부분을 돌려준다", () => {
	const ok = runCommand(os.tmpdir(), "echo hi");
	assert.equal(ok.exit_code, 0);
	assert.match(ok.output_tail, /hi/);
	assert.equal(runCommand(os.tmpdir(), "exit 3").exit_code, 3);
});

test("execute: planned에서만 시작하고, 작업 수로 방식을 정한다", () => {
	const root = project();
	withDesign(root);
	assert.throws(() => cli(root, "execute"), /planned/);
	assert.equal(cli(planned(project()), "execute").mode, "single");
	const big = cli(planned(project(), BIG_PLAN), "execute");
	assert.equal(big.mode, "agents");
	assert.equal(big.next_task, "T1");
});

test("task-done: 코드가 테스트를 실행하고, 순서를 어기면 거부한다", () => {
	const root = planned(project());
	cli(root, "execute");
	assert.throws(() => cli(root, "task-done", "--task", "T2", "--cmd", "exit 0"), /의존 작업이 아직 끝나지 않았습니다. 지금 할 수 있는 작업: T1/);
	const fail1 = cli(root, "task-done", "--task", "T1", "--cmd", "exit 1");
	assert.equal(fail1.passed, false);
	assert.equal(fail1.attempts_left, 2);
	const ok = cli(root, "task-done", "--task", "T1", "--cmd", "echo pass");
	assert.equal(ok.passed, true);
	assert.equal(ok.task_status, "done");
	assert.equal(ok.next_task, "T2");
	assert.throws(() => cli(root, "task-done", "--task", "T1", "--cmd", "exit 0"), /이미 끝난/);
});

test("task-done: 3회 실패하면 전체가 stuck이 되고 끝난·남은 작업을 돌려준다", () => {
	const root = planned(project());
	cli(root, "execute");
	let r;
	for (let i = 0; i < 3; i += 1) r = cli(root, "task-done", "--task", "T1", "--cmd", "exit 1");
	assert.equal(r.status, "stuck");
	assert.match(r.failed_reason, /T1: 3회/);
	assert.deepEqual(r.remaining, ["T1", "T2"]);
	assert.throws(() => cli(root, "task-done", "--task", "T1", "--cmd", "exit 0"), /executing/);
});

test("agents 방식: 테스트 통과 뒤 리뷰 pass여야 done, revise는 실패로 센다", () => {
	const root = planned(project(), BIG_PLAN);
	cli(root, "execute");
	assert.deepEqual(cli(root, "status").ready_tasks, ["T1", "T3"]); // 독립 작업은 병렬 가능
	const t = cli(root, "task-done", "--task", "T1", "--cmd", "exit 0");
	assert.equal(t.task_status, "awaiting_review");
	assert.throws(() => cli(root, "task-done", "--task", "T2", "--cmd", "exit 0"), /의존 작업이 아직 끝나지 않았습니다/);
	assert.equal(cli(root, "task-done", "--task", "T3", "--cmd", "exit 0").task_status, "awaiting_review"); // T1 리뷰 전에도 T3는 가능
	const rv = cli(root, "task-review", "--task", "T1", "--input", jsonFile(root, "tr.json", { verdict: "revise", findings: [{ target: "T1", finding: "범위 초과" }] }));
	assert.equal(rv.task_status, "failed");
	assert.equal(rv.attempts_left, 2);
	cli(root, "task-done", "--task", "T1", "--cmd", "exit 0");
	const ok = cli(root, "task-review", "--task", "T1", "--input", jsonFile(root, "tr.json", { verdict: "pass", findings: [] }));
	assert.equal(ok.task_status, "done");
	assert.equal(ok.next_task, "T2");
	assert.throws(() => cli(planned(project()), "task-review", "--task", "T1", "--input", jsonFile(root, "tr.json", { verdict: "pass" })), /executing/);
});

test("verify: 모든 작업이 끝나야 하고, 완료 기준마다 증거 명령이 0이어야 통과", () => {
	const root = planned(project());
	cli(root, "execute");
	assert.throws(() => cli(root, "verify", "--input", jsonFile(root, "v.json", { criteria: {} })), /끝나지 않은 작업/);
	cli(root, "task-done", "--task", "T1", "--cmd", "exit 0");
	cli(root, "task-done", "--task", "T2", "--cmd", "exit 0");
	const partial = cli(root, "verify", "--input", jsonFile(root, "v.json", { criteria: { "AC-1": { cmd: "exit 0" }, "AC-2": { cmd: "exit 2" } } }));
	assert.equal(partial.passed, false);
	assert.ok(partial.failed.some(f => f.startsWith("AC-2: 종료 코드 2")));
	assert.ok(partial.failed.some(f => f.startsWith("AC-3: 증거 명령이 없습니다")));
	assert.throws(() => cli(root, "final-review", "--input", jsonFile(root, "fr.json", { verdict: "pass" })), /verify가 통과한 뒤/);
	const all = cli(root, "verify", "--input", jsonFile(root, "v.json", { criteria: { "AC-1": { cmd: "exit 0" }, "AC-2": { cmd: "exit 0" }, "AC-3": { cmd: "echo ok" } } }));
	assert.equal(all.passed, true);
});

test("final-review: pass면 done, revise면 증거를 무효로 돌리고 3회면 stuck", () => {
	const finish = root => {
		cli(root, "execute");
		cli(root, "task-done", "--task", "T1", "--cmd", "exit 0");
		cli(root, "task-done", "--task", "T2", "--cmd", "exit 0");
		cli(root, "verify", "--input", jsonFile(root, "v.json", { criteria: { "AC-1": { cmd: "exit 0" }, "AC-2": { cmd: "exit 0" }, "AC-3": { cmd: "exit 0" } } }));
		return root;
	};
	const done = cli(finish(planned(project())), "final-review", "--input", jsonFile(os.tmpdir(), "fr.json", { verdict: "pass", findings: [] }));
	assert.equal(done.status, "done");

	const root = finish(planned(project()));
	const revise = { verdict: "revise", findings: [{ target: "AC-1", finding: "증거가 약함" }] };
	const r1 = cli(root, "final-review", "--input", jsonFile(root, "fr.json", revise));
	assert.equal(r1.status, "executing");
	assert.throws(() => cli(root, "final-review", "--input", jsonFile(root, "fr.json", revise)), /verify가 통과한 뒤/);
	for (const _ of [2, 3]) {
		cli(root, "verify", "--input", jsonFile(root, "v.json", { criteria: { "AC-1": { cmd: "exit 0" }, "AC-2": { cmd: "exit 0" }, "AC-3": { cmd: "exit 0" } } }));
		cli(root, "final-review", "--input", jsonFile(root, "fr.json", revise));
	}
	assert.equal(readState(root, SID).status, "stuck");
});
