import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { SID, choose, cli, inferred, input, note, readyInterview, said, say, sign, start, tempProject } from "./helpers.mjs";
import { readState, sessionDir } from "../skills/deep-interview/scripts/state.mjs";
import { run } from "../skills/deep-interview/scripts/interview.mjs";
import { parseSpec } from "../skills/deep-build/scripts/build.mjs";
import { sectionBullets } from "../skills/deep-goal/scripts/goal.mjs";

test("start: 조서 첫 줄을 돌려주고, 진행 중이면 이어가고, 끝난 인터뷰는 보관 후 새로 시작한다", () => {
	const root = tempProject();
	assert.equal(start(root).marker, "조서 | 확정 0 · 잠정 0 · 모순 0 · 구멍 0");
	assert.equal(cli(root, "start", "--topic", "두번째").already_active, true);
	cli(root, "end", "--status", "cancelled");
	const again = cli(root, "start", "--topic", "두번째");
	assert.equal(again.already_active, false);
	assert.equal(again.topic, "두번째");
	assert.ok(fs.readdirSync(sessionDir(root, SID)).some(name => /^state-.+\.json$/.test(name)));
});

test("note: 사용자 말은 확정, 형사 정리·코드·대신 정한 것은 잠정. 숫자 넷은 코드가 센다", () => {
	const root = tempProject();
	start(root);
	fs.writeFileSync(path.join(root, "auth.ts"), "");
	const r = note(root, 1, {
		statements: [said("직원이 신청", "what"), inferred("팀장이 승인", "what"), { text: "로그인은 auth.ts", area: "code", source: "code", evidence: "auth.ts" }, { text: "하루 단위", area: "keep", source: "auto" }],
		gaps: [{ text: "반차 포함?", area: "avoid", cost: "high", why_cost: "화면이 달라짐" }, { text: "끝 기준", area: "done" }],
	});
	assert.deepEqual(r.counts, { confirmed: 1, tentative: 3, disputed: 0, gaps: 2 });
	assert.deepEqual(r.changed.statements, ["s1", "s2", "s3", "s4"]);
	assert.equal(r.open_gaps[0].text, "반차 포함?"); // 비싼 구멍이 먼저
	assert.equal(r.next.kind, "gap");
	assert.equal(r.ready_for_review, false);
});

test("note: 코드 출처 진술은 실제로 있는 경로가 근거에 있어야 한다", () => {
	const root = tempProject();
	start(root);
	assert.throws(() => note(root, 1, { statements: [{ text: "x", area: "code", source: "code", evidence: "없는/파일.ts" }] }), /실제로 있는 파일 경로/);
	assert.throws(() => note(root, 1, { statements: [{ text: "x", area: "code", source: "code" }] }), /실제로 있는 파일 경로/);
});

test("note: 잠정 진술을 두 번 일관되게 말하면 확정, 대신 정한 것은 서명 전엔 확정하지 않는다", () => {
	const root = tempProject();
	start(root);
	note(root, 1, { statements: [inferred("팀장이 승인", "what", { id: "s1" }), { id: "s2", text: "하루 단위", area: "keep", source: "auto" }] });
	const r = note(root, 2, { statements: [inferred("팀장이  승인", "what", { id: "s1" }), { id: "s2", text: "하루 단위", area: "keep", source: "auto" }] });
	assert.deepEqual(r.changed.promoted, ["s1"]);
	assert.deepEqual(r.counts, { confirmed: 1, tentative: 1, disputed: 0, gaps: 0 });
	// 잠정 진술의 말이 바뀌면 바꾼 말로 다시 잠정. 확정 진술은 바꿀 수 없다.
	note(root, 3, { statements: [{ id: "s2", text: "시간 단위", area: "keep", source: "auto" }] });
	assert.equal(readState(root, SID).statements[1].history[0].text, "하루 단위");
	assert.throws(() => note(root, 4, { statements: [{ id: "s1", text: "인사팀이 승인", area: "what" }] }), /확정 진술의 내용은 바꿀 수 없습니다/);
});

test("note: 턴은 순서대로만, 같은 턴은 다시 적을 수 없다", () => {
	const root = tempProject();
	start(root);
	assert.throws(() => note(root, 2), /다음 턴 번호는 1입니다/);
	note(root, 1);
	assert.throws(() => note(root, 1), /다음 턴 번호는 2입니다/);
	assert.throws(() => cli(root, "note", ...input({ turn: 2, question: "q" })), /question과 answer가 필요합니다/);
	assert.throws(() => cli(root, "note", ...input({ turn: 0 })), /처음 한 번만/);
});

