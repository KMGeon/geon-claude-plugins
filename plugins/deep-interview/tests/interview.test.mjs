import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { CORE_IDS, SID, allYes, cli, input, recordRound, say, startWithScope, tempProject } from "./helpers.mjs";
import { readState, sessionDir } from "../skills/deep-interview/scripts/state.mjs";
import { run } from "../skills/deep-interview/scripts/interview.mjs";

test("start: 기준값을 정하고 첫 줄 표시를 돌려준다", () => {
	assert.match(cli(tempProject(), "start", "--topic", "x").marker, /^딥 인터뷰 기준값: 20% \(기본값\)$/);
	assert.match(cli(tempProject(), "start", "--quick").marker, /35% \(--quick\)/);
	assert.match(cli(tempProject(), "start", "--deep").marker, /5% \(--deep\)/);
});

test("start: 진행 중이면 그대로 이어가고, 끝난 인터뷰는 보관 후 새로 시작한다", () => {
	const root = tempProject();
	cli(root, "start", "--topic", "첫번째");
	assert.equal(cli(root, "start", "--topic", "두번째").already_active, true);
	cli(root, "end", "--status", "cancelled");
	const again = cli(root, "start", "--topic", "두번째");
	assert.equal(again.already_active, false);
	assert.equal(again.topic, "두번째");
	assert.ok(fs.readdirSync(sessionDir(root, SID)).some(name => /^state-.+\.json$/.test(name)));
});

test("scope: 시작 후 사용자 답이 기록돼 있어야 한다", () => {
	const root = tempProject();
	cli(root, "start");
	const scope = input({ components: [{ id: "app", name: "앱" }] });
	assert.throws(() => cli(root, "scope", ...scope), /사용자가 범위 확인에 답한 기록이 없습니다/);
	say(root, "맞아요");
	assert.equal(cli(root, "scope", ...scope).scope_confirmed, true);
});

test("scope: 기록이 있는 덩어리는 지울 수 없고 미루기만 된다", () => {
	const root = tempProject();
	startWithScope(root);
	recordRound(root, 1, { g1: "근거" });
	assert.throws(() => cli(root, "scope", ...input({ components: [{ id: "other", name: "다른 것" }] })), /지울 수 없습니다/);
	cli(root, "scope", ...input({ components: [{ id: "app", name: "앱", status: "deferred" }, { id: "other", name: "다른 것" }] }));
});

test("record: 범위 확정 전에는 거부한다", () => {
	const root = tempProject();
	cli(root, "start");
	assert.throws(() => recordRound(root, 1, { g1: "근거" }), /scope부터/);
});

test("record: 코드가 체크리스트로 모호도를 계산한다", () => {
	const root = tempProject();
	startWithScope(root);
	const result = recordRound(root, 1, { ...allYes(["g0", "g1", "g2", "g3", "c1", "c2", "c3"]), s1: false, s2: false, s3: false });
	assert.equal(result.ambiguity_raw, 0.3);
	assert.equal(result.ambiguity, 0.3);
	assert.equal(result.milestone, "막바지");
	assert.equal(result.milestone_changed, "시작 → 막바지");
	assert.deepEqual(result.scores.map(row => row.score), [1, 1, 0]);
	assert.equal(result.next.dimension, "criteria");
});

test("record: 잘못된 입력은 거부한다", () => {
	const root = tempProject();
	startWithScope(root);
	assert.throws(() => recordRound(root, 2, { g1: "근거" }), /다음 라운드 번호는 1/);
	assert.throws(() => recordRound(root, 1, { x1: "근거" }), /쓰지 않는 항목/);
	assert.throws(() => recordRound(root, 1, { g1: "" }), /근거 문자열/);
	assert.throws(() => recordRound(root, 1, { zz: "근거" }), /없는 체크 질문/);
	assert.throws(() => cli(root, "record", ...input({ round: 1, component: "app", dimension: "goal", question: "q", answer: "a", checks: {} })), /체크리스트 답이 checks에/);
});

test("record: 답을 번복하면 그 라운드의 사실이 뒤집히고 최저선이 오른다", () => {
	const root = tempProject();
	startWithScope(root);
	recordRound(root, 1, allYes(CORE_IDS), { facts: [{ id: "f1", statement: "팀장만 승인" }] });
	const retracted = cli(
		root,
		"record",
		...input({ round: 1, component: "app", dimension: "goal", question: "질문 1", answer: "인사팀도 승인", checks: { app: allYes(CORE_IDS) } }),
	);
	assert.equal(retracted.retracted, true);
	assert.equal(retracted.floor, 0.1);
	assert.equal(retracted.ambiguity, 0.1);

	const resolved = recordRound(root, 2, allYes(CORE_IDS), { facts: [{ id: "f2", statement: "팀장 → 인사팀 2단계" }], supersede: [{ old: "f1", new: "f2" }] });
	assert.equal(resolved.floor, 0);
	assert.equal(readState(root, SID).facts.find(fact => fact.id === "f1").status, "superseded");
});

