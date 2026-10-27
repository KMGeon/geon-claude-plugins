#!/usr/bin/env node
// 딥 인터뷰 상태 명령. 인터뷰 상태 파일은 이 스크립트로만 바꾼다.
//
// 사용법 (모두 --session <세션ID> 필요):
//   start  --topic <주제> [--quick|--deep] [--type greenfield|brownfield]   인터뷰 시작, 코드 수정 차단 시작
//   scope  --input <JSON>     Round 0에서 확인받은 덩어리와 고정 항목을 저장
//   record --input <JSON>     라운드 하나(질문, 답, 체크리스트 답, 사실 변경)를 기록하고 모호도를 계산
//   early-exit                조기 종료 표시 (3라운드 이후)
//   status                    현재 상태 보기
//   end    [--status done|cancelled] [--spec <경로>]   인터뷰 종료, 차단 해제
// --input은 JSON 문자열 또는 @파일경로. 결과는 JSON으로 출력하고, 실패하면 {"ok": false, "error": "..."}와 종료 코드 1.

import fs from "node:fs";
import path from "node:path";
import {
	CHECK_DIMENSION,
	DIR_NAME,
	DIMENSION_NAMES,
	EARLY_EXIT_MIN_ROUNDS,
	HARD_CAP_ROUNDS,
	THRESHOLDS,
	WEIGHTS,
	answersPath,
	completionBlocker,
	componentProgress,
	dimensionsFor,
	evaluateState,
	isActive,
	milestoneFor,
	overallScores,
	projectRoot,
	readAnswers,
	readState,
	round2,
	statePath,
	suggestNext,
	writeState,
} from "./state.mjs";

class CliError extends Error {}

/** 명령을 거부한다. 메시지는 JSON 에러로 전달된다. */
function fail(message) {
	throw new CliError(message);
}

// =============================================================================
// 인자 해석
// =============================================================================

// 값을 받지 않는 플래그. 뒤에 오는 단어를 값으로 삼키지 않는다 (`--deep leave`가 조용히 기본값이 되는 것 방지).
const BOOLEAN_FLAGS = new Set(["quick", "deep"]);

/** `<명령> --키 값 --플래그` 형태를 { command, flags }로 바꾼다. 값 없는 플래그는 true. */
function parseArgs(argv) {
	const [command, ...rest] = argv;
	const flags = {};
	for (let i = 0; i < rest.length; i += 1) {
		const token = rest[i];
		if (!token.startsWith("--")) fail(`알 수 없는 인자입니다: ${token}`);
		const next = rest[i + 1];
		if (BOOLEAN_FLAGS.has(token.slice(2)) || next === undefined || next.startsWith("--")) {
			flags[token.slice(2)] = true;
		} else {
			flags[token.slice(2)] = next;
			i += 1;
		}
	}
	return { command, flags };
}

/** `--input`을 읽는다. `@경로`면 파일 내용을 읽는다. */
function readInput(flags) {
	const raw = flags.input;
	if (typeof raw !== "string" || !raw) fail("--input이 필요합니다");
	let text = raw;
	if (raw.startsWith("@")) {
		try {
			text = fs.readFileSync(raw.slice(1), "utf8");
		} catch {
			fail(`--input 파일을 읽을 수 없습니다: ${raw.slice(1)}`);
		}
	}
	try {
		const parsed = JSON.parse(text);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail("--input은 JSON 객체여야 합니다");
		return parsed;
	} catch (error) {
		if (error instanceof CliError) throw error;
		fail(`--input이 올바른 JSON이 아닙니다: ${error.message}`);
	}
}

const isText = value => typeof value === "string" && value.trim().length > 0;

// =============================================================================
// 도우미
// =============================================================================

/** 진행 중인 인터뷰 상태를 읽는다. 없거나 끝났으면 거부한다. */
function requireActive(root, sid) {
	const state = readState(root, sid);
	if (!state) fail("이 세션에는 인터뷰 상태가 없습니다. 먼저 start를 실행하세요");
	if (!isActive(state)) fail(`이 세션의 인터뷰는 이미 끝났습니다 (상태: ${state.status})`);
	return state;
}

