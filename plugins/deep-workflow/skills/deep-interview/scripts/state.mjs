// 인터뷰 상태 파일과 점수 계산을 다루는 도우미. 명령 스크립트(interview.mjs)와 훅들이 함께 쓴다.
//
// 세션마다 폴더 하나를 쓴다: <프로젝트>/.deep-interview/sessions/<세션ID>/
//   state.json     인터뷰 상태 (덩어리, 라운드, 체크리스트 답, 확정된 사실, 계산된 모호도)
//   answers.jsonl  사용자 답 원문 (선택지 창 답과 채팅 메시지를 훅이 자동으로 적음)
// state.json의 active가 true인 동안 가드 훅이 그 세션의 코드 수정을 막는다.

import fs from "node:fs";
import path from "node:path";
import { DIR_NAME, assertSessionId, findRoot, projectRoot, resolveRoot, writeSessionIndex } from "../../../lib/session-root.mjs";

export { DIR_NAME, assertSessionId, findRoot, projectRoot, resolveRoot, writeSessionIndex };
export const HARD_CAP_ROUNDS = 30;
export const EARLY_EXIT_MIN_ROUNDS = 3;

// 기준값: 모호도가 이 값 이하로 내려오면 인터뷰를 마무리한다.
export const THRESHOLDS = {
	default: { value: 0.2, source: "기본값" },
	quick: { value: 0.35, source: "--quick" },
	deep: { value: 0.05, source: "--deep" },
};

// 항목별 비중. 기존 코드를 고치는 일은 '기존 코드' 항목 15%가 더해지고 나머지가 줄어든다.
export const WEIGHTS = {
	greenfield: { goal: 0.4, constraints: 0.3, criteria: 0.3 },
	brownfield: { goal: 0.35, constraints: 0.25, criteria: 0.25, context: 0.15 },
};

export const DIMENSION_NAMES = { goal: "목표", constraints: "제약", criteria: "성공 기준", context: "기존 코드" };

// 채점 체크리스트. AI는 감으로 0~1 점수를 매기지 않고, 질문마다 예(근거 한 줄)/아니오만 답한다.
// 항목 점수 = 예의 개수 / 질문 수. 같은 답이면 언제나 같은 점수가 나온다.
const CHECKLIST = {
	goal: {
		// "왜"를 맨 앞에 둔다. 이유를 모르면 요구사항을 잘 정리해도 엉뚱한 문제를 풀 수 있다.
		g0: "왜 만드는지(해결할 문제와 그 이유)가 정해졌다",
		g1: "만들 것을 조건 없이 한 문장으로 말할 수 있다",
		g2: "누가 쓰는지(사용자, 역할)가 정해졌다",
		g3: "핵심 대상과 그 관계(무엇이 무엇을 하는지)가 분명하다",
	},
	constraints: {
		c1: "이번에 하지 않을 것(범위 밖)이 정해졌다",
		c2: "지켜야 할 기술·환경·규칙 조건이 정해졌다",
		c3: "경계 상황(최대·최소, 예외 입력 등)을 어디까지 다룰지 정해졌다",
	},
	criteria: {
		s1: "완성을 확인할 테스트를 바로 쓸 수 있는 기준이 있다",
		s2: "정상 흐름에서 기대하는 결과가 구체적이다",
		s3: "실패·예외 상황에서 기대하는 결과가 정해졌다",
	},
	context: {
		x1: "건드릴 파일·모듈을 코드에서 확인했다",
		x2: "기존 방식(패턴)을 따를지 바꿀지 정해졌다",
		x3: "변경이 다른 기능에 주는 영향을 확인했다",
	},
};

// 체크 ID → 항목. 예: g1 → goal
export const CHECK_DIMENSION = Object.fromEntries(
	Object.entries(CHECKLIST).flatMap(([dimension, checks]) => Object.keys(checks).map(id => [id, dimension])),
);

// =============================================================================
// 경로
// =============================================================================

// 루트 판정(projectRoot: cwd 기준, resolveRoot: 세션 색인 우선)과 세션 ID 검사는 lib/session-root.mjs에 있다.
// 인터뷰 명령, 빌드 명령, 훅이 모두 같은 규칙을 쓴다. 다르게 정하면 CLI가 쓴 상태를 훅이 못 본다.