test("note: turn 0은 첫 조서(코드·첫 말 정리)이고 질문·답이 없어도 된다. 낭독에는 사용자 턴이 있어야 한다", () => {
	const root = tempProject();
	start(root);
	const r = cli(root, "note", ...input({ turn: 0, statements: [said("메일이라 누락", "why"), said("웹 신청", "what"), said("로그인 그대로", "keep"), said("목록에 보임", "done")] }));
	assert.equal(r.counts.confirmed, 4);
	assert.equal(r.ready_for_review, false);
	assert.match(cli(root, "board").readiness_blocker, /기록된 턴이 없습니다/);
	assert.equal(note(root, 1).ready_for_review, true);
});

test("note: 잘못된 입력은 거부한다", () => {
	const root = tempProject();
	start(root);
	assert.throws(() => note(root, 1, { statements: [{ text: "x", area: "bogus" }] }), /area는/);
	assert.throws(() => note(root, 1, { statements: [{ text: "x", area: "what", source: "bogus" }] }), /source는/);
	assert.throws(() => note(root, 1, { statements: [said("x", "what", { fixed: "no colon" })] }), /종류:이름/);
	assert.throws(() => note(root, 1, { statements: [said("x", "what", { component: "nope" })] }), /component는 덩어리 id/);
	assert.throws(() => note(root, 1, { gaps: [{ text: "x", area: "what", cost: "huge" }] }), /cost는/);
	assert.throws(() => note(root, 1, { close: [{ gap: "g9", by: ["s1"] }] }), /없는 구멍/);
	assert.throws(() => note(root, 1, { answer_source: "robot" }), /answer_source/);
	assert.throws(() => note(root, 1, { statements: [said("a", "what", { fixed: "화면:폼" }), said("b", "what", { fixed: "화면:폼" })] }), /고정 항목 ID가 겹칩니다/);
	assert.equal(readState(root, SID).turns.length, 0); // 거부된 턴은 하나도 안 남는다
});

test("note: 구멍은 진술로 닫고, 닫은 뒤 숫자가 줄어든다", () => {
	const root = tempProject();
	start(root);
	note(root, 1, { gaps: [{ id: "g1", text: "반차?", area: "avoid", cost: "high" }] });
	assert.throws(() => note(root, 2, { close: [{ gap: "g1" }] }), /by에 진술 id/);
	assert.throws(() => note(root, 2, { close: [{ gap: "g1", by: ["s9"] }] }), /없는 진술/);
	const r = note(root, 2, { statements: [said("반차는 안 한다", "avoid", { id: "s1" })], close: [{ gap: "g1", by: ["s1"] }] });
	assert.deepEqual(r.changed.gaps_closed, ["g1"]);
	assert.equal(r.counts.gaps, 0);
	assert.throws(() => note(root, 3, { close: [{ gap: "g1", by: ["s1"] }] }), /이미 닫힌 구멍/);
});

test("note: 모순은 그 턴에 정리해야 하고, 정리할 때까지 다른 질문으로 못 넘어간다", () => {
	const root = tempProject();
	start(root);
	note(root, 1, { statements: [said("기존 USER.md는 삭제", "keep", { id: "s1" })] });
	const d = note(root, 2, { disputes: [{ statement: "s1", claim: "USER.md는 옮긴다" }] });
	assert.deepEqual(d.counts, { confirmed: 0, tentative: 0, disputed: 1, gaps: 0 });
	assert.equal(d.next.kind, "dispute");
	assert.throws(() => note(root, 3, { statements: [said("다른 말", "what")] }), /모순이 남아 있습니다/);
	assert.throws(() => note(root, 3, { resolve: [{ statement: "s1", keep: "both" }] }), /keep은 old/);
	// 지금 말이 맞다 → 옛 진술은 철회(대체), 새 진술은 사용자 말로 확정
	const r = note(root, 3, { resolve: [{ statement: "s1", keep: "new" }] });
	assert.deepEqual(r.changed.resolved, [{ statement: "s1", keep: "new", replacement: "s2" }]);
	const state = readState(root, SID);
	assert.equal(state.statements[0].status, "retracted");
	assert.equal(state.statements[0].superseded_by, "s2");
	assert.equal(state.statements[1].text, "USER.md는 옮긴다");
	assert.equal(state.statements[1].status, "confirmed");
	assert.deepEqual(r.counts, { confirmed: 1, tentative: 0, disputed: 0, gaps: 0 });
});