/** 명령 결과에 붙일 요약. */
function summary(root, sid, state) {
	return {
		active: state.active,
		status: state.status,
		topic: state.topic,
		type: state.type,
		threshold: state.threshold,
		threshold_source: state.threshold_source,
		current_ambiguity: state.current_ambiguity,
		rounds: (state.rounds ?? []).length,
		scope_confirmed: Boolean(state.scope_confirmed_at),
		components: componentProgress(state),
		answers_recorded: readAnswers(root, sid).length,
	};
}

/** 항목별 점수표 (화면의 점수표에 그대로 쓰는 숫자). */
function scoreTable(state) {
	const weights = WEIGHTS[state.type] ?? WEIGHTS.greenfield;
	const overall = overallScores(state);
	return dimensionsFor(state.type).map(dimension => ({
		dimension,
		name: DIMENSION_NAMES[dimension],
		score: overall[dimension],
		weight: weights[dimension],
		weighted: round2(overall[dimension] * weights[dimension]),
	}));
}

/**
 * `.deep-interview/.gitignore`에 `sessions/`와 `builds/`를 넣는다. 상태, 사용자 답 원문, 테스트 출력이 실수로 커밋되지 않게 하기 위해서다.
 * 스펙(`specs/`)·설계·계획은 남겨서 커밋할 수 있게 둔다. 이미 파일이 있으면 없는 줄만 덧붙인다.
 */
function ensureGitignore(root) {
	const file = path.join(root, DIR_NAME, ".gitignore");
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
	const have = new Set(current.split("\n").map(line => line.trim()));
	const missing = ["sessions/", "builds/"].filter(line => !have.has(line));
	if (missing.length === 0) return;
	const prefix = current && !current.endsWith("\n") ? "\n" : "";
	fs.writeFileSync(file, `${current}${prefix}# 딥 인터뷰 상태, 사용자 답 원문, 빌드 상태 (커밋하지 않음)\n${missing.join("\n")}\n`);
}

// =============================================================================
// 명령
// =============================================================================

/** 인터뷰를 시작한다. 같은 세션에 끝난 인터뷰가 있으면 이름을 바꿔 보관하고 새로 만든다. */
function cmdStart(root, sid, flags) {
	const existing = readState(root, sid);
	if (isActive(existing)) return { ok: true, already_active: true, ...summary(root, sid, existing) };
	// 입력 검사를 먼저 한다. 잘못된 입력 때문에 기존 기록만 보관되고 새 상태가 없는 일을 막는다.
	const type = flags.type ?? "greenfield";
	if (!(type in WEIGHTS)) fail('--type은 "greenfield" 또는 "brownfield"여야 합니다');
	if (existing) {
		const stamp = (existing.ended_at ?? existing.started_at ?? new Date().toISOString()).replace(/[:.]/g, "-");
		fs.renameSync(statePath(root, sid), statePath(root, sid).replace(/state\.json$/, `state-${stamp}.json`));
		if (fs.existsSync(answersPath(root, sid))) {
			fs.renameSync(answersPath(root, sid), answersPath(root, sid).replace(/answers\.jsonl$/, `answers-${stamp}.jsonl`));
		}
	}
	const mode = flags.deep === true ? "deep" : flags.quick === true ? "quick" : "default";
	const { value, source } = THRESHOLDS[mode];
	ensureGitignore(root);
	const state = {
		version: 1,
		session: sid,
		topic: isText(flags.topic) ? flags.topic : null,
		active: true,
		status: "interviewing",
		started_at: new Date().toISOString(),
		type,
		threshold: value,
		threshold_source: source,
		components: [],
		fixed_items: [],
		scope_confirmed_at: null,
		scope_history: [],
		checks: {},
		rounds: [],
		facts: [],
		current_ambiguity: 1,
		milestone: "시작",
		early_exit: false,
		answers_at_start: readAnswers(root, sid).length,
	};
	writeState(root, sid, state);
	return {
		ok: true,
		already_active: false,
		marker: `딥 인터뷰 기준값: ${Math.round(value * 100)}% (${source})`,
		...summary(root, sid, state),
	};
}

