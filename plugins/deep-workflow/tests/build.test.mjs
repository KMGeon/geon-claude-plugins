import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkDesign, checkPlan, parseSpec, readState, run, taskOrder, runCommand, tasksForFinding } from "../skills/deep-build/scripts/build.mjs";
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
const started = (root, ...extra) => cli(root, "start", "--spec", ".deep-interview/specs/deep-interview-leave.md", ...extra);
const withDesign = root => {
	started(root);
	fs.mkdirSync(path.join(root, ".deep-interview/designs"), { recursive: true });
	fs.writeFileSync(path.join(root, ".deep-interview/designs/leave.md"), DESIGN_OK);
	return cli(root, "design", "--file", ".deep-interview/designs/leave.md");
};
const task = (id, covers, extra = {}) => ({ id, title: `작업 ${id}`, files: ["src/a.ts"], interface: "f() → x", test: "실패 테스트", test_cmd: "exit 0", covers, depends_on: [], ...extra });
const EVIDENCE = { "AC-1": { cmd: "exit 0", note: "DM 테스트" }, "AC-2": { cmd: "exit 0" }, "AC-3": { cmd: "echo ok" } };
const FULL_PLAN = { tasks: [task("T1", { fixed: ["화면:신청폼"], criteria: ["AC-1", "AC-3"] }), task("T2", { fixed: ["연결:슬랙"], criteria: ["AC-2"] }, { depends_on: ["T1"] })], evidence: EVIDENCE };
const OK_CRITERIA = { "AC-1": "ok", "AC-2": "ok", "AC-3": "ok" };

test("parseSpec: 제목, 결과, 고정 항목, 완료 기준(AC-n)을 뽑는다", () => {
	const spec = parseSpec(SPEC);
	assert.equal(spec.title, "사내 휴가 신청 기능");
	assert.equal(spec.passed, true);
	assert.deepEqual(spec.fixed_items.map(i => i.id), ["화면:신청폼", "연결:슬랙"]);
	assert.deepEqual(spec.criteria.map(c => c.id), ["AC-1", "AC-2", "AC-3"]);
	assert.equal(spec.criteria[2].text, "과거 날짜는 거부된다");
	// 남은 질문의 체크박스는 완료 기준으로 세지 않는다
});

test("parseSpec: 양식 줄을 그대로 둔 결과는 통과가 아니고, 고정 항목은 제목·굵은 글씨 형식도 읽는다", () => {
	assert.equal(parseSpec("# t\n- 결과: 기준 통과 | 기준 미달로 조기 종료\n").passed, false);
	assert.equal(parseSpec("# t\n- 결과: 기준 통과하지 않음\n").passed, false);
	assert.equal(parseSpec("# t\n- 결과: 기준 통과 \n").passed, true);
	assert.equal(parseSpec("# t\n- 결과: 기준 통과 (모호도 15%)\n").passed, true); // 괄호 주석은 허용
	const alt = parseSpec("# t\n### 고정 항목\n- **화면:폼** — 폼\n- `연결:슬랙`: 알림\n## 다 됐다는 기준\n- [ ] a\n**예외 상황**\n- [ ] b\n");
	assert.deepEqual(alt.fixed_items.map(i => i.id), ["화면:폼", "연결:슬랙"]);
	assert.equal(alt.criteria.length, 2); // 완료 기준 절 안의 굵은 소제목은 절을 닫지 않는다
});

test("start: 기준 미달 스펙은 --force 없이 거부한다", () => {
	const root = project(SPEC.replace("기준 통과", "기준 미달로 조기 종료"));
	assert.throws(() => started(root), /조기 종료된 스펙/);
	const forced = started(root, "--force");
	assert.equal(forced.status, "designing");
	assert.equal(readState(root, SID).forced, true);
});

test("start: 완료 기준 ID와 고정 항목을 돌려준다", () => {
	const root = project();
	const r = started(root);
	assert.equal(r.slug, "leave");
	assert.deepEqual(r.fixed_items, ["화면:신청폼", "연결:슬랙"]);
	assert.equal(r.criteria.length, 3);
	assert.equal(r.interview_checked, false);
});