test("note: 원래 말이 맞다고 하면 그 진술이 확정으로 돌아온다", () => {
	const root = tempProject();
	start(root);
	note(root, 1, { statements: [inferred("팀장이 승인", "what", { id: "s1" })] });
	note(root, 2, { disputes: [{ statement: "s1", claim: "인사팀이 승인" }] });
	note(root, 3, { resolve: [{ statement: "s1", keep: "old" }] });
	const s1 = readState(root, SID).statements[0];
	assert.equal(s1.status, "confirmed");
	assert.equal(s1.resolved[0].claim, "인사팀이 승인");
});

test("note: reopen은 진술을 철회하고 비싼 구멍으로 되돌리고, retract는 철회만 한다", () => {
	const root = tempProject();
	start(root);
	note(root, 1, { statements: [said("a", "what", { id: "s1" }), said("b", "what", { id: "s2" })] });
	const r = note(root, 2, { reopen: ["s1"], retract: ["s2"] });
	assert.deepEqual(r.counts, { confirmed: 0, tentative: 0, disputed: 0, gaps: 1 });
	assert.equal(r.open_gaps[0].cost, "high");
	assert.equal(readState(root, SID).gaps[0].from_statement, "s1");
	assert.throws(() => note(root, 3, { retract: ["s2"] }), /이미 철회된 진술/);
	assert.throws(() => note(root, 3, { statements: [{ id: "s2", text: "b", area: "what" }] }), /철회된 진술은 다시 쓸 수 없습니다/);
});

test("note: 형사가 대신 답한 턴이 3번 이어지면 다음 질문은 사람에게", () => {
	const root = tempProject();
	start(root);
	for (const turn of [1, 2]) assert.equal(note(root, turn, { answer_source: "auto" }).must_ask_user, false);
	assert.equal(note(root, 3, { answer_source: "auto" }).must_ask_user, true);
});

test("note: 덩어리는 라벨이고 진술·구멍에 붙일 수 있다", () => {
	const root = tempProject();
	start(root);
	const r = note(root, 1, { components: [{ id: "apply", name: "신청" }, { id: "approve", name: "승인", status: "deferred", reason: "다음 분기" }], statements: [said("x", "what", { component: "apply" })], gaps: [{ text: "y", area: "done", component: "approve" }] });
	assert.equal(r.counts.gaps, 1);
	assert.equal(cli(root, "board").components.length, 2);
	assert.throws(() => note(root, 2, { components: [{ id: "bad id" }] }), /공백 없는/);
});

test("review: 낭독 조건이 맞아야 부를 수 있고, 항목이 비면 막힌다", () => {
	const root = tempProject();
	start(root);
	note(root, 1, { statements: [said("왜", "why"), said("무엇", "what")] });
	assert.throws(() => cli(root, "review", ...input({})), /진술이 없는 항목이 있습니다: 지킬 조건·하지 않을 것/);
	assert.equal(note(root, 2, { statements: [inferred("지킬 것", "keep")] }).coverage.tentative_only[0], "지킬 조건·하지 않을 것");
	assert.throws(() => cli(root, "review", ...input({})), /완료 기준/);
});

test("review: 두 번째 형사가 구멍을 찾으면 서명 못 하고, 못 찾으면 서명할 수 있다", () => {
	const root = readyInterview(tempProject());
	const found = cli(root, "review", ...input({ new_gaps: [{ text: "취소는?", area: "done", cost: "mid" }], note: "삐딱하게" }));
	assert.equal(found.ready_to_sign, false);
	assert.equal(found.counts.gaps, 1);
	sign(root);
	assert.throws(() => cli(root, "sign", "--slug", "leave", "--summary", "요약"), /구멍이 1개 남아 있습니다/);
	note(root, 4, { statements: [said("취소는 대기 상태에서만", "done", { id: "s6" })], close: [{ gap: "g1", by: ["s6"] }] });
	assert.throws(() => cli(root, "sign", "--slug", "leave", "--summary", "요약"), /두 번째 형사 검토\(review\)가 없습니다/);
	assert.equal(cli(root, "review", ...input({})).ready_to_sign, true);
	assert.deepEqual(cli(root, "board").changed_since_review.statements, []);
});