/** Round 0 결과(덩어리, 고정 항목)를 저장한다. 처음이든 다시 잡든, 직전 범위 확정 뒤에 사용자가 한 번은 답해야 한다. */
function cmdScope(root, sid, flags) {
	const state = requireActive(root, sid);
	const input = readInput(flags);
	// 답 개수로 본다 (같은 순간에 기록돼도 정확함). 다시 잡을 때는 직전 scope 이후의 답이어야 한다.
	const answersNow = readAnswers(root, sid).length;
	if (!(answersNow > (state.answers_at_scope ?? state.answers_at_start ?? 0))) {
		fail("사용자가 범위 확인에 답한 기록이 없습니다. 덩어리 목록을 보여주고 사용자 답을 받은 뒤 다시 실행하세요");
	}

	if (!Array.isArray(input.components) || input.components.length === 0) fail("components에 덩어리가 하나 이상 있어야 합니다");
	const ids = new Set();
	const components = input.components.map(component => {
		if (!isText(component?.id) || /\s/.test(component.id)) fail("덩어리 id는 공백 없는 문자열이어야 합니다");
		if (ids.has(component.id)) fail(`덩어리 id가 겹칩니다: ${component.id}`);
		ids.add(component.id);
		if (!isText(component.name)) fail(`덩어리 ${component.id}에 name이 필요합니다`);
		const status = component.status ?? "active";
		if (!["active", "deferred"].includes(status)) fail(`덩어리 ${component.id}의 status는 active 또는 deferred여야 합니다`);
		return { id: component.id, name: component.name, description: component.description ?? "", status, reason: component.reason ?? null };
	});
	// 이미 체크리스트 답이 있는 덩어리는 지울 수 없다. 범위에서 빼려면 deferred로 바꾼다.
	for (const id of Object.keys(state.checks ?? {})) {
		if (!ids.has(id)) fail(`덩어리 ${id}에는 이미 기록이 있어 지울 수 없습니다. status를 deferred로 바꾸세요`);
	}

	const fixedItems = (input.fixed_items ?? []).map(item => {
		if (!isText(item?.id) || !isText(item?.statement)) fail("fixed_items의 항목마다 id와 statement가 필요합니다");
		// component(어느 덩어리의 것인지)는 선택. 적어 두면 그 덩어리를 미뤘을 때 deep-build가 이 항목을 요구하지 않는다.
		if (item.component !== undefined && !ids.has(item.component)) fail(`fixed_items.${item.id}.component는 덩어리 id 중 하나여야 합니다: ${item.component}`);
		return { id: item.id, statement: item.statement, ...(item.component !== undefined ? { component: item.component } : {}) };
	});

	if (input.type !== undefined) {
		if (!(input.type in WEIGHTS)) fail('type은 "greenfield" 또는 "brownfield"여야 합니다');
		if (state.rounds.length > 0 && input.type !== state.type) fail("라운드를 기록한 뒤에는 type을 바꿀 수 없습니다");
		state.type = input.type;
	}
	if (state.scope_confirmed_at) {
		state.scope_history.push({ at: new Date().toISOString(), components: state.components, fixed_items: state.fixed_items });
	}
	if (!components.some(component => component.status === "active")) fail("진행 중(active)인 덩어리가 하나 이상 있어야 합니다. 전부 미루면 물을 것이 없습니다");
	state.components = components;
	state.fixed_items = fixedItems;
	state.scope_confirmed_at = new Date().toISOString();
	state.answers_at_scope = answersNow;
	const evaluation = evaluateState(state);
	state.current_ambiguity = evaluation.ambiguity;
	writeState(root, sid, state);
	return { ok: true, ...summary(root, sid, state), next: suggestNext(state) };
}

/** 체크리스트 답을 검증하고 상태에 반영한다. */
function applyChecks(state, checks, roundNumber) {
	if (!checks || typeof checks !== "object" || Array.isArray(checks)) fail("checks는 { 덩어리id: { 체크id: 근거 또는 false } } 형태여야 합니다");
	const dimensions = new Set(dimensionsFor(state.type));
	const componentIds = new Set(state.components.map(component => component.id));
	for (const [componentId, answers] of Object.entries(checks)) {
		if (!componentIds.has(componentId)) fail(`없는 덩어리입니다: ${componentId}`);
		if (!answers || typeof answers !== "object") fail(`checks.${componentId}는 객체여야 합니다`);
		for (const [checkId, value] of Object.entries(answers)) {
			const dimension = CHECK_DIMENSION[checkId];
			if (!dimension) fail(`없는 체크 질문입니다: ${checkId}`);
			if (!dimensions.has(dimension)) fail(`${checkId}는 이 인터뷰(${state.type})에서 쓰지 않는 항목입니다`);
			if (value !== false && !isText(value)) fail(`${componentId}.${checkId}: "예"는 근거 문자열, "아니오"는 false로 적으세요`);
			state.checks[componentId] ??= {};
			const next = value === false ? { yes: false, round: roundNumber } : { yes: true, evidence: value, round: roundNumber };
			// 값이 그대로면 처음 찍은 라운드를 유지한다. 나중 라운드를 번복할 때 앞 라운드에서 확정한 체크까지 지워지지 않게.
			const prev = state.checks[componentId][checkId];
			if (prev && prev.yes === next.yes && (prev.evidence ?? null) === (next.evidence ?? null)) continue;
			state.checks[componentId][checkId] = next;
		}
	}
}