export const sessionsDir = root => path.join(root, DIR_NAME, "sessions");
export const sessionDir = (root, sid) => path.join(sessionsDir(root), assertSessionId(sid));
export const statePath = (root, sid) => path.join(sessionDir(root, sid), "state.json");
export const answersPath = (root, sid) => path.join(sessionDir(root, sid), "answers.jsonl");
/** 스펙을 저장하는 폴더. 인터뷰 중에도 조건을 만족하면 여기에 쓸 수 있다. */
export const specsDir = root => path.join(root, DIR_NAME, "specs");

// =============================================================================
// 읽기·쓰기
// =============================================================================

/** 상태를 읽는다. 없거나 깨졌으면 null. */
export function readState(root, sid) {
	try {
		return JSON.parse(fs.readFileSync(statePath(root, sid), "utf8"));
	} catch {
		return null;
	}
}

/** 임시 파일에 먼저 쓰고 rename해서 저장한다. 중간에 끊겨도 state.json이 반쯤 쓰인 채로 남지 않는다. */
export function writeState(root, sid, state) {
	const file = statePath(root, sid);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify({ ...state, updated_at: new Date().toISOString() }, null, 2)}\n`);
	fs.renameSync(tmp, file);
}

/** 사용자 답 원문 기록을 읽는다. 깨진 줄은 건너뛴다. */
export function readAnswers(root, sid) {
	try {
		return fs
			.readFileSync(answersPath(root, sid), "utf8")
			.split("\n")
			.filter(Boolean)
			.flatMap(line => {
				try {
					return [JSON.parse(line)];
				} catch {
					return [];
				}
			});
	} catch {
		return [];
	}
}

/** 사용자 답 원문 한 건을 덧붙인다. */
export function appendAnswer(root, sid, record) {
	const file = answersPath(root, sid);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.appendFileSync(file, `${JSON.stringify(record)}\n`);
}

/** 인터뷰가 진행 중인지. 진행 중이면 가드 훅이 코드 수정을 막는다. */
export function isActive(state) {
	return Boolean(state) && state.active === true;
}

// =============================================================================
// 사용자 확인 선택지
// =============================================================================

// 코드가 "사용자가 확인했다"로 받는 선택지 글자. 범위 확정(scope)과 스펙 저장·정상 종료(completionBlocker)가 본다.
// SKILL은 이 글자를 바꾸지 않고 쓴다. 끝에 " (추천)"은 붙여도 된다.
// 답 개수만 세면 되물음("그게 무슨 뜻이에요?")이나 잡담도 확인으로 세어지므로, 선택지 창에서 이 글자를 고른 기록만 받는다.
export const CONFIRM_LABELS = { scope: "맞아요", spec: "네, 이대로" };

/** 선택지 글자를 비교용으로 정리한다: 끝의 "(추천)"을 떼고 공백을 하나로 줄인다. */
export function normalizeLabel(value) {
	return String(value ?? "")
		.replace(/\s*[(（]\s*추천\s*[)）]\s*$/u, "")
		.replace(/\s+/g, " ")
		.trim();
}

/** 답 기록 한 건이 선택지 창(AskUserQuestion)에서 이 선택지를 고른 것인지. 채팅 답은 아니다. */
export function pickedLabel(answer, label) {
	if (answer?.source !== "ask" || !answer.answers || typeof answer.answers !== "object") return false;
	return Object.values(answer.answers).some(value => normalizeLabel(value) === label);
}

// =============================================================================
// 점수 계산
// =============================================================================

export function round2(value) {
	return Math.round(value * 100) / 100;
}

/** 이 인터뷰에서 쓰는 항목 목록. */
export function dimensionsFor(type) {
	return Object.keys(WEIGHTS[type] ?? WEIGHTS.greenfield);
}

/** 덩어리 하나의 항목별 점수. 그 항목의 체크를 한 번도 답하지 않았으면 null. */
export function componentScores(checks, type) {
	const scores = {};
	for (const dimension of dimensionsFor(type)) {
		const ids = Object.keys(CHECKLIST[dimension]);
		const answered = ids.filter(id => checks?.[id] !== undefined);
		scores[dimension] = answered.length === 0 ? null : round2(ids.filter(id => checks[id]?.yes === true).length / ids.length);
	}
	return scores;
}

/** 진행 중인(미루지 않은) 덩어리 목록. */
function activeComponents(state) {
	return (state.components ?? []).filter(component => component.status !== "deferred");
}

/**
 * 전체 항목 점수: 진행 중인 덩어리들의 평균. 답할 때마다 진행이 화면에 보이게 하기 위해서다.
 * 점수가 없는 덩어리는 0으로 계산한다. 한 덩어리만 깊이 파서 나머지가 가려지는 것은
 * 최저선(빈 덩어리 +5%p)과 thresholdMet(모든 덩어리가 각각 기준 이하)으로 막는다.
 */
export function overallScores(state) {
	const overall = {};
	const components = activeComponents(state);
	for (const dimension of dimensionsFor(state.type)) {
		const values = components.map(component => componentScores(state.checks?.[component.id], state.type)[dimension] ?? 0);
		overall[dimension] = values.length === 0 ? 0 : round2(values.reduce((sum, value) => sum + value, 0) / values.length);
	}
	return overall;
}

/** 항목 점수에서 모호도를 계산한다: 1 - Σ(항목 점수 × 비중). */
function ambiguityOf(scores, type) {
	const weights = WEIGHTS[type] ?? WEIGHTS.greenfield;
	let clarity = 0;
	for (const [dimension, weight] of Object.entries(weights)) clarity += (scores[dimension] ?? 0) * weight;
	return round2(1 - clarity);
}

/** 전체 모호도 계산값 (덩어리 평균 점수 기준). */
export function rawAmbiguity(state) {
	return ambiguityOf(overallScores(state), state.type);
}

/** 덩어리마다 따로 계산한 모호도. 마무리하려면 모든 덩어리가 기준 이하여야 한다. */
function componentAmbiguities(state) {
	return Object.fromEntries(
		activeComponents(state).map(component => [component.id, ambiguityOf(componentScores(state.checks?.[component.id], state.type), state.type)]),
	);
}

/**
 * 최저선: 점수를 후하게 주지 않도록, 코드가 상태만 보고 셀 수 있는 최소 모호도.
 * - 뒤집힌 채 정리되지 않은 사실 1개당 +0.10
 * - 이 인터뷰의 항목(목표·제약·성공 기준, brownfield면 기존 코드까지) 중 체크를 한 번도 답하지 않은 항목이 있는 덩어리 1개당 +0.05
 * - +0.05 × (AI가 대신 답한 라운드 수 / 기록된 라운드 수)
 */
export function computeFloor(state) {
	const disputed = (state.facts ?? []).filter(fact => fact.status === "disputed");
	const unscored = activeComponents(state).filter(component => {
		const scores = componentScores(state.checks?.[component.id], state.type);
		return dimensionsFor(state.type).some(dimension => scores[dimension] === null);
	});
	const rounds = (state.rounds ?? []).length;
	const autoRatio = rounds === 0 ? 0 : (state.rounds ?? []).filter(round => round.answer_source === "auto").length / rounds;
	const floor = round2(Math.min(1, 0.1 * disputed.length + 0.05 * unscored.length + 0.05 * autoRatio));
	const reasons = [];
	if (disputed.length) reasons.push(`뒤집힌 사실 ${disputed.length}개 (${disputed.map(fact => fact.id).join(", ")})`);
	if (unscored.length) reasons.push(`점수 빈 덩어리 ${unscored.length}개 (${unscored.map(component => component.id).join(", ")})`);
	if (autoRatio > 0) reasons.push(`AI 대리 답 비율 ${Math.round(autoRatio * 100)}%`);
	return { floor, reasons };
}

/** 모호도 구간. 구간이 바뀌면 세 관점 점검을 한다. */
export function milestoneFor(ambiguity, threshold) {
	if (ambiguity <= threshold) return "완료";
	if (ambiguity > 0.6) return "시작";
	if (ambiguity > 0.3) return "중간";
	return "막바지";
}

/**
 * 최종 모호도 = max(계산값, 최저선).
 * 기준 통과(thresholdMet)는 최종 모호도가 기준 이하이고, 진행 중인 덩어리 각각도 기준 이하일 때만이다.
 */
export function evaluateState(state) {
	const raw = rawAmbiguity(state);
	const { floor, reasons } = computeFloor(state);
	const ambiguity = Math.max(raw, floor);
	const perComponent = componentAmbiguities(state);
	const lagging = Object.entries(perComponent)
		.filter(([, value]) => value > state.threshold)
		.map(([id]) => id);
	const thresholdMet = ambiguity <= state.threshold && lagging.length === 0;
	return { raw, floor, floor_reasons: reasons, ambiguity, clamped: floor > raw, per_component: perComponent, lagging, threshold_met: thresholdMet };
}

/**
 * 인터뷰를 마쳐도(스펙 저장, end --status done) 되는지 확인한다. 안 되면 이유 문자열, 되면 null.
 * - 기록된 라운드가 있어야 한다
 * - 코드가 계산한 모호도가 기준값 이하이거나, 조기 종료를 표시했어야 한다
 * - 마지막 라운드 뒤의 마지막 사용자 답이 선택지 창에서 "네, 이대로"(한 문장 맞춰 보기 확인)를 고른 기록이어야 한다
 */
export function completionBlocker(root, sid, state) {
	const rounds = state.rounds ?? [];
	if (rounds.length === 0) return "아직 기록된 라운드가 없습니다. 라운드마다 record를 실행해야 합니다.";
	if (!state.early_exit) {
		const evaluation = evaluateState(state);
		if (evaluation.ambiguity > state.threshold) {
			return `모호도 ${Math.round(evaluation.ambiguity * 100)}%가 기준값 ${Math.round(state.threshold * 100)}%보다 높습니다. 질문을 더 하거나, 사용자가 원하면 early-exit를 실행하세요.`;
		}
		if (evaluation.lagging.length > 0) {
			return `아직 기준값을 넘지 못한 덩어리가 있습니다: ${evaluation.lagging.join(", ")}. 그 덩어리를 더 묻거나, 사용자가 원하면 early-exit를 실행하세요.`;
		}
	}
	// 시각 비교 대신 개수로 본다: 마지막 라운드를 기록한 뒤에 온 답이어야 하고, 그 마지막 답이 선택지 창에서 "네, 이대로"를 고른 것이어야 한다.
	// 채팅 답, 되물음, 다른 선택지는 받지 않는다. 확인 뒤에 사용자가 다른 말을 했으면 다시 확인받아야 한다.
	const seenAtLastRound = Math.max(...rounds.map(round => round.answers_seen ?? Number.POSITIVE_INFINITY));
	const answers = readAnswers(root, sid);
	const last = answers.length > seenAtLastRound ? answers.at(-1) : null;
	if (!pickedLabel(last, CONFIRM_LABELS.spec)) {
		return `마지막 라운드 뒤에 사용자가 선택지 창에서 "${CONFIRM_LABELS.spec}"를 고른 기록이 없습니다. 한 문장 맞춰 보기를 AskUserQuestion으로 묻고 그 선택지를 받으세요 (채팅 답이나 되물음은 확인으로 세지 않습니다).`;
	}
	return null;
}

/** 덩어리 진행 표시: ✅ 모든 항목 만점, 🔶 일부 답함, ⬜ 아직. 미룬 덩어리는 "미룸". */
export function componentProgress(state) {
	return (state.components ?? []).map(component => {
		if (component.status === "deferred") return { id: component.id, name: component.name, mark: "미룸" };
		const scores = Object.values(componentScores(state.checks?.[component.id], state.type));
		const mark = scores.every(score => score === 1) ? "✅" : scores.some(score => score !== null) ? "🔶" : "⬜";
		return { id: component.id, name: component.name, mark };
	});
}

/**
 * 다음에 물을 곳 제안: 점수가 가장 낮은 (덩어리, 항목). 점수가 없으면 가장 먼저.
 * 비슷하면 마지막에 물은 덩어리는 피한다. 아직 "아니오"인 체크 질문도 함께 돌려준다.
 */
export function suggestNext(state) {
	const lastComponent = (state.rounds ?? []).at(-1)?.component ?? null;
	const perComponent = componentAmbiguities(state);
	const candidates = [];
	for (const component of activeComponents(state)) {
		const checks = state.checks?.[component.id] ?? {};
		const scores = componentScores(checks, state.type);
		for (const dimension of dimensionsFor(state.type)) {
			const score = scores[dimension];
			if (score === 1) continue;
			const unmet = Object.entries(CHECKLIST[dimension])
				.filter(([id]) => checks[id]?.yes !== true)
				.map(([id, text]) => `${id}: ${text}`);
			candidates.push({ component: component.id, dimension, score, unmet, lagging: perComponent[component.id] > state.threshold });
		}
	}
	if (candidates.length === 0) return null;
	// 기준을 아직 못 넘은 덩어리를 먼저, 그 안에서 점수 없는 항목 → 낮은 점수 순. 같으면 방금 물은 덩어리는 피한다.
	const rank = candidate => (candidate.lagging ? 0 : 10) + (candidate.score === null ? -1 : candidate.score) + (candidate.component === lastComponent ? 0.001 : 0);
	candidates.sort((a, b) => rank(a) - rank(b));
	return candidates[0];
}
