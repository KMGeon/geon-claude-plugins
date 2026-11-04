// 조서(인터뷰 상태) 모델과 판정. 명령 스크립트(interview.mjs)와 훅들이 함께 쓴다.
//
// 비유: AI는 형사, 사용자는 자기가 한 말을 잊는 용의자. 형사는 질문지 대신 조서를 쓴다.
// 조서에는 칸이 넷이다: 확정(confirmed) · 잠정(tentative) · 모순(disputed) · 구멍(open gap).
// 숫자 넷은 코드가 센다. AI가 부르는 점수가 아니다.
//
// 세션마다 폴더 하나를 쓴다: <프로젝트>/.deep-interview/sessions/<세션ID>/
//   state.json     조서 (진술, 구멍, 턴, 두 번째 형사 기록)
//   answers.jsonl  사용자 답 원문 (선택지 창 답과 채팅 메시지를 훅이 자동으로 적음)
// state.json의 active가 true인 동안 가드 훅이 그 세션의 코드 수정을 막는다.

import fs from "node:fs";
import path from "node:path";
import { DIR_NAME, assertSessionId, findRoot, projectRoot, resolveRoot, writeSessionIndex } from "../../../lib/session-root.mjs";

export { DIR_NAME, assertSessionId, findRoot, projectRoot, resolveRoot, writeSessionIndex };

export const STATE_VERSION = 2;
export const HARD_CAP_TURNS = 30;
export const EARLY_EXIT_MIN_TURNS = 3;

// 조서 항목. 형사 머릿속의 "동기·수단·기회"에 해당한다. 구멍과 진술은 반드시 이 중 하나에 속한다.
export const AREAS = {
	why: "왜",
	what: "무엇",
	keep: "지킬 조건",
	avoid: "하지 않을 것",
	done: "완료 기준",
	code: "기존 코드",
};

// 낭독 전에 진술이 하나 이상 있어야 하는 묶음. 기존 코드 고치기(brownfield)만 "기존 코드"까지 요구한다.
export const REQUIRED_AREA_GROUPS = {
	greenfield: [["why"], ["what"], ["keep", "avoid"], ["done"]],
	brownfield: [["why"], ["what"], ["keep", "avoid"], ["done"], ["code"]],
};

export const TYPES = Object.keys(REQUIRED_AREA_GROUPS);
export const COSTS = ["high", "mid", "low"]; // 구멍을 틀리면 치르는 비용. 높은 것부터 묻는다.
export const SOURCES = ["user", "inferred", "code", "auto"]; // 진술 출처: 사용자가 직접 말함 / 형사가 정리함 / 코드에서 확인 / 형사가 대신 정함
export const STATEMENT_STATUSES = ["tentative", "confirmed", "disputed", "retracted"];

// =============================================================================
// 경로
// =============================================================================

export const sessionsDir = root => path.join(root, DIR_NAME, "sessions");
export const sessionDir = (root, sid) => path.join(sessionsDir(root), assertSessionId(sid));
export const statePath = (root, sid) => path.join(sessionDir(root, sid), "state.json");
export const answersPath = (root, sid) => path.join(sessionDir(root, sid), "answers.jsonl");
/** 스펙 폴더. 서명(sign) 명령이 조서에서 스펙을 만들어 여기에 쓴다. */
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

// 코드가 "용의자가 서명했다"로 받는 선택지 글자. SKILL은 이 글자를 바꾸지 않고 쓴다. 끝에 " (추천)"은 붙여도 된다.
// 답 개수만 세면 되물음이나 잡담도 서명으로 세어지므로, 선택지 창에서 이 글자를 고른 기록만 받는다.
export const CONFIRM_LABELS = { sign: "서명" };

/** 선택지 글자를 비교용으로 정리한다: 끝의 "(추천)"을 떼고 공백을 하나로 줄인다. */
export function normalizeLabel(value) {
	return String(value ?? "")
		.replace(/\s*[(（]\s*추천\s*[)）]\s*$/u, "")
		.replace(/\s+/g, " ")
		.trim();
}

