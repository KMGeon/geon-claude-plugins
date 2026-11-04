#!/usr/bin/env node
// 딥 인터뷰 조서 명령. 인터뷰 상태 파일은 이 스크립트로만 바꾼다.
//
// 사용법 (모두 --session <세션ID> 필요):
//   start  --topic <주제> [--type greenfield|brownfield]   인터뷰 시작, 코드 수정 차단 시작
//   note   --input <JSON>     답 하나를 조서에 적는다 (진술, 구멍, 닫은 구멍, 모순). turn 0은 첫 조서(코드·첫 말 정리)
//   board                     조서 전체 보기 (이어하기, 낭독 전 확인)
//   review --input <JSON>     두 번째 형사가 조서만 보고 찾은 구멍을 기록. 없으면 서명 가능
//   sign   --slug <이름> --summary <한 문단> [--early]   서명 확인 → 스펙 생성 → 차단 해제
//   end    [--status cancelled]   용의자가 그만둘 때. 기록은 남기고 차단만 푼다
// --input은 JSON 문자열 또는 @파일경로. 결과는 JSON으로 출력하고, 실패하면 {"ok": false, "error": "..."}와 종료 코드 1.

import fs from "node:fs";
import path from "node:path";
import {
	AREAS,
	CONFIRM_LABELS,
	COSTS,
	DIR_NAME,
	HARD_CAP_TURNS,
	SOURCES,
	STATE_VERSION,
	TYPES,
	answersPath,
	areaCoverage,
	changedSince,
	counts,
	isActive,
	lastTurn,
	liveStatements,
	openGaps,
	projectRoot,
	readAnswers,
	readState,
	readinessBlocker,
	resolveRoot,
	reviewAfterLastTurn,
	signBlocker,
	specsDir,
	statePath,
	suggestNext,
	writeSessionIndex,
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

// 값을 받지 않는 플래그. 뒤에 오는 단어를 값으로 삼키지 않는다.
const BOOLEAN_FLAGS = new Set(["early"]);

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

/** `@경로`면 파일 내용을, 아니면 값 그대로. */
function readMaybeFile(raw, label) {
	if (typeof raw !== "string" || !raw) fail(`${label}이 필요합니다`);
	if (!raw.startsWith("@")) return raw;
	try {
		return fs.readFileSync(raw.slice(1), "utf8");
	} catch {
		fail(`${label} 파일을 읽을 수 없습니다: ${raw.slice(1)}`);
	}
}

/** `--input`을 JSON 객체로 읽는다. */
function readInput(flags) {
	const text = readMaybeFile(flags.input, "--input");
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
const asList = (value, label) => {
	if (value === undefined) return [];
	if (!Array.isArray(value)) fail(`${label}은(는) 배열이어야 합니다`);
	return value;
};
const normalizeText = value => String(value).replace(/\s+/g, " ").trim();

// =============================================================================
// 도우미
// =============================================================================

/** 진행 중인 인터뷰 상태를 읽는다. 없거나 끝났으면 거부한다. */
function requireActive(root, sid) {
	const state = readState(root, sid);
	if (!state) fail("이 세션에는 인터뷰 상태가 없습니다. 먼저 start를 실행하세요");
	if (!isActive(state)) fail(`이 세션의 인터뷰는 이미 끝났습니다 (상태: ${state.status})`);
	if ((state.version ?? 1) < STATE_VERSION) fail("이전 버전(체크리스트 방식)의 인터뷰 상태입니다. end --status cancelled로 끝내고 새로 시작하세요");
	return state;
}

/** 사용자 답을 받은 턴(첫 조서 turn 0은 제외). */
const realTurns = state => (state.turns ?? []).filter(turn => turn.turn > 0);

/** 명령 결과에 붙일 요약. */
function summary(root, sid, state) {
	return {
		active: state.active,
		status: state.status,
		topic: state.topic,
		type: state.type,
		turns: realTurns(state).length,
		counts: counts(state),
		answers_recorded: readAnswers(root, sid).length,
	};
}

/** 구멍 하나를 화면용으로 줄인다. */
const gapView = gap => ({ id: gap.id, text: gap.text, area: AREAS[gap.area], cost: gap.cost, why_cost: gap.why_cost ?? null });
/** 진술 하나를 화면용으로 줄인다. */
const statementView = statement => ({ id: statement.id, text: statement.text, area: AREAS[statement.area], status: statement.status, source: statement.source, fixed: statement.fixed ?? null });

/** 다음 질문 제안을 화면용으로. */
function nextView(state) {
	const next = suggestNext(state);
	if (!next) return null;
	if (next.kind === "dispute") return { kind: "dispute", statement: statementView(next.statement), claim: next.statement.dispute?.claim ?? null };
	if (next.kind === "gap") return { kind: "gap", gap: gapView(next.gap) };
	return next;
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

/** 근거 문장에 프로젝트 안에 실제로 있는 파일·폴더 경로가 하나라도 들어 있는지. 코드 출처 진술은 이게 있어야 받는다. */
function evidenceHasPath(root, evidence) {
	const realRoot = path.resolve(root);
	const tokens = String(evidence).match(/[\p{L}\p{N}_@./-]+/gu) ?? [];
	return tokens.some(token => {
		const cleaned = token.replace(/[.:]+$/, "");
		if (!/[\p{L}\p{N}]/u.test(cleaned) || !(cleaned.includes("/") || cleaned.includes("."))) return false;
		const abs = path.resolve(realRoot, cleaned);
		const rel = path.relative(realRoot, abs);
		if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return false; // 프로젝트 밖이나 루트 자체는 근거가 아니다
		return fs.existsSync(abs);
	});
}

// =============================================================================
// 명령: start
// =============================================================================

/** 인터뷰를 시작한다. 같은 세션에 끝난 인터뷰가 있으면 이름을 바꿔 보관하고 새로 만든다. */
function cmdStart(root, sid, flags) {
	const existing = readState(root, sid);
	if (isActive(existing)) {
		writeSessionIndex(sid, root);
		return { ok: true, already_active: true, ...summary(root, sid, existing) };
	}
	const type = flags.type ?? "greenfield";
	if (!TYPES.includes(type)) fail(`--type은 ${TYPES.join(" 또는 ")}여야 합니다`);
	if (existing) {
		const stamp = (existing.ended_at ?? existing.started_at ?? new Date().toISOString()).replace(/[:.]/g, "-");
		fs.renameSync(statePath(root, sid), statePath(root, sid).replace(/state\.json$/, `state-${stamp}.json`));
		if (fs.existsSync(answersPath(root, sid))) {
			fs.renameSync(answersPath(root, sid), answersPath(root, sid).replace(/answers\.jsonl$/, `answers-${stamp}.jsonl`));
		}
	}
	ensureGitignore(root);
	const state = {
		version: STATE_VERSION,
		session: sid,
		topic: isText(flags.topic) ? flags.topic : null,
		active: true,
		status: "interviewing",
		started_at: new Date().toISOString(),
		type,
		components: [],
		statements: [],
		gaps: [],
		turns: [],
		reviews: [],
		early_exit: false,
		answers_at_start: readAnswers(root, sid).length,
	};
	writeState(root, sid, state);
	writeSessionIndex(sid, root);
	return { ok: true, already_active: false, marker: "조서 | 확정 0 · 잠정 0 · 모순 0 · 구멍 0", ...summary(root, sid, state) };
}

// =============================================================================
// 명령: note
// =============================================================================

const nextId = (items, prefix) => `${prefix}${items.length + 1}`;

/** 진술 id로 살아 있는 진술을 찾는다. 없으면 거부. */
function liveById(state, id, label) {
	const statement = (state.statements ?? []).find(item => item.id === id);
	if (!statement) fail(`${label}: 없는 진술입니다: ${id}`);
	if (statement.status === "retracted") fail(`${label}: 이미 철회된 진술입니다: ${id}`);
	return statement;
}

/** 덩어리 목록을 갱신한다 (있으면 바꾸고 없으면 추가). 덩어리는 구멍·진술을 묶는 라벨일 뿐이다. */
function applyComponents(state, items) {
	for (const item of items) {
		if (!isText(item?.id) || /\s/.test(item.id)) fail("덩어리 id는 공백 없는 문자열이어야 합니다");
		const status = item.status ?? "active";
		if (!["active", "deferred"].includes(status)) fail(`덩어리 ${item.id}의 status는 active 또는 deferred여야 합니다`);
		const next = { id: item.id, name: isText(item.name) ? item.name : item.id, description: item.description ?? "", status, reason: item.reason ?? null };
		const at = state.components.findIndex(component => component.id === item.id);
		if (at >= 0) state.components[at] = { ...state.components[at], ...next };
		else state.components.push(next);
	}
}

/** 진술을 철회한다. */
function retract(statement, turn, reason, extra = {}) {
	Object.assign(statement, { status: "retracted", retracted_turn: turn, retracted_reason: reason, updated_turn: turn, ...extra });
}

/** 진술 하나를 적는다. 새 진술이면 추가, 같은 id면 다시 말한 것으로 보고 승격을 검토한다. 돌려주는 값은 그 진술. */
function applyStatement(root, state, input, turn, changed) {
	if (!isText(input?.text)) fail("statements의 항목마다 text가 필요합니다");
	if (!(input.area in AREAS)) fail(`statements.${input.id ?? "?"}: area는 ${Object.keys(AREAS).join(", ")} 중 하나여야 합니다`);
	const source = input.source ?? "inferred";
	if (!SOURCES.includes(source)) fail(`statements.${input.id ?? "?"}: source는 ${SOURCES.join(", ")} 중 하나여야 합니다`);
	if (source === "code" && !(isText(input.evidence) && evidenceHasPath(root, input.evidence))) {
		fail(`statements.${input.id ?? "?"}: 코드 출처(source: "code") 진술은 evidence에 프로젝트 안에 실제로 있는 파일 경로가 있어야 합니다`);
	}
	if (input.fixed !== undefined) {
		if (!isText(input.fixed) || /\s/.test(input.fixed) || !input.fixed.includes(":")) fail(`statements.${input.id ?? "?"}: fixed는 "종류:이름" 꼴의 공백 없는 ID여야 합니다`);
		const dup = state.statements.find(item => item.fixed === input.fixed && item.id !== input.id && item.status !== "retracted");
		if (dup) fail(`고정 항목 ID가 겹칩니다: ${input.fixed} (진술 ${dup.id})`);
	}
	if (input.component !== undefined && !state.components.some(component => component.id === input.component)) {
		fail(`statements.${input.id ?? "?"}: component는 덩어리 id 중 하나여야 합니다: ${input.component}`);
	}
	const text = normalizeText(input.text);
	const existing = isText(input.id) ? state.statements.find(item => item.id === input.id) : null;
	if (existing) {
		if (existing.status === "retracted") fail(`철회된 진술은 다시 쓸 수 없습니다: ${existing.id}. 새 진술로 적으세요`);
		if (existing.status === "disputed") fail(`모순 중인 진술은 resolve로 먼저 정리하세요: ${existing.id}`);
		if (normalizeText(existing.text) === text) {
			existing.times = (existing.times ?? 1) + 1;
		} else {
			if (existing.status === "confirmed") fail(`확정 진술의 내용은 바꿀 수 없습니다: ${existing.id}. 말이 바뀌었으면 disputes로 적고 resolve로 정리하세요`);
			existing.history = [...(existing.history ?? []), { text: existing.text, turn: existing.turn }];
			existing.text = text;
			existing.times = 1;
		}
		if (source === "user") existing.source = "user";
		if (isText(input.evidence)) existing.evidence = input.evidence;
		if (input.fixed !== undefined) existing.fixed = input.fixed;
		if (input.component !== undefined) existing.component = input.component;
		existing.updated_turn = turn;
		// 승격: 사용자가 직접 말했거나, 형사가 정리한 것을 두 번 이상 일관되게 말했으면 확정. 대신 정한 것(auto)은 서명 전엔 확정하지 않는다.
		const promote = existing.status === "tentative" && (existing.source === "user" || (existing.source !== "auto" && existing.times >= 2));
		if (promote) {
			existing.status = "confirmed";
			existing.confirmed_turn = turn;
			changed.promoted.push(existing.id);
		}
		changed.statements.push(existing.id);
		return existing;
	}
	if (isText(input.id) && /\s/.test(input.id)) fail("진술 id는 공백 없는 문자열이어야 합니다");
	const statement = {
		id: isText(input.id) ? input.id : nextId(state.statements, "s"),
		text,
		area: input.area,
		source,
		evidence: isText(input.evidence) ? input.evidence : null,
		status: source === "user" ? "confirmed" : "tentative",
		turn,
		updated_turn: turn,
		times: 1,
		...(input.fixed !== undefined ? { fixed: input.fixed } : {}),
		...(input.component !== undefined ? { component: input.component } : {}),
		...(source === "user" ? { confirmed_turn: turn } : {}),
	};
	if (state.statements.some(item => item.id === statement.id)) fail(`진술 id가 겹칩니다: ${statement.id}`);
	state.statements.push(statement);
	changed.statements.push(statement.id);
	return statement;
}

/** 구멍 하나를 연다. */
function openGap(state, input, turn, changed, extra = {}) {
	if (!isText(input?.text)) fail("gaps의 항목마다 text가 필요합니다");
	if (!(input.area in AREAS)) fail(`gaps.${input.id ?? "?"}: area는 ${Object.keys(AREAS).join(", ")} 중 하나여야 합니다`);
	const cost = input.cost ?? "mid";
	if (!COSTS.includes(cost)) fail(`gaps.${input.id ?? "?"}: cost는 ${COSTS.join(", ")} 중 하나여야 합니다`);
	if (input.component !== undefined && !state.components.some(component => component.id === input.component)) {
		fail(`gaps.${input.id ?? "?"}: component는 덩어리 id 중 하나여야 합니다: ${input.component}`);
	}
	if (isText(input.id) && /\s/.test(input.id)) fail("구멍 id는 공백 없는 문자열이어야 합니다");
	const gap = {
		id: isText(input.id) ? input.id : nextId(state.gaps, "g"),
		text: normalizeText(input.text),
		area: input.area,
		cost,
		why_cost: isText(input.why_cost) ? input.why_cost : null,
		status: "open",
		opened_turn: turn,
		closed_turn: null,
		closed_by: [],
		...(input.component !== undefined ? { component: input.component } : {}),
		...extra,
	};
	if (state.gaps.some(item => item.id === gap.id)) fail(`구멍 id가 겹칩니다: ${gap.id}`);
	state.gaps.push(gap);
	changed.gaps_opened.push(gap.id);
	return gap;
}

/**
 * 답 하나를 조서에 적는다. 적용 순서: 덩어리 → 철회 → 되돌림(reopen) → 모순 → 정리(resolve) → 진술 → 구멍 → 닫기.
 * turn 0은 첫 조서(코드와 첫 말로 만든 진술·구멍)이고 질문·답이 없다. 그 뒤는 1, 2, 3… 순서대로만 받는다.
 */
function cmdNote(root, sid, flags) {
	const state = requireActive(root, sid);
	const input = readInput(flags);
	const turn = input.turn;
	const last = lastTurn(state);
	if (!Number.isInteger(turn) || turn < 0) fail("turn은 0 이상의 정수여야 합니다");
	if (turn === 0) {
		if ((state.turns ?? []).length > 0) fail("turn 0(첫 조서)은 처음 한 번만 쓸 수 있습니다");
	} else {
		if (turn !== last + 1) fail(`다음 턴 번호는 ${last + 1}입니다 (같은 턴을 다시 적을 수 없습니다. 잘못 적은 진술은 retract, 바뀐 말은 disputes로)`);
		if (!isText(input.question) || !isText(input.answer)) fail("turn 1부터는 question과 answer가 필요합니다");
	}
	const source = input.answer_source ?? "user";
	if (!["user", "auto"].includes(source)) fail("answer_source는 user 또는 auto여야 합니다");
	if (state.statements.some(s => s.status === "disputed") && turn > 0 && asList(input.resolve, "resolve").length === 0) {
		// 모순이 남아 있으면 그 턴은 모순 정리여야 한다. 다른 질문으로 넘어가지 못하게 막는다.
		fail(`모순이 남아 있습니다 (${state.statements.filter(s => s.status === "disputed").map(s => s.id).join(", ")}). 이 턴은 어느 쪽이 맞는지 묻고 resolve로 정리해야 합니다`);
	}

	const changed = { statements: [], promoted: [], gaps_opened: [], gaps_closed: [], retracted: [], disputed: [], resolved: [] };
	applyComponents(state, asList(input.components, "components"));

	for (const id of asList(input.retract, "retract")) {
		retract(liveById(state, id, "retract"), turn, "retracted");
		changed.retracted.push(id);
	}
	for (const id of asList(input.reopen, "reopen")) {
		const statement = liveById(state, id, "reopen");
		retract(statement, turn, "reopened");
		changed.retracted.push(id);
		openGap(state, { text: statement.text, area: statement.area, cost: "high", why_cost: "낭독에서 용의자가 아니라고 함", component: statement.component }, turn, changed, { from_statement: id });
	}
	for (const item of asList(input.disputes, "disputes")) {
		const statement = liveById(state, item?.statement, "disputes");
		if (!isText(item.claim)) fail(`disputes.${item.statement}: claim(지금 한 말)이 필요합니다`);
		if (statement.status === "disputed") fail(`이미 모순으로 적힌 진술입니다: ${statement.id}`);
		statement.before_dispute = statement.status;
		statement.status = "disputed";
		statement.dispute = { claim: normalizeText(item.claim), turn };
		statement.updated_turn = turn;
		changed.disputed.push(statement.id);
	}
	for (const item of asList(input.resolve, "resolve")) {
		const statement = liveById(state, item?.statement, "resolve");
		if (statement.status !== "disputed") fail(`모순이 아닌 진술은 resolve할 수 없습니다: ${statement.id}`);
		if (!["old", "new"].includes(item.keep)) fail(`resolve.${statement.id}: keep은 old(원래 말) 또는 new(지금 말)여야 합니다`);
		const dispute = statement.dispute ?? { claim: null };
		statement.resolved = [...(statement.resolved ?? []), { ...dispute, keep: item.keep, resolved_turn: turn }];
		delete statement.dispute;
		delete statement.before_dispute;
		if (item.keep === "old") {
			// 용의자가 원래 말을 다시 확인했다 → 확정.
			Object.assign(statement, { status: "confirmed", source: "user", times: (statement.times ?? 1) + 1, confirmed_turn: turn, updated_turn: turn });
			changed.resolved.push({ statement: statement.id, keep: "old" });
		} else {
			const text = isText(item.text) ? item.text : dispute.claim;
			if (!isText(text)) fail(`resolve.${statement.id}: 새 진술 text가 필요합니다`);
			const replacement = applyStatement(root, state, { text, area: statement.area, source: "user", fixed: statement.fixed, component: statement.component }, turn, changed);
			retract(statement, turn, "superseded", { superseded_by: replacement.id });
			changed.resolved.push({ statement: statement.id, keep: "new", replacement: replacement.id });
		}
	}
	for (const item of asList(input.statements, "statements")) applyStatement(root, state, item, turn, changed);
	for (const item of asList(input.gaps, "gaps")) openGap(state, item, turn, changed);
	for (const item of asList(input.close, "close")) {
		const gap = state.gaps.find(g => g.id === item?.gap);
		if (!gap) fail(`close: 없는 구멍입니다: ${item?.gap}`);
		if (gap.status !== "open") fail(`close: 이미 닫힌 구멍입니다: ${gap.id}`);
		const by = asList(item.by, `close.${gap.id}.by`);
		if (by.length === 0) fail(`close.${gap.id}: 어느 진술로 닫는지 by에 진술 id를 적으세요`);
		for (const id of by) liveById(state, id, `close.${gap.id}.by`);
		Object.assign(gap, { status: "closed", closed_turn: turn, closed_by: by });
		changed.gaps_closed.push(gap.id);
	}
	for (const id of asList(input.planted, "planted")) liveById(state, id, "planted");

	state.turns.push({
		turn,
		question: turn === 0 ? null : input.question,
		answer: turn === 0 ? null : input.answer,
		answer_source: turn === 0 ? null : source,
		planted: asList(input.planted, "planted"),
		note: isText(input.note) ? input.note : null,
		counts: null,
		recorded_at: new Date().toISOString(),
		// 이 턴을 적을 때까지 쌓인 사용자 답 수. 서명 답이 그 뒤에 왔는지 셀 때 쓴다.
		answers_seen: readAnswers(root, sid).length,
	});
	state.turns.at(-1).counts = counts(state);

	let autoStreak = 0;
	for (let i = state.turns.length - 1; i >= 0 && state.turns[i].answer_source === "auto"; i -= 1) autoStreak += 1;

	writeState(root, sid, state);
	const open = openGaps(state);
	return {
		ok: true,
		turn,
		counts: counts(state),
		changed,
		open_gaps: open.slice(0, 5).map(gapView),
		open_gaps_total: open.length,
		coverage: areaCoverage(state),
		next: nextView(state),
		ready_for_review: readinessBlocker(state) === null,
		must_ask_user: autoStreak >= 3,
		hard_cap: turn >= HARD_CAP_TURNS,
	};
}

// =============================================================================
// 명령: board, review
// =============================================================================

/** 조서 전체. 이어하기와 낭독 전 확인, 훅 동작 확인(answers_recorded)에 쓴다. */
function cmdBoard(root, sid) {
	const state = readState(root, sid);
	if (!state) return { ok: true, exists: false, active: false };
	const review = (state.reviews ?? []).at(-1) ?? null;
	return {
		ok: true,
		exists: true,
		...summary(root, sid, state),
		components: state.components ?? [],
		statements: liveStatements(state).map(statementView),
		retracted: (state.statements ?? []).filter(s => s.status === "retracted").map(s => ({ id: s.id, text: s.text, reason: s.retracted_reason, superseded_by: s.superseded_by ?? null })),
		open_gaps: openGaps(state).map(gapView),
		coverage: areaCoverage(state),
		next: isActive(state) ? nextView(state) : null,
		readiness_blocker: isActive(state) ? readinessBlocker(state) : null,
		review: review ? { turn: review.turn, new_gaps: review.new_gaps, note: review.note } : null,
		changed_since_review: review ? changedSince(state, review.turn) : null,
		state,
	};
}

/**
 * 두 번째 형사 검토를 기록한다. 낭독 조건(구멍 0·모순 0·항목마다 진술)이 맞을 때만 받는다.
 * 새 구멍이 있으면 열고 질문 루프로 돌아간다. 없으면 서명할 수 있다.
 */
function cmdReview(root, sid, flags) {
	const state = requireActive(root, sid);
	const blocker = readinessBlocker(state);
	if (blocker) fail(`아직 두 번째 형사를 부를 때가 아닙니다: ${blocker}`);
	const input = readInput(flags);
	const turn = lastTurn(state);
	const changed = { statements: [], promoted: [], gaps_opened: [], gaps_closed: [], retracted: [], disputed: [], resolved: [] };
	for (const item of asList(input.new_gaps, "new_gaps")) openGap(state, item, turn, changed, { from_review: true });
	state.reviews.push({ turn, new_gaps: changed.gaps_opened, note: isText(input.note) ? input.note : null, at: new Date().toISOString(), answers_seen: readAnswers(root, sid).length });
	writeState(root, sid, state);
	return {
		ok: true,
		turn,
		new_gaps: changed.gaps_opened.map(id => gapView(state.gaps.find(g => g.id === id))),
		ready_to_sign: changed.gaps_opened.length === 0,
		counts: counts(state),
		next: nextView(state),
	};
}

// =============================================================================
// 명령: sign (스펙 생성)
// =============================================================================

const SPEC_SUFFIX = " — 딥 인터뷰 스펙";
const bullet = items => (items.length ? items.map(text => `- ${text}`) : ["- 없음"]);
const STATUS_LABEL = { confirmed: "확정", tentative: "잠정", disputed: "모순", retracted: "철회" };
const SOURCE_LABEL = { user: "용의자 말", inferred: "형사 정리", code: "코드", auto: "형사가 대신 정함" };

/** 조서를 스펙 마크다운으로 찍는다. deep-build·deep-goal이 읽는 줄(고정 항목, 다 됐다는 기준, 결과, 지킬 조건, 하지 않을 것)은 양식을 지킨다. */
export function renderSpec(state, { summary, early, date = new Date().toISOString().slice(0, 10) }) {
	const live = liveStatements(state).filter(s => s.status === "confirmed");
	const byArea = area => live.filter(s => s.area === area).map(s => s.text);
	const fixed = live.filter(s => s.fixed);
	const open = openGaps(state);
	const disputed = liveStatements(state).filter(s => s.status === "disputed");
	const signedCount = live.filter(s => s.signed === true).length;
	const autoCount = live.filter(s => s.source === "auto").length;
	const components = state.components ?? [];
	const title = state.topic ?? "(주제 없음)";
	const lines = [
		`# ${title}${SPEC_SUFFIX}`,
		"",
		"## 한눈에 보기",
		`- 한 문장 요약: ${normalizeText(summary)}`,
		`- 결과: ${early ? "기준 미달로 조기 종료" : "기준 통과"}`,
		`- 조서: 확정 ${live.length} (서명으로 확정 ${signedCount} 포함) · 남은 질문 ${open.length + disputed.length}`,
		`- 턴: ${realTurns(state).length}`,
		`- 종류: ${state.type === "brownfield" ? "기존 코드 고치기" : "새로 만들기"}`,
		`- 형사가 대신 정한 진술: ${autoCount}개`,
		`- 날짜: ${date}`,
		"",
		"## 무엇을 만드나",
		summary.trim(),
		"",
	];
	if (components.length) {
		lines.push("| 덩어리 | 상태 | 설명 |", "|:---|:---:|:---|");
		for (const c of components) lines.push(`| ${c.name} | ${c.status === "deferred" ? "미룸" : "진행"} | ${c.description}${c.reason ? ` (${c.reason})` : ""} |`);
		lines.push("");
	}
	lines.push("**고정 항목**", ...(fixed.length ? fixed.map(s => `- \`${s.fixed}\` — ${s.text}`) : ["- 없음"]), "");
	lines.push("## 왜", ...bullet(byArea("why")), "");
	lines.push("## 무엇", ...bullet(byArea("what")), "");
	lines.push("## 경계", "**지킬 조건**", ...bullet(byArea("keep")), "", "**하지 않을 것**", ...bullet(byArea("avoid")), "");
	lines.push("## 다 됐다는 기준", ...byArea("done").map(text => `- [ ] ${text}`), "");
	const remaining = [
		...open.map(gap => `[ ] ${gap.text} — ${AREAS[gap.area]}${gap.why_cost ? `, 틀리면: ${gap.why_cost}` : ""}`),
		...disputed.map(s => `[ ] 모순 미정리: "${s.text}" vs "${s.dispute?.claim ?? "?"}" — ${AREAS[s.area]}`),
	];
	lines.push("## 남은 질문", ...bullet(remaining), "");
	const code = live.filter(s => s.area === "code");
	lines.push("## 코드에서 확인한 것", ...bullet(code.map(s => `${s.text}${s.evidence ? ` (근거: ${s.evidence})` : ""}`)), "");
	lines.push("## 조서", "", "| 번호 | 항목 | 내용 | 출처 | 상태 | 턴 |", "|:---|:---|:---|:---|:---:|---:|");
	for (const s of state.statements ?? []) {
		const status = s.status === "retracted" ? `철회(${s.retracted_reason === "superseded" ? `→ ${s.superseded_by}` : s.retracted_reason === "reopened" ? "되물음" : "오기"})` : s.signed ? "서명 확정" : STATUS_LABEL[s.status];
		lines.push(`| ${s.id} | ${AREAS[s.area]} | ${s.text.replace(/\|/g, "\\|")} | ${SOURCE_LABEL[s.source]} | ${status} | ${s.turn} |`);
	}
	lines.push("");
	const turns = realTurns(state);
	lines.push("## 문답 기록", "<details>", `<summary>${turns.length} 턴</summary>`, "");
	for (const t of turns) {
		lines.push(`### 턴 ${t.turn}`, `- 질문: ${t.question}`, `- 답${t.answer_source === "auto" ? " (형사가 대신)" : ""}: ${t.answer}`, `- 조서: 확정 ${t.counts?.confirmed ?? "?"} · 잠정 ${t.counts?.tentative ?? "?"} · 모순 ${t.counts?.disputed ?? "?"} · 구멍 ${t.counts?.gaps ?? "?"}`, "");
	}
	lines.push("</details>", "");
	return lines.join("\n");
}

/**
 * 서명을 확인하고 스펙을 만든 뒤 인터뷰를 끝낸다. 잠정 진술은 서명으로 전부 확정된다.
 * 조기 종료(--early)면 남은 구멍이 "남은 질문"으로 들어가고 결과 줄이 "기준 미달로 조기 종료"가 된다.
 */
function cmdSign(root, sid, flags) {
	const state = requireActive(root, sid);
	const early = flags.early === true;
	const slug = flags.slug;
	if (!isText(slug) || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)) fail("--slug <이름>이 필요합니다 (영어 소문자·숫자·하이픈, 예: leave-request)");
	const summary_ = readMaybeFile(flags.summary, "--summary");
	if (!isText(summary_)) fail("--summary <한 문단 요약>이 필요합니다 (길면 @파일경로)");
	const blocker = signBlocker(root, sid, state, { early });
	if (blocker) fail(`아직 서명할 수 없습니다: ${blocker}`);
	const specRel = path.join(DIR_NAME, "specs", `deep-interview-${slug}.md`);
	const specAbs = path.join(root, specRel);
	if (fs.existsSync(specAbs)) fail(`스펙 파일이 이미 있습니다: ${specRel}. 다른 --slug를 쓰세요`);

	const turn = lastTurn(state);
	const signed = [];
	for (const statement of liveStatements(state)) {
		if (statement.status !== "tentative") continue;
		Object.assign(statement, { status: "confirmed", signed: true, confirmed_turn: turn, updated_turn: turn });
		signed.push(statement.id);
	}
	const confirmed = liveStatements(state).filter(s => s.status === "confirmed");
	state.fixed_items = confirmed.filter(s => s.fixed).map(s => ({ id: s.fixed, statement: s.text, ...(s.component ? { component: s.component } : {}) }));
	state.summary = normalizeText(summary_);
	state.early_exit = early;
	state.signed_at = new Date().toISOString();
	state.active = false;
	state.status = "done";
	state.ended_at = state.signed_at;
	state.spec_path = specRel;

	fs.mkdirSync(specsDir(root), { recursive: true });
	fs.writeFileSync(specAbs, renderSpec(state, { summary: summary_, early }));
	writeState(root, sid, state);
	return {
		ok: true,
		spec_path: specRel,
		early_exit: early,
		signed_statements: signed,
		fixed_items: state.fixed_items.map(item => item.id),
		criteria: confirmed.filter(s => s.area === "done").length,
		open_questions: openGaps(state).length + liveStatements(state).filter(s => s.status === "disputed").length,
		...summary(root, sid, state),
	};
}

// =============================================================================
// 명령: end
// =============================================================================

/** 용의자가 그만둘 때. 기록은 남기고 차단만 푼다. 정상 종료는 sign으로만 한다. */
function cmdEnd(root, sid, flags) {
	const state = readState(root, sid);
	if (!state) return { ok: true, ended: false, active: false };
	const status = flags.status ?? "cancelled";
	if (status === "done") fail("정상 종료는 sign --slug <이름> --summary <요약>으로 합니다 (스펙을 코드가 만듭니다)");
	if (status !== "cancelled") fail("--status는 cancelled만 받습니다");
	const wasActive = isActive(state);
	if (wasActive) {
		state.active = false;
		state.status = "cancelled";
		state.ended_at = new Date().toISOString();
		writeState(root, sid, state);
	}
	return { ok: true, ended: wasActive, active: state.active, status: state.status, topic: state.topic };
}

const COMMANDS = { start: cmdStart, note: cmdNote, board: cmdBoard, review: cmdReview, sign: cmdSign, end: cmdEnd };

/** 명령을 실행하고 결과 객체를 돌려준다. 테스트에서도 이 함수를 직접 부른다. */
export function run(argv, cwd = process.cwd()) {
	const { command, flags } = parseArgs(argv);
	const handler = COMMANDS[command];
	if (!handler) fail(`알 수 없는 명령입니다: ${JSON.stringify(command)}. 가능한 명령: ${Object.keys(COMMANDS).join(", ")}`);
	if (!isText(flags.session)) fail("--session이 필요합니다");
	// --root가 없으면 세션 색인을 먼저 본다: 이 세션의 진행 중인 인터뷰·빌드가 있는 루트면 cwd가 바뀌었어도 그 루트를 쓴다.
	const root = isText(flags.root) ? projectRoot(flags.root) : resolveRoot(flags.session, cwd);
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