/** 사실 추가·뒤집힘·재확인·대체를 반영한다. 사실은 지우지 않는다. */
function applyFacts(state, input, roundNumber) {
	const byId = id => state.facts.find(fact => fact.id === id);
	for (const fact of input.facts ?? []) {
		if (!isText(fact?.id) || !isText(fact?.statement)) fail("facts의 항목마다 id와 statement가 필요합니다");
		const existing = byId(fact.id);
		if (existing) {
			// 같은 id로 다시 보낸 사실은 이번 라운드의 답으로 다시 확정된 것이다. 라운드도 이번 것으로 옮겨서,
			// 이번 라운드를 번복하면 이 사실이 뒤집히고, 앞서 뒤집혔던 상태는 풀린다. 이전 문장은 history에 남긴다.
			if (existing.statement !== fact.statement) existing.history = [...(existing.history ?? []), { statement: existing.statement, round: existing.round }];
			Object.assign(existing, { statement: fact.statement, evidence: fact.evidence ?? existing.evidence, round: roundNumber, status: "active", superseded_by: null });
		} else state.facts.push({ id: fact.id, statement: fact.statement, evidence: fact.evidence ?? null, round: roundNumber, status: "active", superseded_by: null });
	}
	for (const id of input.dispute ?? []) {
		const fact = byId(id) ?? fail(`없는 사실입니다: ${id}`);
		if (fact.status === "active") fact.status = "disputed";
	}
	for (const id of input.confirm ?? []) {
		const fact = byId(id) ?? fail(`없는 사실입니다: ${id}`);
		if (fact.status === "disputed") fact.status = "active";
	}
	for (const pair of input.supersede ?? []) {
		const old = byId(pair?.old) ?? fail(`없는 사실입니다: ${pair?.old}`);
		if (!byId(pair?.new)) fail(`대체할 새 사실이 없습니다: ${pair?.new}. 먼저 facts에 넣으세요`);
		old.status = "superseded";
		old.superseded_by = pair.new;
	}
}

/**
 * 라운드 하나를 기록하고 모호도를 계산한다.
 * 이미 기록한 라운드 번호를 다른 답으로 다시 보내면 "답 번복"으로 보고, 그 라운드의 사실을 뒤집힘으로 표시한다.
 */