test("sign: 마지막 턴·검토 뒤에 사용자가 선택지 창에서 '서명'을 골라야 한다", () => {
	const root = readyInterview(tempProject());
	cli(root, "review", ...input({}));
	const trySign = () => cli(root, "sign", "--slug", "leave", "--summary", "직원이 웹에서 연차를 신청한다.");
	assert.throws(trySign, /"서명"을 고른 기록이 없습니다/);
	say(root, "서명");
	assert.throws(trySign, /"서명"을 고른 기록이 없습니다/);
	choose(root, "조서", "이 줄 아님");
	assert.throws(trySign, /"서명"을 고른 기록이 없습니다/);
	sign(root);
	say(root, "아 잠깐, 하나 더"); // 서명 뒤에 다른 말을 하면 다시 받아야 한다
	assert.throws(trySign, /"서명"을 고른 기록이 없습니다/);
	sign(root);
	assert.throws(() => cli(root, "sign", "--slug", "Leave Request", "--summary", "x"), /--slug/);
	assert.throws(() => cli(root, "sign", "--slug", "leave"), /--summary/);
	const r = trySign();
	assert.equal(r.spec_path, ".deep-interview/specs/deep-interview-leave.md");
	assert.equal(r.status, "done");
	assert.equal(r.early_exit, false);
	assert.deepEqual(r.fixed_items, ["화면:신청폼"]);
	assert.equal(r.criteria, 1);
});

test("sign: 코드가 쓴 스펙을 deep-build·deep-goal이 그대로 읽는다. 잠정은 서명으로 확정된다", () => {
	const root = readyInterview(tempProject());
	note(root, 4, { statements: [inferred("승인은 팀장 1단계", "what", { id: "s6", fixed: "흐름:승인" }), { text: "글자 한도 2,000", area: "keep", source: "auto", id: "s7" }] });
	cli(root, "review", ...input({}));
	sign(root);
	const r = cli(root, "sign", "--slug", "leave", "--summary", "직원이 웹에서 연차를 신청하고 팀장이 승인한다.");
	assert.deepEqual(r.signed_statements, ["s6", "s7"]);
	const markdown = fs.readFileSync(path.join(root, r.spec_path), "utf8");
	const spec = parseSpec(markdown);
	assert.equal(spec.title, "휴가 신청");
	assert.equal(spec.passed, true);
	assert.deepEqual(spec.fixed_items, [{ id: "화면:신청폼", statement: "직원이 웹에서 연차를 신청한다" }, { id: "흐름:승인", statement: "승인은 팀장 1단계" }]);
	assert.deepEqual(spec.criteria, [{ id: "AC-1", text: "신청하면 목록에 '대기'로 보인다" }]);
	assert.deepEqual(sectionBullets(markdown, "지킬 조건"), ["기존 로그인 그대로 쓴다", "글자 한도 2,000"]);
	assert.deepEqual(sectionBullets(markdown, "하지 않을 것"), ["반차는 이번에 안 한다"]);
	assert.match(markdown, /- 형사가 대신 정한 진술: 1개/);
	assert.match(markdown, /\| s7 \| 지킬 조건 \| 글자 한도 2,000 \| 형사가 대신 정함 \| 서명 확정 \| 4 \|/);
	assert.match(markdown, /## 남은 질문\n- 없음/);
	const state = readState(root, SID);
	assert.equal(state.active, false);
	assert.deepEqual(state.fixed_items.map(item => item.id), ["화면:신청폼", "흐름:승인"]);
	assert.throws(() => note(root, 5), /이미 끝났습니다/);
});

test("sign --early: 3턴부터 가능하고, 남은 구멍과 모순이 '남은 질문'으로 들어가며 결과는 조기 종료", () => {
	const root = tempProject();
	start(root);
	note(root, 1, { statements: [said("왜", "why"), said("무엇", "what", { id: "s2" })], gaps: [{ text: "반차?", area: "avoid", cost: "high", why_cost: "화면이 달라짐" }] });
	note(root, 2, { disputes: [{ statement: "s2", claim: "다른 무엇" }] });
	sign(root);
	assert.throws(() => cli(root, "sign", "--slug", "x", "--summary", "요약", "--early"), /조기 종료는 3턴부터/);
	note(root, 3, { resolve: [{ statement: "s2", keep: "old" }] });
	note(root, 4, { disputes: [{ statement: "s2", claim: "또 다른 무엇" }] });
	sign(root);
	const r = cli(root, "sign", "--slug", "x", "--summary", "요약", "--early");
	assert.equal(r.early_exit, true);
	assert.equal(r.open_questions, 2);
	const markdown = fs.readFileSync(path.join(root, r.spec_path), "utf8");
	assert.equal(parseSpec(markdown).passed, false);
	assert.match(markdown, /## 남은 질문\n- \[ \] 반차\? — 하지 않을 것, 틀리면: 화면이 달라짐\n- \[ \] 모순 미정리: "무엇" vs "또 다른 무엇"/);
	assert.equal(cli(root, "start").already_active, false); // 끝났으므로 새로 시작된다
});

test("sign: 같은 이름의 스펙이 있으면 거부한다", () => {
	const root = readyInterview(tempProject());
	cli(root, "review", ...input({}));
	sign(root);
	fs.mkdirSync(path.join(root, ".deep-interview/specs"), { recursive: true });
	fs.writeFileSync(path.join(root, ".deep-interview/specs/deep-interview-leave.md"), "x");
	assert.throws(() => cli(root, "sign", "--slug", "leave", "--summary", "요약"), /이미 있습니다/);
	assert.equal(readState(root, SID).active, true);
});

test("end: 정상 종료는 sign으로만, cancelled는 언제나 가능하고 기록은 남는다", () => {
	const root = tempProject();
	start(root);
	note(root, 1, { statements: [said("x", "what")] });
	say(root, "그만할래");
	assert.throws(() => cli(root, "end", "--status", "done"), /sign/);
	const ended = cli(root, "end", "--status", "cancelled");
	assert.equal(ended.status, "cancelled");
	assert.equal(readState(root, SID).turns.length, 1);
	assert.ok(fs.existsSync(path.join(sessionDir(root, SID), "answers.jsonl")));
	assert.equal(cli(root, "end").ended, false);
});

test("이전 버전(체크리스트) 상태는 새 명령이 받지 않고 취소만 된다", () => {
	const root = tempProject();
	start(root);
	const file = path.join(sessionDir(root, SID), "state.json");
	fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), version: 1, rounds: [] }));
	assert.throws(() => note(root, 1), /이전 버전/);
	assert.equal(cli(root, "end", "--status", "cancelled").status, "cancelled");
});