test("start: 인터뷰 상태가 있으면 빠진 고정 항목과 조기 종료를 대조한다 (보관된 상태, 심볼릭 링크 경로, 미룬 덩어리 포함)", () => {
	const root = project();
	const sessionDir = path.join(root, ".deep-interview/sessions/iv-1");
	fs.mkdirSync(sessionDir, { recursive: true });
	const interview = {
		status: "done",
		spec_path: ".deep-interview/specs/deep-interview-leave.md",
		components: [{ id: "apply", status: "active" }, { id: "approve", status: "deferred" }],
		fixed_items: [{ id: "화면:신청폼" }, { id: "연결:슬랙" }, { id: "화면:승인함" }],
		early_exit: false,
		ended_at: "2026-10-27T00:00:00Z",
	};
	fs.writeFileSync(path.join(sessionDir, "state.json"), JSON.stringify(interview));
	assert.throws(() => started(root), /빠진 고정 항목.*화면:승인함/);
	// 미룬 덩어리의 고정 항목은 요구하지 않는다
	fs.writeFileSync(path.join(sessionDir, "state.json"), JSON.stringify({ ...interview, fixed_items: [...interview.fixed_items.slice(0, 2), { id: "화면:승인함", component: "approve" }] }));
	assert.equal(started(root).interview_checked, true);
	// 글에는 "기준 통과"라고 적혀 있어도 인터뷰 상태를 믿는다. 보관된 state-<시각>.json도 찾는다
	fs.renameSync(path.join(sessionDir, "state.json"), path.join(sessionDir, "state-2026.json"));
	fs.writeFileSync(path.join(sessionDir, "state.json"), JSON.stringify({ status: "interviewing", spec_path: null }));
	fs.writeFileSync(path.join(sessionDir, "state-2026.json"), JSON.stringify({ ...interview, fixed_items: interview.fixed_items.slice(0, 2), early_exit: true }));
	assert.throws(() => started(root, "--restart"), /조기 종료된 스펙/);
	// 스펙 경로를 심볼릭 링크(/tmp → /private/tmp)가 섞인 절대 경로로 줘도 찾는다
	fs.writeFileSync(path.join(sessionDir, "state-2026.json"), JSON.stringify({ ...interview, fixed_items: interview.fixed_items.slice(0, 2) }));
	const viaAbs = cli(root, "start", "--spec", path.join(root, ".deep-interview/specs/deep-interview-leave.md"), "--restart");
	assert.equal(viaAbs.interview_checked, true);
	assert.equal(viaAbs.spec_path, ".deep-interview/specs/deep-interview-leave.md");
});