function cmdRecord(root, sid, flags) {
	const state = requireActive(root, sid);
	if (!state.scope_confirmed_at) fail("Round 0 범위가 확정되지 않았습니다. scope부터 실행하세요");
	const input = readInput(flags);

	const lastRound = state.rounds.at(-1)?.round ?? 0;
	const roundNumber = input.round;
	const previous = state.rounds.find(round => round.round === roundNumber);
	if (!Number.isInteger(roundNumber) || roundNumber < 1) fail("round는 1 이상의 정수여야 합니다");
	if (!previous && roundNumber !== lastRound + 1) fail(`다음 라운드 번호는 ${lastRound + 1}입니다`);
	const component = state.components.find(c => c.id === input.component);
	if (!component) fail(`component는 덩어리 id 중 하나여야 합니다: ${input.component}`);
	if (component.status === "deferred") fail(`${input.component}는 미룬(deferred) 덩어리라 라운드를 기록할 수 없습니다. 다시 다루려면 사용자에게 확인받고 scope로 active로 바꾸세요`);
	if (!dimensionsFor(state.type).includes(input.dimension)) fail(`dimension은 ${dimensionsFor(state.type).join(", ")} 중 하나여야 합니다`);
	if (!isText(input.question) || !isText(input.answer)) fail("question과 answer가 필요합니다");
	const source = input.answer_source ?? "user";
	if (!["user", "refined", "cited", "auto"].includes(source)) fail("answer_source는 user, refined, cited, auto 중 하나여야 합니다");
	if (!input.checks?.[input.component] || Object.keys(input.checks[input.component]).length === 0) {
		fail(`이번에 물은 덩어리(${input.component})의 체크리스트 답이 checks에 있어야 합니다`);
	}

	const before = state.current_ambiguity;
	const beforeMilestone = state.milestone;
	const retracted = previous && previous.answer !== input.answer;
	if (previous) {
		// 같은 라운드를 다시 기록하면 그 라운드에서 찍은 체크는 일단 지운다 (번복이든 체크 정정이든).
		// 이전 값은 복원하지 않고 "아직 답 안 함"으로 되돌린다 (점수가 낮아지는 쪽이 안전하다).
		for (const answers of Object.values(state.checks)) {
			for (const [checkId, check] of Object.entries(answers)) if (check.round === roundNumber) delete answers[checkId];
		}
	}
	if (retracted) {
		// 번복된 답을 근거로 한 사실은 뒤집힘으로 표시한다. 이번 요청의 facts에 같은 id가 있으면 applyFacts가 다시 active로 돌린다.
		for (const fact of state.facts) if (fact.round === roundNumber && fact.status === "active") fact.status = "disputed";
	}
	applyChecks(state, input.checks, roundNumber);
	applyFacts(state, input, roundNumber);

	const record = {
		round: roundNumber,
		component: input.component,
		dimension: input.dimension,
		question: input.question,
		answer: input.answer,
		answer_source: source,
		reason: input.reason ?? null,
		checks: input.checks,
		events: input.events ?? [],
		notes: input.notes ?? null,
		recorded_at: new Date().toISOString(),
		// 이 라운드를 기록할 때까지 쌓인 사용자 답 수. 마무리 확인 답이 그 뒤에 왔는지 셀 때 쓴다.
		answers_seen: readAnswers(root, sid).length,
	};
	if (previous) state.rounds[state.rounds.indexOf(previous)] = record;
	else state.rounds.push(record);

	// 이 라운드를 넣은 뒤에 계산한다. AI 대리 답 비율(최저선)에 이번 라운드가 바로 반영되게 하기 위해서다.
	const evaluation = evaluateState(state);
	Object.assign(record, { ambiguity_raw: evaluation.raw, floor: evaluation.floor, ambiguity: evaluation.ambiguity });

	state.current_ambiguity = evaluation.ambiguity;
	state.milestone = milestoneFor(evaluation.ambiguity, state.threshold);

	let autoStreak = 0;
	for (let i = state.rounds.length - 1; i >= 0 && state.rounds[i].answer_source === "auto"; i -= 1) autoStreak += 1;
	// 정체: 기준을 아직 못 넘었는데 최근 3라운드 동안 모호도가 거의 안 움직였거나, 덩어리 수에 비해 라운드가 많이 지났는데도 높다.
	// 덩어리가 많으면 한 라운드에 전체 평균이 조금씩만 내려가므로 라운드 기준을 덩어리 수에 맞춘다.
	const activeCount = state.components.filter(c => c.status !== "deferred").length;
	const recent = state.rounds.slice(-3).map(round => round.ambiguity);
	const stalled =
		!evaluation.threshold_met &&
		((recent.length === 3 && Math.max(...recent) - Math.min(...recent) <= 0.05) || (roundNumber >= Math.max(8, 3 * activeCount) && evaluation.ambiguity > 0.3));

	writeState(root, sid, state);
	return {
		ok: true,
		round: roundNumber,
		retracted: Boolean(retracted),
		scores: scoreTable(state),
		ambiguity_before: before,
		ambiguity_raw: evaluation.raw,
		floor: evaluation.floor,
		floor_reasons: evaluation.floor_reasons,
		ambiguity: evaluation.ambiguity,
		clamped_by_floor: evaluation.clamped,
		threshold: state.threshold,
		threshold_met: evaluation.threshold_met,
		per_component: evaluation.per_component,
		lagging_components: evaluation.lagging,
		milestone: state.milestone,
		milestone_changed: beforeMilestone !== state.milestone ? `${beforeMilestone} → ${state.milestone}` : null,
		must_ask_user: autoStreak >= 3,
		rethink_core: stalled,
		hard_cap: roundNumber >= HARD_CAP_ROUNDS,
		components: componentProgress(state),
		next: suggestNext(state),
	};
}