/** 답 기록 한 건이 선택지 창(AskUserQuestion)에서 주어진 글자를 고른 것인지. */
export function pickedLabel(answer, label) {
	if (!answer || answer.source !== "ask" || !answer.answers || typeof answer.answers !== "object") return false;
	return Object.values(answer.answers).some(value => normalizeLabel(value) === label);
}

// =============================================================================
// 조서 계산
// =============================================================================

const COST_RANK = { high: 0, mid: 1, low: 2 };

/** 살아 있는 진술(확정·잠정·모순). 철회된 것은 뺀다. */
export function liveStatements(state) {
	return (state.statements ?? []).filter(statement => statement.status !== "retracted");
}

/** 열린 구멍. 비싼 것부터, 같으면 먼저 생긴 것부터. */
export function openGaps(state) {
	return (state.gaps ?? [])
		.filter(gap => gap.status === "open")
		.sort((a, b) => COST_RANK[a.cost] - COST_RANK[b.cost] || a.opened_turn - b.opened_turn);
}

/** 조서 숫자 넷. 화면 맨 윗줄에 그대로 쓴다. */
export function counts(state) {
	const live = liveStatements(state);
	return {
		confirmed: live.filter(statement => statement.status === "confirmed").length,
		tentative: live.filter(statement => statement.status === "tentative").length,
		disputed: live.filter(statement => statement.status === "disputed").length,
		gaps: openGaps(state).length,
	};
}

/** 이 인터뷰에서 요구하는 항목 묶음. */
export function requiredGroups(state) {
	return REQUIRED_AREA_GROUPS[state.type] ?? REQUIRED_AREA_GROUPS.greenfield;
}

const groupLabel = group => group.map(area => AREAS[area]).join("·");

/**
 * 진술이 하나도 없는 항목 묶음과, 잠정 진술만 있는 묶음.
 * 비어 있으면 낭독을 막는다. 잠정만 있으면 막지는 않지만 돌려줘서 형사가 다음 질문에 깔 수 있게 한다.
 */
export function areaCoverage(state) {
	const live = liveStatements(state).filter(statement => statement.status !== "disputed");
	const missing = [];
	const tentativeOnly = [];
	for (const group of requiredGroups(state)) {
		const inGroup = live.filter(statement => group.includes(statement.area));
		if (inGroup.length === 0) missing.push(groupLabel(group));
		else if (!inGroup.some(statement => statement.status === "confirmed")) tentativeOnly.push(groupLabel(group));
	}
	return { missing, tentative_only: tentativeOnly };
}

/**
 * 다음에 물을 것. 모순이 있으면 그것부터(다른 질문은 하지 않는다), 없으면 가장 비싼 구멍, 구멍도 없으면 빈 항목.
 * 전부 없으면 null = 두 번째 형사를 부를 차례.
 */
export function suggestNext(state) {
	const disputed = liveStatements(state).find(statement => statement.status === "disputed");
	if (disputed) return { kind: "dispute", statement: disputed };
	const gap = openGaps(state)[0];
	if (gap) return { kind: "gap", gap };
	const { missing } = areaCoverage(state);
	if (missing.length) return { kind: "area", area: missing[0] };
	return null;
}

/** 마지막 턴 번호. 턴이 없으면 0. */
export function lastTurn(state) {
	return (state.turns ?? []).at(-1)?.turn ?? 0;
}

/** 마지막 턴 뒤에 기록된 두 번째 형사 검토. 없으면 null. */
export function reviewAfterLastTurn(state) {
	const review = (state.reviews ?? []).at(-1);
	return review && review.turn === lastTurn(state) ? review : null;
}

