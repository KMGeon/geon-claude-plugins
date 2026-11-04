import { test } from "node:test";
import assert from "node:assert/strict";
import { areaCoverage, changedSince, counts, openGaps, readinessBlocker, suggestNext } from "../skills/deep-interview/scripts/state.mjs";

const s = (id, area, status, extra = {}) => ({ id, text: id, area, status, source: "user", turn: 1, updated_turn: 1, ...extra });
const g = (id, cost, opened_turn = 1, status = "open") => ({ id, text: id, area: "what", cost, status, opened_turn, closed_turn: status === "closed" ? opened_turn + 1 : null });

test("숫자 넷: 철회된 진술과 닫힌 구멍은 세지 않는다", () => {
	const state = { statements: [s("s1", "why", "confirmed"), s("s2", "what", "tentative"), s("s3", "what", "disputed"), s("s4", "what", "retracted")], gaps: [g("g1", "high"), g("g2", "low", 1, "closed")] };
	assert.deepEqual(counts(state), { confirmed: 1, tentative: 1, disputed: 1, gaps: 1 });
});

test("구멍 순서: 비싼 것부터, 같으면 먼저 생긴 것부터", () => {
	const state = { gaps: [g("g1", "low", 1), g("g2", "high", 3), g("g3", "high", 2), g("g4", "mid", 1)] };
	assert.deepEqual(openGaps(state).map(gap => gap.id), ["g3", "g2", "g4", "g1"]);
});

test("항목 덮임: 묶음(지킬 조건·하지 않을 것)은 둘 중 하나만 있어도 되고, 잠정만 있으면 따로 알린다", () => {
	const state = { type: "greenfield", statements: [s("s1", "why", "confirmed"), s("s2", "what", "tentative"), s("s3", "avoid", "confirmed"), s("s4", "done", "disputed")] };
	assert.deepEqual(areaCoverage(state), { missing: ["완료 기준"], tentative_only: ["무엇"] });
	assert.deepEqual(areaCoverage({ ...state, type: "brownfield" }).missing, ["완료 기준", "기존 코드"]);
});

test("다음 질문: 모순 → 가장 비싼 구멍 → 빈 항목 → 없음(두 번째 형사 차례)", () => {
	const base = { type: "greenfield", turns: [{ turn: 1 }], statements: [s("s1", "why", "confirmed"), s("s2", "what", "confirmed"), s("s3", "keep", "confirmed"), s("s4", "done", "confirmed")], gaps: [] };
	assert.equal(suggestNext(base), null);
	assert.equal(readinessBlocker(base), null);
	assert.equal(suggestNext({ ...base, statements: base.statements.slice(0, 3) }).area, "완료 기준");
	assert.equal(suggestNext({ ...base, gaps: [g("g1", "low"), g("g2", "high")] }).gap.id, "g2");
	assert.equal(suggestNext({ ...base, gaps: [g("g1", "low")], statements: [...base.statements, s("s5", "what", "disputed")] }).statement.id, "s5");
	assert.match(readinessBlocker({ ...base, gaps: [g("g1", "low")] }), /구멍이 1개/);
	assert.match(readinessBlocker({ ...base, statements: [...base.statements, s("s5", "what", "disputed")] }), /모순이 1개/);
	assert.match(readinessBlocker({ ...base, turns: [] }), /기록된 턴이 없습니다/);
});

test("검토 뒤 바뀐 것: 그 턴 뒤에 적히거나 닫힌 것만", () => {
	const state = { statements: [s("s1", "why", "confirmed"), s("s2", "what", "confirmed", { turn: 2, updated_turn: 4 })], gaps: [g("g1", "low", 1), g("g2", "low", 3), g("g3", "low", 1, "closed")] };
	const changed = changedSince(state, 2);
	assert.deepEqual(changed.statements.map(x => x.id), ["s2"]);
	assert.deepEqual(changed.gaps.map(x => x.id), ["g2"]);
	assert.deepEqual(changedSince(state, 1).gaps.map(x => x.id), ["g2", "g3"]); // g3는 턴 2에 닫힘
});