/** 기준값에 닿기 전에 끝내기로 했을 때 표시한다. 3라운드 이후(또는 최대 라운드)에만 허용한다. */
function cmdEarlyExit(root, sid) {
	const state = requireActive(root, sid);
	const rounds = state.rounds.length;
	if (rounds < EARLY_EXIT_MIN_ROUNDS && rounds < HARD_CAP_ROUNDS) {
		fail(`조기 종료는 ${EARLY_EXIT_MIN_ROUNDS}라운드부터 가능합니다. 지금까지 ${rounds}라운드입니다`);
	}
	state.early_exit = true;
	writeState(root, sid, state);
	return { ok: true, early_exit: true, ...summary(root, sid, state) };
}

/** 현재 상태를 보여준다. 이어하기와 훅 동작 확인(answers_recorded)에 쓴다. */
function cmdStatus(root, sid) {
	const state = readState(root, sid);
	if (!state) return { ok: true, exists: false, active: false };
	return { ok: true, exists: true, ...summary(root, sid, state), next: isActive(state) ? suggestNext(state) : null, state };
}

/**
 * 인터뷰를 끝낸다. 기록은 남기고 차단만 푼다.
 * done(정상 종료)은 스펙 저장과 같은 조건을 통과해야 한다. 사용자가 그만둘 때는 cancelled를 쓴다.
 */
function cmdEnd(root, sid, flags) {
	const state = readState(root, sid);
	if (!state) return { ok: true, ended: false, active: false };
	const status = flags.status ?? "done";
	if (!["done", "cancelled"].includes(status)) fail("--status는 done 또는 cancelled여야 합니다");
	const wasActive = isActive(state);
	if (wasActive && status === "done") {
		const blocker = completionBlocker(root, sid, state);
		if (blocker) fail(`아직 정상 종료할 수 없습니다: ${blocker} 사용자가 그만두기로 했다면 --status cancelled를 쓰세요.`);
		// 정상 종료는 스펙 경로를 남겨야 한다. deep-build가 이 경로로 인터뷰 기록을 찾아 고정 항목·조기 종료를 대조한다.
		if (!isText(flags.spec)) fail("정상 종료(done)에는 --spec <저장한 스펙 경로>가 필요합니다");
		if (!fs.existsSync(path.resolve(root, flags.spec))) fail(`스펙 파일이 없습니다: ${flags.spec}. 먼저 스펙을 저장하세요`);
	}
	if (wasActive) {
		state.active = false;
		state.status = status;
		state.ended_at = new Date().toISOString();
		if (isText(flags.spec)) state.spec_path = flags.spec;
		writeState(root, sid, state);
	}
	return { ok: true, ended: wasActive, ...summary(root, sid, state) };
}

const COMMANDS = { start: cmdStart, scope: cmdScope, record: cmdRecord, "early-exit": cmdEarlyExit, status: cmdStatus, end: cmdEnd };

/** 명령을 실행하고 결과 객체를 돌려준다. 테스트에서도 이 함수를 직접 부른다. */
export function run(argv, cwd = process.cwd()) {
	const { command, flags } = parseArgs(argv);
	const handler = COMMANDS[command];
	if (!handler) fail(`알 수 없는 명령입니다: ${JSON.stringify(command)}. 가능한 명령: ${Object.keys(COMMANDS).join(", ")}`);
	if (!isText(flags.session)) fail("--session이 필요합니다");
	const root = projectRoot(isText(flags.root) ? flags.root : cwd);
	return handler(root, flags.session, flags);
}

// 직접 실행했을 때만 동작한다 (테스트에서 import할 때는 실행하지 않음).
if (process.argv[1]?.endsWith("interview.mjs")) {
	try {
		process.stdout.write(`${JSON.stringify(run(process.argv.slice(2)), null, 2)}\n`);
	} catch (error) {
		process.stdout.write(`${JSON.stringify({ ok: false, error: error.message }, null, 2)}\n`);
		process.exit(1);
	}
}