test("record: AI 대리 답이 3번 이어지면 다음 질문은 사람에게", () => {
	const root = tempProject();
	startWithScope(root);
	let result;
	for (const round of [1, 2, 3]) result = recordRound(root, round, { g1: "근거" }, { answer_source: "auto" });
	assert.equal(result.must_ask_user, true);
	assert.ok(result.floor_reasons.some(reason => reason.includes("AI 대리 답")));
});

test("record: 3라운드 동안 모호도가 그대로면 핵심 다시 묻기 신호", () => {
	const root = tempProject();
	startWithScope(root);
	let result;
	for (const round of [1, 2, 3]) result = recordRound(root, round, { g1: "근거" });
	assert.equal(result.rethink_core, true);
});

test("early-exit: 3라운드부터 가능", () => {
	const root = tempProject();
	startWithScope(root);
	recordRound(root, 1, { g1: "근거" });
	assert.throws(() => cli(root, "early-exit"), /3라운드부터/);
	recordRound(root, 2, { g2: "근거" });
	recordRound(root, 3, { g3: "근거" });
	assert.equal(cli(root, "early-exit").early_exit, true);
});

test("end: 정상 종료는 기준 통과 + 마지막 라운드 뒤 사용자 확인이 있어야 한다", () => {
	const root = tempProject();
	startWithScope(root);
	recordRound(root, 1, { g1: "근거" });
	assert.throws(() => cli(root, "end"), /기준값/);
	recordRound(root, 2, allYes(CORE_IDS));
	assert.throws(() => cli(root, "end"), /사용자 답이 없습니다/);
	say(root, "네, 이대로");
	const ended = cli(root, "end", "--spec", ".deep-interview/specs/deep-interview-x.md");
	assert.equal(ended.ended, true);
	assert.equal(ended.status, "done");
	assert.equal(readState(root, SID).spec_path, ".deep-interview/specs/deep-interview-x.md");
});

test("end --status cancelled는 언제나 가능하고 기록은 남는다", () => {
	const root = tempProject();
	startWithScope(root);
	recordRound(root, 1, { g1: "근거" });
	const ended = cli(root, "end", "--status", "cancelled");
	assert.equal(ended.status, "cancelled");
	assert.equal(readState(root, SID).rounds.length, 1);
	assert.ok(fs.existsSync(path.join(sessionDir(root, SID), "answers.jsonl")));
});

test("답 번복: 그 라운드에서 찍은 체크도 되돌려서 기준 통과가 풀린다", () => {
	const root = tempProject();
	startWithScope(root);
	assert.equal(recordRound(root, 1, allYes(CORE_IDS)).threshold_met, true);
	const retracted = cli(root, "record", ...input({ round: 1, component: "app", dimension: "goal", question: "질문 1", answer: "번복", checks: { app: { g1: false } } }));
	assert.equal(retracted.retracted, true);
	assert.equal(retracted.threshold_met, false);
	assert.deepEqual(Object.keys(readState(root, SID).checks.app), ["g1"]);
});

test("--quick/--deep 뒤의 단어를 값으로 삼키지 않고 오류를 낸다", () => {
	const root = tempProject();
	assert.throws(() => cli(root, "start", "--deep", "leave-request", "--topic", "x"), /알 수 없는 인자입니다: leave-request/);
	assert.match(cli(root, "start", "--deep", "--topic", "x").marker, /5% \(--deep\)/);
});

test("잘못된 --type이면 기존 기록을 건드리지 않는다", () => {
	const root = tempProject();
	cli(root, "start", "--topic", "첫번째");
	cli(root, "end", "--status", "cancelled");
	assert.throws(() => cli(root, "start", "--type", "bogus"), /--type/);
	assert.equal(readState(root, SID).topic, "첫번째");
});

test("start는 .deep-interview/.gitignore에 sessions/를 넣는다 (한 번만)", () => {
	const root = tempProject();
	cli(root, "start");
	cli(root, "end", "--status", "cancelled");
	cli(root, "start");
	const ignore = fs.readFileSync(path.join(root, ".deep-interview/.gitignore"), "utf8");
	assert.equal(ignore.split("\n").filter(line => line === "sessions/").length, 1);
});

test("상위 폴더에 .deep-interview가 있어도 git 최상위 폴더를 쓴다", () => {
	const parent = tempProject();
	fs.mkdirSync(path.join(parent, ".deep-interview"));
	const repo = path.join(parent, "repo");
	fs.mkdirSync(repo);
	execFileSync("git", ["init", "-q"], { cwd: repo });
	run(["start", "--session", SID], repo);
	assert.ok(fs.existsSync(path.join(fs.realpathSync(repo), ".deep-interview/sessions", SID, "state.json")));
	assert.equal(fs.existsSync(path.join(parent, ".deep-interview/sessions")), false);
});

test("잘못된 명령과 세션 ID는 거부한다", () => {
	const root = tempProject();
	assert.throws(() => cli(root, "pause"), /알 수 없는 명령/);
	assert.throws(() => run(["start", "--session", "../evil", "--root", root], root), /세션 ID/);
	assert.throws(() => run(["start", "--root", root], root), /--session이 필요합니다/);
});
