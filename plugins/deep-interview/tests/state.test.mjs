import { test } from "node:test";
import assert from "node:assert/strict";
import { computeFloor, componentScores, evaluateState, milestoneFor, overallScores, rawAmbiguity, suggestNext } from "../skills/deep-interview/scripts/state.mjs";

/** 체크 답을 상태 형식으로 만든다. yes 목록에 있으면 예, no 목록에 있으면 아니오. */
function checks(yes, no = []) {
	return {
		...Object.fromEntries(yes.map(id => [id, { yes: true, evidence: "근거" }])),
		...Object.fromEntries(no.map(id => [id, { yes: false }])),
	};
}

test("항목 점수는 예의 개수 / 질문 수이고, 답이 없으면 null", () => {
	const scores = componentScores(checks(["g1", "g2"], ["g3", "c1"]), "greenfield");
	assert.equal(scores.goal, 0.67);
	assert.equal(scores.constraints, 0);
	assert.equal(scores.criteria, null);
	assert.equal("context" in scores, false);
});

test("새로 만들기: 모호도 = 1 - (목표×0.4 + 제약×0.3 + 성공 기준×0.3)", () => {
	const state = { type: "greenfield", components: [{ id: "a" }], checks: { a: checks(["g1", "g2", "g3", "c1", "c2", "c3"], ["s1", "s2", "s3"]) } };
	assert.equal(rawAmbiguity(state), 0.3);
});

test("기존 코드 고치기는 기존 코드 항목 15%가 더해진다", () => {
	const all = ["g1", "g2", "g3", "c1", "c2", "c3", "s1", "s2", "s3"];
	const state = { type: "brownfield", components: [{ id: "a" }], checks: { a: checks(all, ["x1", "x2", "x3"]) } };
	assert.equal(rawAmbiguity(state), 0.15);
});

test("전체 점수는 진행 중인 덩어리들의 평균 (미룬 덩어리는 제외)", () => {
	const state = {
		type: "greenfield",
		components: [{ id: "a" }, { id: "b" }, { id: "c", status: "deferred" }],
		checks: { a: checks(["g1", "g2", "g3"]), b: checks(["g1"], ["g2", "g3"]) },
	};
	assert.equal(overallScores(state).goal, 0.67);
});

test("한 덩어리만 다 정해져도 화면 모호도는 내려가지만, 기준 통과는 모든 덩어리가 각각 넘어야 한다", () => {
	const all = ["g1", "g2", "g3", "c1", "c2", "c3", "s1", "s2", "s3"];
	const state = { type: "greenfield", threshold: 0.2, components: [{ id: "a" }, { id: "b" }], checks: { a: checks(all), b: checks(all, []) } };
	assert.equal(evaluateState(state).threshold_met, true);

	// b는 성공 기준이 비어 혼자 30%, 평균은 15%라 화면상으로는 기준(20%) 아래지만 통과가 아니다.
	state.checks.b = checks(["g1", "g2", "g3", "c1", "c2", "c3"], ["s1", "s2", "s3"]);
	const result = evaluateState(state);
	assert.equal(result.ambiguity, 0.15);
	assert.equal(result.per_component.b, 0.3);
	assert.deepEqual(result.lagging, ["b"]);
	assert.equal(result.threshold_met, false);
});

test("최저선: 뒤집힌 사실 +0.10, 점수 빈 덩어리 +0.05, AI 대리 답 비율 × 0.05", () => {
	const state = {
		type: "greenfield",
		components: [{ id: "a" }, { id: "b" }],
		checks: { a: checks(["g1", "g2", "g3", "c1", "c2", "c3", "s1", "s2", "s3"]) },
		facts: [{ id: "f1", status: "disputed" }, { id: "f2", status: "superseded" }],
		rounds: [{ answer_source: "auto" }, { answer_source: "user" }],
	};
	const { floor, reasons } = computeFloor(state);
	assert.equal(floor, 0.18);
	assert.equal(reasons.length, 3);
});

test("최종 모호도는 계산값과 최저선 중 큰 값", () => {
	const all = ["g1", "g2", "g3", "c1", "c2", "c3", "s1", "s2", "s3"];
	const state = { type: "greenfield", components: [{ id: "a" }], checks: { a: checks(all) }, facts: [{ id: "f1", status: "disputed" }] };
	const result = evaluateState(state);
	assert.equal(result.raw, 0);
	assert.equal(result.ambiguity, 0.1);
	assert.equal(result.clamped, true);
});

test("구간 나누기", () => {
	assert.equal(milestoneFor(0.7, 0.2), "시작");
	assert.equal(milestoneFor(0.45, 0.2), "중간");
	assert.equal(milestoneFor(0.25, 0.2), "막바지");
	assert.equal(milestoneFor(0.2, 0.2), "완료");
});

test("다음 질문 제안: 점수 없는 곳 먼저, 비슷하면 방금 물은 덩어리는 피함", () => {
	const state = {
		type: "greenfield",
		components: [{ id: "a" }, { id: "b" }],
		checks: { a: checks(["g1"], ["g2", "g3", "c1", "c2", "c3", "s1", "s2", "s3"]), b: checks([], ["g1", "g2", "g3", "c1", "c2", "c3", "s1", "s2", "s3"]) },
		rounds: [{ component: "b" }],
	};
	const next = suggestNext(state);
	assert.equal(next.component, "a");
	assert.equal(next.dimension, "constraints");
	assert.equal(next.unmet.length, 3);
});