test("start: 인터뷰 기록이 없거나 고정 항목을 못 읽으면 경고를 돌려준다", () => {
	const root = project(SPEC.replace("**고정 항목**", "고정 항목 목록"));
	const r = started(root);
	assert.deepEqual(r.fixed_items, []);
	assert.ok(r.warnings.some(w => /인터뷰 기록을 찾지 못했습니다/.test(w)));
	assert.ok(r.warnings.some(w => /고정 항목을 찾지 못했습니다/.test(w)));
	assert.match(fs.readFileSync(path.join(root, ".deep-interview/.gitignore"), "utf8"), /builds\//); // deep-build만 써도 gitignore
});

test("start: 진행 중인 빌드는 --restart 없이 덮어쓰지 않고, 끝난 빌드는 보관 후 새로 시작하며, 잘못된 입력은 기존 상태를 건드리지 않는다", () => {
	const root = planned(project());
	assert.throws(() => started(root), /진행 중인 빌드.*planned.*--restart/);
	assert.throws(() => started(root, "--restart", "--slug", "BAD"), /slug/);
	assert.equal(readState(root, SID).status, "planned"); // 잘못된 slug는 보관도 덮어쓰기도 하지 않는다
	assert.equal(started(root, "--restart").status, "designing");
	const builds = fs.readdirSync(path.join(root, ".deep-interview/builds"));
	assert.equal(builds.filter(f => f.startsWith(`${SID}-`)).length, 1); // 버린 빌드도 보관된다

	const done = finished(planned(project()));
	cli(done, "final-review", "--input", jsonFile(done, "fr.json", { verdict: "pass", criteria: OK_CRITERIA, findings: [] }));
	assert.equal(readState(done, SID).status, "done");
	assert.equal(started(done).status, "designing"); // done은 --restart 없이도 새로 시작
});

test("checkDesign: 네 절이 모두 있고 내용이나 생략 이유가 있어야 한다", () => {
	assert.deepEqual(checkDesign(DESIGN_OK), []);
	const missing = checkDesign(DESIGN_OK.replace("## ERD\n생략: 이번엔 메모리 저장만 쓴다\n", ""));
	assert.match(missing[0], /ERD.*절이 없습니다/);
	const empty = checkDesign(DESIGN_OK.replace("생략: 이번엔 메모리 저장만 쓴다", "나중에"));
	assert.match(empty[0], /ERD.*Mermaid 블록도.*생략/);
	assert.deepEqual(checkDesign(DESIGN_OK.replace("생략: 이번엔 메모리 저장만 쓴다", "- **생략**: 메모리 저장만")), []); // 목록·굵은 글씨도 받는다
	const blankFence = checkDesign(DESIGN_OK.replace("sequenceDiagram\n  직원->>서버: 신청\n", ""));
	assert.match(blankFence[0], /시퀀스/); // 빈 펜스는 내용이 아니다
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
	const partial = { tasks: [task("T1", { fixed: ["화면:신청폼"], criteria: ["AC-1"] })], evidence: EVIDENCE };
	const problems = checkPlan(partial, spec);
	assert.ok(problems.some(p => p.includes("고정 항목: 연결:슬랙")));
	assert.ok(problems.some(p => p.includes("완료 기준: AC-2, AC-3")));
});

test("checkPlan: 빈 필드, 없는 ID, 잘못된 의존, 빠진 테스트·증거 명령을 잡는다", () => {
	const spec = parseSpec(SPEC);
	const bad = { tasks: [{ id: "T1", title: "x", files: [], covers: { fixed: ["없음"], criteria: ["AC-9"] }, depends_on: ["T7", "T1"] }] };
	const problems = checkPlan(bad, spec);
	for (const needle of ["files", "interface", "test(", "test_cmd", "없는 고정 항목 없음", "없는 완료 기준 AC-9", "T7", "자기 자신", "evidence가 필요"]) {
		assert.ok(problems.some(p => p.includes(needle)), needle);
	}
	const noEvidence = checkPlan({ ...FULL_PLAN, evidence: { "AC-1": { cmd: "x" }, "AC-9": { cmd: "y" } } }, spec);
	assert.ok(noEvidence.some(p => p.includes("evidence.AC-2.cmd")));
	assert.ok(noEvidence.some(p => p.includes("스펙에 없는 완료 기준 AC-9")));
});

test("checkPlan: 의존 순환과 배열이 아닌 covers·depends_on을 거부한다", () => {
	const spec = parseSpec(SPEC);
	const cyclic = { tasks: [task("T1", { fixed: ["화면:신청폼", "연결:슬랙"], criteria: ["AC-1", "AC-2", "AC-3"] }, { depends_on: ["T2"] }), task("T2", { fixed: [], criteria: [] }, { depends_on: ["T1"] })], evidence: EVIDENCE };
	assert.ok(checkPlan(cyclic, spec).some(p => p.includes("순환")));
	const cyclicAndMore = { ...cyclic, tasks: cyclic.tasks.map(t => ({ ...t, test_cmd: "" })) };
	const both = checkPlan(cyclicAndMore, spec);
	assert.ok(both.some(p => p.includes("순환")) && both.some(p => p.includes("test_cmd"))); // 다른 오류와 함께 알려준다
	const stringy = { tasks: [task("T1", { fixed: "화면:신청폼", criteria: ["AC-1"] }, { depends_on: "T1" })], evidence: EVIDENCE };
	const problems = checkPlan(stringy, spec);
	assert.ok(problems.some(p => p.includes("covers.fixed는 배열")));
	assert.ok(problems.some(p => p.includes("depends_on은 배열")));
	assert.ok(!problems.some(p => p.includes("고정 항목 화"))); // 글자 단위로 돌지 않는다
});

test("plan: 통과하면 계획 파일(테스트 명령·증거 명령 포함)을 쓰고 reviewing이 된다", () => {
	const root = project();
	withDesign(root);
	const r = cli(root, "plan", "--input", jsonFile(root, "plan.json", FULL_PLAN));
	assert.equal(r.status, "reviewing");
	assert.equal(r.task_count, 2);
	const md = fs.readFileSync(path.join(root, r.plan_path), "utf8");
	assert.match(md, /## 연결 표/);
	assert.match(md, /\| AC-2 \| 승인하면 남은 일수가 준다 \| T2 \|/);
	assert.match(md, /먼저 실패할 테스트: 실패 테스트/);
	assert.match(md, /테스트 명령: `exit 0`/);
	assert.match(md, /\| AC-1 \| `exit 0` \| DM 테스트 \|/);
});

test("plan: 설계 전에는 거부하고, 연결이 빠지면 거부한다", () => {
	const root = project();
	started(root);
	assert.throws(() => cli(root, "plan", "--input", jsonFile(root, "p.json", FULL_PLAN)), /검토 통과 전/);
	const root2 = project();
	withDesign(root2);
	assert.throws(() => cli(root2, "plan", "--input", jsonFile(root2, "p.json", { tasks: [task("T1", { fixed: ["화면:신청폼"], criteria: ["AC-1"] })], evidence: EVIDENCE })), /담당 작업이 없는/);
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
	assert.throws(() => cli(root, "plan", "--input", jsonFile(root, "plan.json", FULL_PLAN)), /검토 통과 전/);

	const root2 = project();
	withDesign(root2);
	cli(root2, "plan", "--input", jsonFile(root2, "plan.json", FULL_PLAN));
	assert.equal(cli(root2, "review", "--input", jsonFile(root2, "rv.json", { verdict: "pass", findings: [], summary: "좋음" })).status, "planned");
});

test("review: revise에는 findings가 있어야 하고, blocker가 있으면 pass일 수 없고, reviewing 상태에서만 기록된다", () => {
	const root = project();
	withDesign(root);
	assert.throws(() => cli(root, "review", "--input", jsonFile(root, "rv.json", { verdict: "pass" })), /reviewing 상태/);
	cli(root, "plan", "--input", jsonFile(root, "plan.json", FULL_PLAN));
	assert.throws(() => cli(root, "review", "--input", jsonFile(root, "rv.json", { verdict: "revise", findings: [] })), /findings가 하나 이상/);
	assert.throws(() => cli(root, "review", "--input", jsonFile(root, "rv.json", { verdict: "revise", findings: [{}] })), /target과 finding/);
	assert.throws(() => cli(root, "review", "--input", jsonFile(root, "rv.json", { verdict: "pass", findings: [{ target: "T1", severity: "blocker", finding: "x" }] })), /blocker.*revise/);
});

test("design: 검토 통과 뒤(planned) 설계를 다시 등록하면 다시 검토로 가고, 등록 뒤 바뀐 설계로는 구현을 시작할 수 없다", () => {
	const root = planned(project());
	fs.appendFileSync(path.join(root, ".deep-interview/designs/leave.md"), "\n## 설계 메모\n바뀜\n");
	assert.throws(() => cli(root, "execute"), /등록한 뒤에 바뀌었습니다/);
	assert.equal(cli(root, "design", "--file", ".deep-interview/designs/leave.md").status, "reviewing");
	cli(root, "review", "--input", jsonFile(root, "rv.json", { verdict: "pass", findings: [] }));
	assert.equal(cli(root, "execute").status, "executing");
});

test("revise 뒤 설계만 다시 등록해도 reviewing으로 돌아가고, reviewing에서도 설계·계획을 다시 등록할 수 있다", () => {
	const root = project();
	withDesign(root);
	cli(root, "plan", "--input", jsonFile(root, "plan.json", FULL_PLAN));
	cli(root, "review", "--input", jsonFile(root, "rv.json", { verdict: "revise", findings: [{ target: "설계/시퀀스", finding: "흐름 빠짐" }] }));
	assert.equal(cli(root, "design", "--file", ".deep-interview/designs/leave.md").status, "reviewing");
	assert.equal(cli(root, "design", "--file", ".deep-interview/designs/leave.md").status, "reviewing"); // 검토 전 오타 수정
	assert.equal(cli(root, "plan", "--input", jsonFile(root, "plan.json", FULL_PLAN)).status, "reviewing");
	assert.equal(cli(root, "review", "--input", jsonFile(root, "rv.json", { verdict: "pass", findings: [] })).status, "planned");
});

test("가드 훅: sessions/·plans/·builds/는 직접 쓸 수 없고 designs/는 된다", () => {
	const root = project();
	const call = file => evaluate({ tool_name: "Write", cwd: root, tool_input: { file_path: path.join(root, file) } });
	assert.match(call(".deep-interview/plans/leave.md"), /직접 쓸 수 없습니다/);
	assert.match(call(".deep-interview/builds/x.json"), /직접 쓸 수 없습니다/);
	assert.match(call(".deep-interview/sessions/s/state.json"), /직접 고칠 수 없습니다/);
	assert.equal(call(".deep-interview/designs/leave.md"), null);
	assert.equal(call("src/app.ts"), null);
	assert.equal(evaluate({ tool_name: "Bash", cwd: root, tool_input: { command: "ls" } }), null);
});

// ---------------------------------------------------------------------------
// 2단계: 구현 → 완료 판정
// ---------------------------------------------------------------------------

/** 검토를 통과해 planned 상태인 프로젝트. */
function planned(root, plan = FULL_PLAN) {
	withDesign(root);
	cli(root, "plan", "--input", jsonFile(root, "plan.json", plan));
	cli(root, "review", "--input", jsonFile(root, "rv.json", { verdict: "pass", findings: [] }));
	return root;
}
/** 모든 작업과 verify까지 끝난 프로젝트. */
function finished(root) {
	cli(root, "execute");
	cli(root, "task-done", "--task", "T1");
	cli(root, "task-done", "--task", "T2");
	assert.equal(cli(root, "verify").passed, true);
	return root;
}
const BIG_PLAN = { tasks: [
	task("T1", { fixed: ["화면:신청폼"], criteria: ["AC-1"] }),
	task("T2", { fixed: [], criteria: ["AC-2"] }, { depends_on: ["T1"] }),
	task("T3", { fixed: ["연결:슬랙"], criteria: [] }),
	task("T4", { fixed: [], criteria: ["AC-3"] }, { depends_on: ["T2", "T3"] }),
], evidence: EVIDENCE };

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

test("task-done: 계획에 고정된 테스트 명령을 코드가 실행하고, --cmd는 받지 않으며, 순서를 어기면 거부한다", () => {
	const plan = { ...FULL_PLAN, tasks: [task("T1", { fixed: ["화면:신청폼"], criteria: ["AC-1", "AC-3"] }, { test_cmd: "test -f t1.ok" }), FULL_PLAN.tasks[1]] };
	const root = planned(project(), plan);
	cli(root, "execute");
	assert.throws(() => cli(root, "task-done", "--task", "T2"), /의존 작업이 아직 끝나지 않았습니다. 지금 할 수 있는 작업: T1/);
	assert.throws(() => cli(root, "task-done", "--task", "T1", "--cmd", "exit 0"), /--cmd를 받지 않습니다/);
	const fail1 = cli(root, "task-done", "--task", "T1"); // 아직 구현 전: 테스트가 실패한다
	assert.equal(fail1.passed, false);
	assert.equal(fail1.attempts_left, 2);
	fs.writeFileSync(path.join(root, "t1.ok"), ""); // 구현
	const ok = cli(root, "task-done", "--task", "T1");
	assert.equal(ok.passed, true);
	assert.equal(ok.task_status, "done");
	assert.equal(ok.next_task, "T2");
	assert.throws(() => cli(root, "task-done", "--task", "T1"), /이미 끝난 작업.*reopen/);
});

test("task-done: 3회 실패하면 전체가 stuck이 되고 끝난·남은 작업을 돌려준다", () => {
	const plan = { ...FULL_PLAN, tasks: [task("T1", { fixed: ["화면:신청폼"], criteria: ["AC-1", "AC-3"] }, { test_cmd: "exit 1" }), FULL_PLAN.tasks[1]] };
	const root = planned(project(), plan);
	cli(root, "execute");
	let r;
	for (let i = 0; i < 3; i += 1) r = cli(root, "task-done", "--task", "T1");
	assert.equal(r.status, "stuck");
	assert.match(r.failed_reason, /T1: 3회/);
	assert.deepEqual(r.remaining, ["T1", "T2"]);
	assert.throws(() => cli(root, "task-done", "--task", "T1"), /executing/);
});

test("agents 방식: 테스트 통과 뒤 리뷰 pass여야 done, revise는 실패로 센다, 리뷰 대기 작업은 ready에서 빠진다", () => {
	const root = planned(project(), BIG_PLAN);
	cli(root, "execute");
	assert.deepEqual(cli(root, "status").ready_tasks, ["T1", "T3"]); // 독립 작업은 병렬 가능
	const t = cli(root, "task-done", "--task", "T1");
	assert.equal(t.task_status, "awaiting_review");
	assert.deepEqual(t.ready_tasks, ["T3"]);
	assert.deepEqual(t.awaiting_review_tasks, ["T1"]);
	assert.throws(() => cli(root, "task-done", "--task", "T1"), /리뷰 대기 중/);
	assert.throws(() => cli(root, "task-done", "--task", "T2"), /의존 작업이 아직 끝나지 않았습니다/);
	assert.equal(cli(root, "task-done", "--task", "T3").task_status, "awaiting_review"); // T1 리뷰 전에도 T3는 가능
	const rv = cli(root, "task-review", "--task", "T1", "--input", jsonFile(root, "tr.json", { verdict: "revise", findings: [{ target: "T1", finding: "범위 초과" }] }));
	assert.equal(rv.task_status, "failed");
	assert.equal(rv.attempts_left, 2);
	cli(root, "task-done", "--task", "T1");
	const ok = cli(root, "task-review", "--task", "T1", "--input", jsonFile(root, "tr.json", { verdict: "pass", findings: [] }));
	assert.equal(ok.task_status, "done");
	assert.equal(ok.next_task, "T2");
	assert.throws(() => cli(planned(project()), "task-review", "--task", "T1", "--input", jsonFile(root, "tr.json", { verdict: "pass" })), /executing/);
});

test("verify: 모든 작업이 끝나야 하고, 계획의 증거 명령이 전부 0이어야 통과하며, --input은 받지 않는다", () => {
	const plan = { ...FULL_PLAN, evidence: { ...EVIDENCE, "AC-2": { cmd: "test -f ac2.ok" } } };
	const root = planned(project(), plan);
	cli(root, "execute");
	assert.throws(() => cli(root, "verify"), /끝나지 않은 작업/);
	cli(root, "task-done", "--task", "T1");
	cli(root, "task-done", "--task", "T2");
	assert.throws(() => cli(root, "verify", "--input", "{}"), /--input을 받지 않습니다/);
	const partial = cli(root, "verify");
	assert.equal(partial.passed, false);
	assert.ok(partial.failed.some(f => f.startsWith("AC-2: 종료 코드 1")));
	assert.throws(() => cli(root, "final-review", "--input", jsonFile(root, "fr.json", { verdict: "pass", criteria: OK_CRITERIA })), /verify가 통과한 뒤/);
	fs.writeFileSync(path.join(root, "ac2.ok"), "");
	assert.equal(cli(root, "verify").passed, true);
});

test("reopen: 끝난 작업을 다시 열면 의존 작업도 같이 열리고, 시도 횟수는 0부터, 증거는 무효", () => {
	const plan = { ...FULL_PLAN, tasks: [task("T1", { fixed: ["화면:신청폼"], criteria: ["AC-1", "AC-3"] }, { test_cmd: "test -f t1.ok" }), FULL_PLAN.tasks[1]] };
	const root = planned(project(), plan);
	cli(root, "execute");
	cli(root, "task-done", "--task", "T1"); // 실패 1회
	fs.writeFileSync(path.join(root, "t1.ok"), "");
	cli(root, "task-done", "--task", "T1");
	cli(root, "task-done", "--task", "T2");
	assert.equal(cli(root, "verify").passed, true);
	assert.throws(() => cli(root, "reopen", "--task", "T9"), /작업 id/);
	const r = cli(root, "reopen", "--task", "T1");
	assert.deepEqual(r.reopened_tasks, ["T1", "T2"]); // T2는 T1에 의존
	assert.deepEqual(r.ready_tasks, ["T1"]);
	const t1 = readState(root, SID).execution.tasks.T1;
	assert.equal(t1.attempts, 0);
	assert.equal(t1.total_attempts, 1);
	assert.throws(() => cli(root, "reopen", "--task", "T1"), /끝난 작업이 아닙니다/);
	assert.throws(() => cli(root, "verify"), /끝나지 않은 작업이 있습니다: T1, T2/);
	assert.throws(() => cli(root, "final-review", "--input", jsonFile(root, "fr.json", { verdict: "pass", criteria: OK_CRITERIA })), /verify가 통과한 뒤/);
	assert.equal(cli(root, "task-done", "--task", "T1").task_status, "done");
	assert.equal(cli(root, "task-done", "--task", "T2").task_status, "done");
	assert.equal(cli(root, "verify").passed, true);
});

test("amend: 구현 중에 테스트·증거 명령만 고칠 수 있고, 고친 작업은 다시 열리며, 계획 파일도 다시 쓴다", () => {
	const root = finished(planned(project()));
	assert.throws(() => cli(root, "amend", "--input", jsonFile(root, "am.json", {})), /고칠 것이 없습니다/);
	assert.throws(() => cli(root, "amend", "--input", jsonFile(root, "am.json", { tasks: { T9: { test_cmd: "x" } } })), /계획에 없는 작업/);
	assert.throws(() => cli(root, "amend", "--input", jsonFile(root, "am.json", { tasks: { T1: { title: "x" } } })), /test_cmd/);
	assert.throws(() => cli(root, "amend", "--input", jsonFile(root, "am.json", { evidence: { "AC-9": { cmd: "x" } } })), /스펙에 없는 완료 기준/);
	const r = cli(root, "amend", "--input", jsonFile(root, "am.json", { tasks: { T2: { test_cmd: "test -f t2.ok" } }, evidence: { "AC-2": { cmd: "test -f ac2.ok", note: "고침" } } }));
	assert.deepEqual(r.reopened_tasks, ["T2"]);
	assert.equal(r.changes.length, 2);
	const state = readState(root, SID);
	assert.equal(state.plan.tasks[1].test_cmd, "test -f t2.ok");
	assert.equal(state.plan.evidence["AC-2"].cmd, "test -f ac2.ok");
	assert.equal(state.amendments.length, 1);
	assert.match(fs.readFileSync(path.join(root, state.plan_path), "utf8"), /test -f t2\.ok/);
	assert.equal(cli(root, "task-done", "--task", "T2").passed, false);
	fs.writeFileSync(path.join(root, "t2.ok"), "");
	fs.writeFileSync(path.join(root, "ac2.ok"), "");
	assert.equal(cli(root, "task-done", "--task", "T2").task_status, "done");
	assert.equal(cli(root, "verify").passed, true);
});

test("verify: --criterion으로 하나씩 실행해 쌓을 수 있고, 실제 실패가 3회면 stuck", () => {
	const plan = { ...FULL_PLAN, evidence: { ...EVIDENCE, "AC-2": { cmd: "exit 1" } } };
	const root = planned(project(), plan);
	cli(root, "execute");
	cli(root, "task-done", "--task", "T1");
	cli(root, "task-done", "--task", "T2");
	assert.throws(() => cli(root, "verify", "--criterion", "AC-9"), /완료 기준 id/);
	const one = cli(root, "verify", "--criterion", "AC-1");
	assert.equal(one.passed, false);
	assert.ok(one.failed.every(f => f.endsWith("아직 실행하지 않음")));
	assert.equal(one.verify_failures_left, 3); // 아직 실행 안 한 것은 실패로 세지 않는다
	const two = cli(root, "verify", "--criterion", "AC-2");
	assert.equal(two.verify_failures_left, 2);
	cli(root, "verify");
	const third = cli(root, "verify");
	assert.equal(third.status, "stuck");
	assert.match(third.failed_reason, /verify 3회 실패/);
});

test("tasksForFinding: 작업 id, AC id(covers), 파일 경로(files, 줄 번호 무시), task 필드로 작업을 찾는다", () => {
	const plan = { tasks: [task("T1", { fixed: [], criteria: ["AC-1"] }, { files: ["src/leave/request.ts"] }), task("T2", { fixed: [], criteria: ["AC-2"] }, { files: ["src/notify.ts"] })] };
	assert.deepEqual(tasksForFinding(plan, { target: "T2" }), ["T2"]);
	assert.deepEqual(tasksForFinding(plan, { target: "AC-1" }), ["T1"]);
	assert.deepEqual(tasksForFinding(plan, { target: "src/notify.ts:42" }), ["T2"]);
	assert.deepEqual(tasksForFinding(plan, { target: "leave/request.ts" }), ["T1"]);
	assert.deepEqual(tasksForFinding(plan, { target: "README.md", task: "T1" }), ["T1"]);
	assert.deepEqual(tasksForFinding(plan, { target: "어딘가" }), []);
});

test("final-review: AC별 판정이 모두 있어야 하고, fail이나 blocker가 있으면 pass일 수 없고, weak는 그 AC를 가리키는 지적이 있어야 pass", () => {
	const root = finished(planned(project()));
	const fr = input => cli(root, "final-review", "--input", jsonFile(root, "fr.json", input));
	assert.throws(() => fr({ verdict: "pass", findings: [] }), /criteria가 필요합니다/);
	assert.throws(() => fr({ verdict: "pass", criteria: { "AC-1": "ok" }, findings: [] }), /criteria.AC-2/);
	assert.throws(() => fr({ verdict: "pass", criteria: { ...OK_CRITERIA, "AC-2": "fail" }, findings: [] }), /fail\(AC-2\).*revise/);
	assert.throws(() => fr({ verdict: "pass", criteria: OK_CRITERIA, findings: [{ target: "AC-1", severity: "blocker", finding: "x" }] }), /blocker.*revise/);
	assert.throws(() => fr({ verdict: "pass", criteria: { ...OK_CRITERIA, "AC-2": "weak" }, findings: [] }), /weak.*AC-2/);
	assert.throws(() => fr({ verdict: "revise", criteria: OK_CRITERIA, findings: [{}] }), /target과 finding/);
	const done = fr({ verdict: "pass", criteria: { ...OK_CRITERIA, "AC-2": "weak" }, findings: [{ target: "AC-2", severity: "minor", finding: "일수 경계값 테스트 없음" }] });
	assert.equal(done.status, "done");
	assert.deepEqual(readState(root, SID).execution.final_reviews[0].criteria, { ...OK_CRITERIA, "AC-2": "weak" });
});

test("final-review: revise면 blocker 지적이 가리키는 작업(AC·파일 포함)을 의존 작업까지 다시 열고 증거를 무효로 돌리며, 3회면 stuck", () => {
	const root = finished(planned(project()));
	// AC-2를 가리키는 blocker → AC-2 담당 T2가 열린다. minor는 열지 않는다
	const r1 = cli(root, "final-review", "--input", jsonFile(root, "fr.json", { verdict: "revise", criteria: { ...OK_CRITERIA, "AC-2": "fail" }, findings: [{ target: "AC-2", severity: "blocker", finding: "일수가 안 줄어듦" }, { target: "T1", severity: "minor", finding: "이름" }] }));
	assert.equal(r1.status, "executing");
	assert.deepEqual(r1.reopened_tasks, ["T2"]);
	assert.equal(readState(root, SID).execution.tasks.T1.status, "done");
	assert.throws(() => cli(root, "final-review", "--input", jsonFile(root, "fr.json", { verdict: "pass", criteria: OK_CRITERIA })), /verify가 통과한 뒤/);
	assert.throws(() => cli(root, "verify"), /끝나지 않은 작업이 있습니다: T2/);
	cli(root, "task-done", "--task", "T2"); // 고친 뒤 다시 통과
	assert.equal(cli(root, "verify").passed, true);
	// 파일을 가리키는 blocker → 그 파일을 고치는 작업(T1)과 의존 작업(T2)이 열린다
	const r2 = cli(root, "final-review", "--input", jsonFile(root, "fr.json", { verdict: "revise", criteria: OK_CRITERIA, findings: [{ target: "src/a.ts:10", severity: "blocker", finding: "예외 처리 없음" }] }));
	assert.deepEqual(r2.reopened_tasks, ["T1", "T2"]);
	cli(root, "task-done", "--task", "T1");
	cli(root, "task-done", "--task", "T2");
	assert.equal(cli(root, "verify").passed, true);
	// 작업을 못 찾는 지적은 verify부터 다시. 3회째 revise면 stuck
	const r3 = cli(root, "final-review", "--input", jsonFile(root, "fr.json", { verdict: "revise", criteria: OK_CRITERIA, findings: [{ target: "어딘가", severity: "blocker", finding: "x" }] }));
	assert.deepEqual(r3.reopened_tasks, []);
	assert.equal(readState(root, SID).status, "stuck");
});