/** 낭독(조서 읽어 주기)으로 갈 수 있는지. 안 되면 이유, 되면 null. 두 번째 형사 검토는 여기서 보지 않는다. */
export function readinessBlocker(state) {
	if (lastTurn(state) === 0) return "아직 기록된 턴이 없습니다. 답마다 note를 실행해야 합니다.";
	const c = counts(state);
	if (c.disputed > 0) return `모순이 ${c.disputed}개 남아 있습니다. 어느 쪽이 맞는지 되물어 resolve로 정리하세요.`;
	if (c.gaps > 0) return `구멍이 ${c.gaps}개 남아 있습니다 (${openGaps(state).map(gap => gap.id).join(", ")}). 더 묻거나, 용의자가 그만두기로 했다면 sign --early를 쓰세요.`;
	const { missing } = areaCoverage(state);
	if (missing.length) return `진술이 없는 항목이 있습니다: ${missing.join(", ")}. 그 항목을 물어야 합니다.`;
	return null;
}

/**
 * 서명(스펙 생성·정상 종료)할 수 있는지. 안 되면 이유, 되면 null.
 * - 조기 종료(early)가 아니면: 낭독 조건 + 마지막 턴 뒤에 두 번째 형사가 새 구멍을 못 찾은 기록
 * - 조기 종료면: 턴이 EARLY_EXIT_MIN_TURNS 이상
 * - 둘 다: 마지막 턴·검토 뒤의 마지막 사용자 답이 선택지 창에서 "서명"을 고른 기록
 */
export function signBlocker(root, sid, state, { early = false } = {}) {
	const turns = state.turns ?? [];
	if (early) {
		if (turns.length < EARLY_EXIT_MIN_TURNS && turns.length < HARD_CAP_TURNS) {
			return `조기 종료는 ${EARLY_EXIT_MIN_TURNS}턴부터 가능합니다. 지금까지 ${turns.length}턴입니다.`;
		}
	} else {
		const blocker = readinessBlocker(state);
		if (blocker) return blocker;
		const review = reviewAfterLastTurn(state);
		if (!review) return "마지막 턴 뒤에 두 번째 형사 검토(review)가 없습니다. 조서만 보고 구멍을 찾게 한 뒤 review로 기록하세요.";
		if (review.new_gaps.length > 0) return `두 번째 형사가 구멍 ${review.new_gaps.length}개를 찾았습니다 (${review.new_gaps.join(", ")}). 그것부터 묻습니다.`;
	}
	// 시각 비교 대신 개수로 본다: 마지막 턴(또는 검토)을 기록한 뒤에 온 답이어야 하고, 그 마지막 답이 선택지 창에서 "서명"을 고른 것이어야 한다.
	const seen = Math.max(0, ...turns.map(turn => turn.answers_seen ?? 0), ...(state.reviews ?? []).map(review => review.answers_seen ?? 0));
	const answers = readAnswers(root, sid);
	const last = answers.length > seen ? answers.at(-1) : null;
	if (!pickedLabel(last, CONFIRM_LABELS.sign)) {
		return `조서를 읽어 준 뒤 사용자가 선택지 창에서 "${CONFIRM_LABELS.sign}"을 고른 기록이 없습니다. 조서 낭독을 AskUserQuestion(선택지 "${CONFIRM_LABELS.sign}", "이 줄 아님")으로 묻고 그 선택지를 받으세요 (채팅 답이나 되물음은 서명으로 세지 않습니다).`;
	}
	return null;
}

/** 주어진 턴 뒤에 바뀐 진술과 구멍. 낭독을 다시 할 때 바뀐 줄만 읽어 주기 위해서다. */
export function changedSince(state, turn) {
	return {
		statements: (state.statements ?? []).filter(statement => (statement.updated_turn ?? statement.turn) > turn),
		gaps: (state.gaps ?? []).filter(gap => gap.opened_turn > turn || (gap.closed_turn ?? 0) > turn),
	};
}