test("--early 뒤의 단어를 값으로 삼키지 않는다", () => {
	const root = readyInterview(tempProject());
	assert.throws(() => cli(root, "sign", "--early", "leave", "--slug", "x", "--summary", "y"), /알 수 없는 인자입니다: leave/);
});

test("잘못된 --type이면 기존 기록을 건드리지 않는다", () => {
	const root = tempProject();
	cli(root, "start", "--topic", "첫번째");
	cli(root, "end", "--status", "cancelled");
	assert.throws(() => cli(root, "start", "--type", "bogus"), /--type/);
	assert.equal(readState(root, SID).topic, "첫번째");
});

test("기존 코드 고치기(brownfield)는 '기존 코드' 항목까지 있어야 낭독할 수 있다", () => {
	const root = tempProject();
	start(root, "--type", "brownfield");
	note(root, 1, { statements: [said("왜", "why"), said("무엇", "what"), said("지킬", "keep"), said("끝", "done")] });
	assert.throws(() => cli(root, "review", ...input({})), /진술이 없는 항목이 있습니다: 기존 코드/);
	fs.writeFileSync(path.join(root, "app.ts"), "");
	assert.equal(note(root, 2, { statements: [{ text: "app.ts를 고친다", area: "code", source: "code", evidence: "app.ts 참조" }] }).ready_for_review, true);
});

test("start는 .deep-interview/.gitignore에 sessions/와 builds/를 넣는다 (한 번만)", () => {
	const root = tempProject();
	cli(root, "start");
	cli(root, "end", "--status", "cancelled");
	cli(root, "start");
	const ignore = fs.readFileSync(path.join(root, ".deep-interview/.gitignore"), "utf8");
	assert.equal(ignore.split("\n").filter(line => line === "sessions/").length, 1);
	assert.equal(ignore.split("\n").filter(line => line === "builds/").length, 1);
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
	assert.throws(() => cli(root, "status"), /알 수 없는 명령/); // 옛 이름. 지금은 board
	assert.throws(() => run(["start", "--session", "../evil", "--root", root], root), /세션 ID/);
	assert.throws(() => run(["start", "--root", root], root), /--session이 필요합니다/);
});

test("CLI로 직접 실행하면 JSON을 출력하고, 실패하면 종료 코드 1", () => {
	const root = tempProject();
	const script = path.resolve("skills/deep-interview/scripts/interview.mjs");
	const out = JSON.parse(execFileSync("node", [script, "start", "--session", SID, "--root", root, "--topic", "x"], { env: process.env }).toString());
	assert.equal(out.ok, true);
	let failed = null;
	try {
		execFileSync("node", [script, "note", "--session", SID, "--root", root, "--input", "{bad"], { env: process.env, stdio: "pipe" });
	} catch (error) {
		failed = error;
	}
	assert.equal(failed.status, 1);
	assert.match(JSON.parse(failed.stdout.toString()).error, /올바른 JSON이 아닙니다/);
});
