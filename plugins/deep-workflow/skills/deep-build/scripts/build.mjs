#!/usr/bin/env node
// deep-build 상태 명령. 딥 인터뷰 스펙을 받아 설계 문서 → 계획 → 검토까지 진행하는 상태를 관리한다.
// 계획과 상태 파일은 이 스크립트로만 쓴다 (훅이 직접 쓰기를 막는다).
//
// 사용법 (모두 --session <세션ID> 필요):
//   start  --spec <스펙 경로> [--force]       스펙을 해석해 빌드 상태를 만든다. 기준 미달 스펙은 --force가 있어야 한다
//   design --file <설계 문서 경로>              설계 문서 4종(시퀀스·상태·ERD·API)이 있거나 생략 이유가 있는지 검사하고 등록
//   plan   --input <JSON 또는 @경로>            작업 목록을 검사(고정 항목·완료 기준 연결)하고 계획 파일을 쓴다
//   review --input <JSON 또는 @경로>            검토 결과를 기록한다. 통과면 planned, 3회 넘게 수정이면 stuck
//   execute                                     (2단계) 구현 시작. 작업 수로 방식을 정하고 의존 순서를 돌려준다
//   task-done --task <id> --cmd "<테스트 명령>"   코드가 테스트 명령을 실행해 종료 코드 0일 때만 작업 완료
//   task-review --task <id> --input <JSON>      (에이전트 방식) 리뷰 에이전트 판정 기록. revise도 실패로 센다
//   verify --input <JSON>                       완료 기준(AC)마다 증거 명령을 코드가 실행, 전부 0이어야 통과
//   final-review --input <JSON>                 새 에이전트의 전체 리뷰. pass면 done
//   status                                      현재 상태
// 결과는 JSON. 실패하면 {"ok": false, "error": "..."}와 종료 코드 1.

import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

export const DIR_NAME = ".deep-interview";
const MAX_REVIEW_ROUNDS = 3;
const MAX_TASK_ATTEMPTS = 3;
const SINGLE_SESSION_MAX_TASKS = 3;
const DESIGN_SECTIONS = ["시퀀스", "상태", "ERD", "API"];
const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;

class CliError extends Error {}
const fail = message => {
	throw new CliError(message);
};
const isText = value => typeof value === "string" && value.trim().length > 0;

// =============================================================================
// 인자·경로
// =============================================================================

/** `<명령> --키 값 --플래그` 형태를 { command, flags }로 바꾼다. */
function parseArgs(argv) {
	const [command, ...rest] = argv;
	const flags = {};
	const boolean = new Set(["force"]);
	for (let i = 0; i < rest.length; i += 1) {
		const token = rest[i];
		if (!token.startsWith("--")) fail(`알 수 없는 인자입니다: ${token}`);
		const key = token.slice(2);
		const next = rest[i + 1];
		if (boolean.has(key) || next === undefined || next.startsWith("--")) flags[key] = true;
		else {
			flags[key] = next;
			i += 1;
		}
	}
	return { command, flags };
}

/** `--input`을 읽는다. `@경로`면 파일 내용. */
function readInput(flags) {
	const raw = flags.input;
	if (!isText(raw)) fail("--input이 필요합니다");
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

/** 세션 ID를 폴더 이름으로 써도 안전한지 확인한다. */
export function assertSessionId(sessionId) {
	if (typeof sessionId !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(sessionId) || sessionId.startsWith(".")) {
		throw new Error(`세션 ID가 올바르지 않습니다: ${JSON.stringify(sessionId)}`);
	}
	return sessionId;
}

/** 프로젝트 루트: git 최상위 → 상위의 .deep-interview → cwd. deep-interview와 같은 규칙. */
export function projectRoot(cwd = process.cwd()) {
	try {
		const top = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
		if (top) return top;
	} catch {}
	let dir = path.resolve(cwd);
	for (;;) {
		try {
			if (fs.statSync(path.join(dir, DIR_NAME)).isDirectory()) return dir;
		} catch {}
		const parent = path.dirname(dir);
		if (parent === dir) return path.resolve(cwd);
		dir = parent;
	}
}

const buildsDir = root => path.join(root, DIR_NAME, "builds");
const plansDir = root => path.join(root, DIR_NAME, "plans");
export const statePath = (root, sid) => path.join(buildsDir(root), `${assertSessionId(sid)}.json`);

export function readState(root, sid) {
	try {
		return JSON.parse(fs.readFileSync(statePath(root, sid), "utf8"));
	} catch {
		return null;
	}
}

function writeState(root, sid, state) {
	const file = statePath(root, sid);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify({ ...state, updated_at: new Date().toISOString() }, null, 2)}\n`);
	fs.renameSync(tmp, file);
}

/** 프로젝트 루트 기준 상대 경로 (OS와 상관없이 `/` 구분자). */
const relative = (root, file) => path.relative(root, file).split(path.sep).join("/");

// =============================================================================
// 스펙 해석
// =============================================================================

/**
 * 딥 인터뷰 스펙(markdown)에서 코드가 필요한 것만 뽑는다.
 * - 고정 항목: "**고정 항목**" 아래 "- `ID` — 설명" 줄
 * - 완료 기준: "## 다 됐다는 기준" 아래 "- [ ] ..." 줄. 순서대로 AC-1, AC-2… id를 붙인다
 * - 결과: "- 결과: 기준 통과" 여부
 * - 제목, 한 문장 요약
 */
export function parseSpec(markdown) {
	const lines = markdown.split("\n");
	const title = (lines.find(line => line.startsWith("# ")) ?? "# (제목 없음)").slice(2).replace(/\s*—\s*딥 인터뷰 스펙\s*$/, "").trim();
	const summary = lines.find(line => /^- 한 문장 요약:/.test(line))?.replace(/^- 한 문장 요약:\s*/, "").trim() ?? null;
	const resultLine = lines.find(line => /^- 결과:/.test(line)) ?? "";
	const passed = /기준 통과/.test(resultLine);

	const fixedItems = [];
	const criteria = [];
	let mode = null;
	for (const line of lines) {
		if (/^\*\*고정 항목\*\*/.test(line)) {
			mode = "fixed";
			continue;
		}
		if (/^## 다 됐다는 기준/.test(line)) {
			mode = "criteria";
			continue;
		}
		if (/^## /.test(line) || /^\*\*[^*]+\*\*\s*$/.test(line)) {
			if (mode) mode = null;
			continue;
		}
		if (mode === "fixed") {
			const m = line.match(/^- `([^`]+)`\s*(?:—|-|:)?\s*(.*)$/);
			if (m) fixedItems.push({ id: m[1].trim(), statement: m[2].trim() });
		} else if (mode === "criteria") {
			const m = line.match(/^- \[[ xX]\]\s*(.+)$/);
			if (m) criteria.push({ id: `AC-${criteria.length + 1}`, text: m[1].trim() });
		}
	}
	return { title, summary, passed, fixed_items: fixedItems, criteria };
}

// =============================================================================
// 설계 문서 검사
// =============================================================================

/**
 * 설계 문서는 시퀀스·상태·ERD·API 네 절이 모두 있어야 한다.
 * 각 절은 Mermaid 블록이나 표가 있거나, "생략:"으로 시작하는 이유 한 줄이 있어야 한다.
 * 문제가 없으면 [], 있으면 문제 문자열 목록.
 */
export function checkDesign(markdown) {
	const problems = [];
	const headings = [...markdown.matchAll(/^## +(.+)$/gm)].map(m => ({ name: m[1].trim(), index: m.index }));
	for (const name of DESIGN_SECTIONS) {
		const at = headings.findIndex(h => h.name.startsWith(name));
		if (at < 0) {
			problems.push(`"## ${name}" 절이 없습니다`);
			continue;
		}
		const start = headings[at].index;
		const end = headings[at + 1]?.index ?? markdown.length;
		const body = markdown.slice(start, end);
		const hasMermaid = /```mermaid/.test(body);
		const hasTable = /^\|.*\|\s*$/m.test(body);
		const hasSkip = /^생략\s*[:：]\s*\S/m.test(body);
		if (name === "API" ? !(hasTable || hasMermaid || hasSkip) : !(hasMermaid || hasSkip)) {
			problems.push(`"## ${name}" 절에 ${name === "API" ? "표" : "Mermaid 블록"}도, "생략: <이유>" 한 줄도 없습니다`);
		}
	}
	return problems;
}

// =============================================================================
// 계획 검사·렌더
// =============================================================================

/**
 * 계획 JSON을 검사한다. 모든 고정 항목 ID와 완료 기준 ID에 담당 작업이 있어야 한다.
 * tasks[]: { id, title, files[], interface, test, covers: { fixed[], criteria[] }, depends_on[] }
 */
export function checkPlan(plan, spec) {
	const problems = [];
	const tasks = Array.isArray(plan.tasks) ? plan.tasks : [];
	if (tasks.length === 0) problems.push("tasks에 작업이 하나 이상 있어야 합니다");
	const ids = new Set();
	const fixedIds = new Set(spec.fixed_items.map(item => item.id));
	const criteriaIds = new Set(spec.criteria.map(item => item.id));
	const coveredFixed = new Set();
	const coveredCriteria = new Set();

	for (const [index, task] of tasks.entries()) {
		const label = task?.id ?? `tasks[${index}]`;
		if (!isText(task?.id)) problems.push(`${label}: id가 필요합니다`);
		else if (ids.has(task.id)) problems.push(`${label}: id가 겹칩니다`);
		else ids.add(task.id);
		if (!isText(task?.title)) problems.push(`${label}: title이 필요합니다`);
		if (!Array.isArray(task?.files) || task.files.length === 0 || !task.files.every(isText)) problems.push(`${label}: files에 고칠 파일이 하나 이상 있어야 합니다`);
		if (!isText(task?.interface)) problems.push(`${label}: interface(이름·시그니처·입출력)가 필요합니다`);
		if (!isText(task?.test)) problems.push(`${label}: test(먼저 실패할 테스트)가 필요합니다`);
		for (const id of task?.covers?.fixed ?? []) {
			if (!fixedIds.has(id)) problems.push(`${label}: 스펙에 없는 고정 항목 ${id}`);
			else coveredFixed.add(id);
		}
		for (const id of task?.covers?.criteria ?? []) {
			if (!criteriaIds.has(id)) problems.push(`${label}: 스펙에 없는 완료 기준 ${id}`);
			else coveredCriteria.add(id);
		}
	}
	for (const task of tasks) {
		for (const dep of task?.depends_on ?? []) {
			if (!ids.has(dep)) problems.push(`${task.id}: depends_on의 ${dep}는 없는 작업입니다`);
			if (dep === task.id) problems.push(`${task.id}: 자기 자신에 의존할 수 없습니다`);
		}
	}
	const missingFixed = [...fixedIds].filter(id => !coveredFixed.has(id));
	const missingCriteria = [...criteriaIds].filter(id => !coveredCriteria.has(id));
	if (missingFixed.length) problems.push(`담당 작업이 없는 고정 항목: ${missingFixed.join(", ")}`);
	if (missingCriteria.length) problems.push(`담당 작업이 없는 완료 기준: ${missingCriteria.join(", ")}`);
	return problems;
}

/** 계획을 사람이 읽는 markdown으로 만든다. */
function renderPlan(plan, spec, meta) {
	const lines = [];
	lines.push(`# ${spec.title} — 구현 계획`, "");
	lines.push(`- 스펙: ${meta.spec_path}`, `- 설계: ${meta.design_path}`, `- 작업 수: ${plan.tasks.length}`, `- 날짜: ${meta.date}`, "");
	if (spec.summary) lines.push(`> ${spec.summary}`, "");
	lines.push("## 작업 목록", "", "| 순서 | id | 작업 | 고칠 파일 | 의존 |", "|---:|:---|:---|:---|:---|");
	plan.tasks.forEach((task, i) => {
		lines.push(`| ${i + 1} | ${task.id} | ${task.title} | ${task.files.map(f => `\`${f}\``).join(", ")} | ${(task.depends_on ?? []).join(", ") || "-"} |`);
	});
	lines.push("", "## 작업 상세", "");
	for (const task of plan.tasks) {
		lines.push(`### ${task.id} ${task.title}`, "");
		lines.push(`- 고칠 파일: ${task.files.map(f => `\`${f}\``).join(", ")}`);
		lines.push(`- 인터페이스: ${task.interface}`);
		lines.push(`- 먼저 실패할 테스트: ${task.test}`);
		if (task.notes) lines.push(`- 메모: ${task.notes}`);
		const fixed = task.covers?.fixed ?? [];
		const criteria = task.covers?.criteria ?? [];
		lines.push(`- 담당: ${[...fixed.map(id => `\`${id}\``), ...criteria].join(", ") || "-"}`, "");
	}
	lines.push("## 연결 표", "", "| 스펙 항목 | 내용 | 담당 작업 |", "|:---|:---|:---|");
	for (const item of spec.fixed_items) {
		const owners = plan.tasks.filter(t => (t.covers?.fixed ?? []).includes(item.id)).map(t => t.id);
		lines.push(`| \`${item.id}\` | ${item.statement} | ${owners.join(", ")} |`);
	}
	for (const item of spec.criteria) {
		const owners = plan.tasks.filter(t => (t.covers?.criteria ?? []).includes(item.id)).map(t => t.id);
		lines.push(`| ${item.id} | ${item.text} | ${owners.join(", ")} |`);
	}
	lines.push("");
	return lines.join("\n");
}

// =============================================================================
// 명령
// =============================================================================

function requireState(root, sid) {
	return readState(root, sid) ?? fail("이 세션에는 빌드 상태가 없습니다. 먼저 start를 실행하세요");
}

function summary(state) {
	return {
		status: state.status,
		slug: state.slug,
		spec_path: state.spec_path,
		design_path: state.design_path ?? null,
		plan_path: state.plan_path ?? null,
		review_rounds: (state.reviews ?? []).length,
		fixed_items: state.spec.fixed_items.map(item => item.id),
		criteria: state.spec.criteria,
	};
}

/** 스펙을 읽어 빌드 상태를 만든다. */
function cmdStart(root, sid, flags) {
	if (!isText(flags.spec)) fail("--spec <스펙 경로>가 필요합니다");
	const abs = path.resolve(root, flags.spec);
	if (!fs.existsSync(abs)) fail(`스펙 파일이 없습니다: ${flags.spec}`);
	const spec = parseSpec(fs.readFileSync(abs, "utf8"));
	if (!spec.passed && flags.force !== true) {
		fail("이 스펙은 기준 미달로 조기 종료된 스펙입니다. 사용자에게 남은 빈 곳을 보여주고 진행 여부를 물은 뒤, 진행하기로 했으면 --force를 붙이세요");
	}
	if (spec.criteria.length === 0) fail('스펙에 "## 다 됐다는 기준" 항목이 없습니다. 완료 기준 없이는 계획을 검사할 수 없습니다');
	const existing = readState(root, sid);
	if (existing && !["planned", "stuck"].includes(existing.status) && flags.force !== true) {
		fail(`이 세션에 진행 중인 빌드가 있습니다 (상태: ${existing.status}). 이어가려면 status를 보고, 새로 시작하려면 --force를 붙이세요`);
	}
	const slug = isText(flags.slug) ? flags.slug : path.basename(abs, ".md").replace(/^deep-interview-/, "");
	if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)) fail("--slug는 소문자 kebab-case여야 합니다");
	const state = {
		version: 1,
		session: sid,
		slug,
		spec_path: relative(root, abs),
		spec,
		forced: !spec.passed,
		status: "designing",
		design_path: null,
		plan_path: null,
		plan: null,
		reviews: [],
		created_at: new Date().toISOString(),
	};
	writeState(root, sid, state);
	return { ok: true, ...summary(state), spec_title: spec.title, next: "설계 문서를 쓰고 design --file로 등록" };
}

/** 설계 문서를 검사하고 등록한다. */
function cmdDesign(root, sid, flags) {
	const state = requireState(root, sid);
	// 검토를 통과하기 전까지는 설계를 다시 등록할 수 있다 (계획을 쓰다 설계를 고치는 경우).
	if (!["designing", "planning", "revising"].includes(state.status)) fail(`설계 문서는 designing/planning/revising 상태에서만 등록할 수 있습니다 (현재: ${state.status})`);
	if (!isText(flags.file)) fail("--file <설계 문서 경로>가 필요합니다");
	const abs = path.resolve(root, flags.file);
	if (!fs.existsSync(abs)) fail(`설계 문서가 없습니다: ${flags.file}`);
	const problems = checkDesign(fs.readFileSync(abs, "utf8"));
	if (problems.length) fail(`설계 문서가 완성되지 않았습니다: ${problems.join(" / ")}`);
	state.design_path = relative(root, abs);
	if (state.status === "designing") state.status = "planning";
	writeState(root, sid, state);
	return { ok: true, ...summary(state), next: "작업 목록을 만들어 plan --input으로 등록" };
}

/** 계획을 검사하고 계획 파일을 쓴다. */
function cmdPlan(root, sid, flags) {
	const state = requireState(root, sid);
	if (!["planning", "revising"].includes(state.status)) fail(`계획은 planning/revising 상태에서만 등록할 수 있습니다 (현재: ${state.status})`);
	if (!state.design_path) fail("설계 문서를 먼저 등록하세요 (design --file)");
	const plan = readInput(flags);
	const problems = checkPlan(plan, state.spec);
	if (problems.length) fail(`계획이 완성되지 않았습니다: ${problems.join(" / ")}`);
	const file = path.join(plansDir(root), `${state.slug}.md`);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const markdown = renderPlan(plan, state.spec, { spec_path: state.spec_path, design_path: state.design_path, date: new Date().toISOString().slice(0, 10) });
	fs.writeFileSync(file, markdown);
	state.plan = plan;
	state.plan_path = relative(root, file);
	state.status = "reviewing";
	writeState(root, sid, state);
	return { ok: true, ...summary(state), task_count: plan.tasks.length, next: "검토 에이전트에게 스펙·설계·계획을 넘기고 결과를 review --input으로 기록" };
}

/** 검토 결과를 기록한다. */
function cmdReview(root, sid, flags) {
	const state = requireState(root, sid);
	if (state.status !== "reviewing") fail(`검토는 reviewing 상태에서만 기록할 수 있습니다 (현재: ${state.status})`);
	const input = readInput(flags);
	if (!["pass", "revise"].includes(input.verdict)) fail('verdict는 "pass" 또는 "revise"여야 합니다');
	const findings = Array.isArray(input.findings) ? input.findings : [];
	if (input.verdict === "revise" && findings.length === 0) fail("revise 판정에는 findings가 하나 이상 있어야 합니다");
	for (const f of findings) {
		if (!isText(f?.finding) || !isText(f?.target)) fail("findings의 항목마다 target과 finding이 필요합니다");
	}
	const round = state.reviews.length + 1;
	state.reviews.push({ round, verdict: input.verdict, findings, summary: input.summary ?? null, recorded_at: new Date().toISOString() });
	if (input.verdict === "pass") state.status = "planned";
	else if (round >= MAX_REVIEW_ROUNDS) state.status = "stuck";
	else state.status = "revising";
	writeState(root, sid, state);
	return {
		ok: true,
		...summary(state),
		round,
		verdict: input.verdict,
		rounds_left: Math.max(0, MAX_REVIEW_ROUNDS - round),
		next:
			state.status === "planned"
				? "계획이 통과했습니다. 구현 단계로 넘깁니다"
				: state.status === "stuck"
					? `수정 ${MAX_REVIEW_ROUNDS}회 뒤에도 통과하지 못했습니다. 구현하지 않고 남은 지적을 사용자에게 보여주세요`
					: "지적을 반영해 설계(design)나 계획(plan)을 다시 등록한 뒤 다시 검토",
	};
}

// =============================================================================
// 2단계: 구현 → 완료 판정
// =============================================================================

/** 의존 관계를 지키는 작업 순서. 순환이 있으면 오류. */
export function taskOrder(tasks) {
	const byId = new Map(tasks.map(t => [t.id, t]));
	const order = [];
	const seen = new Set();
	const visiting = new Set();
	const visit = id => {
		if (seen.has(id)) return;
		if (visiting.has(id)) fail(`작업 의존이 순환합니다: ${id}`);
		visiting.add(id);
		for (const dep of byId.get(id)?.depends_on ?? []) visit(dep);
		visiting.delete(id);
		seen.add(id);
		order.push(id);
	};
	for (const t of tasks) visit(t.id);
	return order;
}

/** 지금 할 수 있는 작업들: 아직 안 끝났고 의존 작업이 모두 끝난 작업. 서로 독립이면 여러 개가 나오고, 병렬로 해도 된다. */
function readyTasks(state) {
	const done = new Set(Object.entries(state.execution.tasks).filter(([, t]) => t.status === "done").map(([id]) => id));
	return state.execution.order.filter(id => {
		if (state.execution.tasks[id].status === "done") return false;
		const deps = state.plan.tasks.find(x => x.id === id)?.depends_on ?? [];
		return deps.every(d => done.has(d));
	});
}

/** 다음에 할 작업 하나 (순서상 첫 번째). */
function nextTask(state) {
	return readyTasks(state)[0] ?? null;
}

/** 셸 명령을 프로젝트 루트에서 실행하고 결과를 요약한다. 출력은 끝 2000자만 남긴다. */
export function runCommand(root, cmd) {
	const started = Date.now();
	const r = spawnSync(cmd, { shell: true, cwd: root, encoding: "utf8", timeout: COMMAND_TIMEOUT_MS, maxBuffer: 50 * 1024 * 1024 });
	const out = `${r.stdout ?? ""}${r.stderr ? `\n[stderr]\n${r.stderr}` : ""}`.trim();
	return {
		cmd,
		exit_code: r.status ?? (r.error ? -1 : null),
		timed_out: Boolean(r.error && r.error.code === "ETIMEDOUT"),
		duration_ms: Date.now() - started,
		output_tail: out.length > 2000 ? `…${out.slice(-2000)}` : out,
	};
}

function requireExecuting(state) {
	if (state.status !== "executing") fail(`구현 중(executing) 상태가 아닙니다 (현재: ${state.status})`);
	return state.execution;
}

function executionSummary(state) {
	const ex = state.execution;
	if (!ex) return {};
	const list = ex.order.map(id => ({ id, title: state.plan.tasks.find(t => t.id === id)?.title, status: ex.tasks[id].status, attempts: ex.tasks[id].attempts }));
	return {
		mode: ex.mode,
		tasks: list,
		done: list.filter(t => t.status === "done").map(t => t.id),
		remaining: list.filter(t => t.status !== "done").map(t => t.id),
		failed_reason: ex.failed_reason ?? null,
		next_task: state.status === "executing" ? nextTask(state) : null,
		ready_tasks: state.status === "executing" ? readyTasks(state) : [],
	};
}

/** 구현을 시작한다. 작업 수로 방식을 고른다. */
function cmdExecute(root, sid, flags) {
	const state = requireState(root, sid);
	if (state.status !== "planned") fail(`구현은 검토를 통과한(planned) 뒤에만 시작할 수 있습니다 (현재: ${state.status})`);
	const tasks = state.plan.tasks;
	const order = taskOrder(tasks);
	state.execution = {
		mode: tasks.length <= SINGLE_SESSION_MAX_TASKS ? "single" : "agents",
		order,
		tasks: Object.fromEntries(order.map(id => [id, { status: "pending", attempts: 0, runs: [], reviews: [] }])),
		criteria_evidence: null,
		final_reviews: [],
		started_at: new Date().toISOString(),
	};
	state.status = "executing";
	writeState(root, sid, state);
	return {
		ok: true,
		...summary(state),
		...executionSummary(state),
		next:
			state.execution.mode === "single"
				? `작업이 ${tasks.length}개라 이 세션이 순서대로 구현합니다. 작업마다 task-done --cmd로 테스트를 실행하세요`
				: `작업이 ${tasks.length}개라 작업마다 구현 에이전트를 띄우고, task-done 뒤 리뷰 에이전트 판정을 task-review로 기록하세요`,
	};
}

/** 작업 실패를 기록하고, 3회면 전체를 멈춘다. */
function recordFailure(state, id, reason) {
	const t = state.execution.tasks[id];
	t.attempts += 1;
	t.status = "failed";
	if (t.attempts >= MAX_TASK_ATTEMPTS) {
		state.status = "stuck";
		state.execution.failed_reason = `${id}: ${MAX_TASK_ATTEMPTS}회 시도 뒤에도 실패. 마지막 이유: ${reason}`;
	}
}

/** 테스트 명령을 코드가 실행해 작업 완료를 판정한다. */
function cmdTaskDone(root, sid, flags) {
	const state = requireState(root, sid);
	const ex = requireExecuting(state);
	const id = flags.task;
	if (!isText(id) || !ex.tasks[id]) fail(`--task는 계획의 작업 id여야 합니다: ${id}`);
	if (ex.tasks[id].status === "done") fail(`${id}는 이미 끝난 작업입니다`);
	const ready = readyTasks(state);
	if (!ready.includes(id)) fail(`${id}는 의존 작업이 아직 끝나지 않았습니다. 지금 할 수 있는 작업: ${ready.join(", ") || "없음"}`);
	if (!isText(flags.cmd)) fail('--cmd "<테스트 명령>"이 필요합니다. 계획의 "먼저 실패할 테스트"를 실행하는 명령입니다');

	const run = runCommand(root, flags.cmd);
	const t = ex.tasks[id];
	t.runs.push({ ...run, at: new Date().toISOString() });
	if (run.exit_code === 0) {
		t.status = ex.mode === "agents" ? "awaiting_review" : "done";
	} else {
		recordFailure(state, id, run.timed_out ? "테스트 시간 초과" : `테스트 종료 코드 ${run.exit_code}`);
	}
	writeState(root, sid, state);
	return {
		ok: true,
		task: id,
		passed: run.exit_code === 0,
		exit_code: run.exit_code,
		output_tail: run.output_tail,
		attempts: t.attempts,
		attempts_left: Math.max(0, MAX_TASK_ATTEMPTS - t.attempts),
		status: state.status,
		task_status: t.status,
		...executionSummary(state),
		next:
			state.status === "stuck"
				? "전체를 멈춥니다. 끝난 작업·남은 작업·실패 이유를 사용자에게 보여주세요"
				: t.status === "awaiting_review"
					? `리뷰 에이전트에게 ${id}의 변경을 검토시키고 task-review로 기록하세요`
					: t.status === "done"
						? nextTask(state)
							? `다음 작업: ${nextTask(state)}`
							: "모든 작업이 끝났습니다. verify로 완료 기준 증거를 기록하세요"
						: `${id}를 고치고 다시 task-done을 실행하세요 (남은 시도 ${Math.max(0, MAX_TASK_ATTEMPTS - t.attempts)}회)`,
	};
}

/** 에이전트 방식에서 작업 리뷰 판정을 기록한다. */
function cmdTaskReview(root, sid, flags) {
	const state = requireState(root, sid);
	const ex = requireExecuting(state);
	if (ex.mode !== "agents") fail("task-review는 에이전트 방식(작업 4개 이상)에서만 씁니다");
	const id = flags.task;
	if (!isText(id) || !ex.tasks[id]) fail(`--task는 계획의 작업 id여야 합니다: ${id}`);
	const t = ex.tasks[id];
	if (t.status !== "awaiting_review") fail(`${id}는 리뷰 대기 상태가 아닙니다 (현재: ${t.status}). 먼저 task-done으로 테스트를 통과시키세요`);
	const input = readInput(flags);
	if (!["pass", "revise"].includes(input.verdict)) fail('verdict는 "pass" 또는 "revise"여야 합니다');
	const findings = Array.isArray(input.findings) ? input.findings : [];
	if (input.verdict === "revise" && findings.length === 0) fail("revise 판정에는 findings가 하나 이상 있어야 합니다");
	t.reviews.push({ verdict: input.verdict, findings, summary: input.summary ?? null, at: new Date().toISOString() });
	if (input.verdict === "pass") t.status = "done";
	else recordFailure(state, id, `리뷰 revise: ${findings[0]?.finding ?? ""}`);
	writeState(root, sid, state);
	return {
		ok: true,
		task: id,
		verdict: input.verdict,
		status: state.status,
		task_status: t.status,
		attempts_left: Math.max(0, MAX_TASK_ATTEMPTS - t.attempts),
		...executionSummary(state),
		next:
			state.status === "stuck"
				? "전체를 멈춥니다. 끝난 작업·남은 작업·실패 이유를 사용자에게 보여주세요"
				: t.status === "done"
					? nextTask(state)
						? `다음 작업: ${nextTask(state)}`
						: "모든 작업이 끝났습니다. verify로 완료 기준 증거를 기록하세요"
					: `${id}의 지적을 고치고 다시 task-done부터 실행하세요`,
	};
}

/** 완료 기준마다 증거 명령을 실행한다. 전부 종료 코드 0이어야 통과. */
function cmdVerify(root, sid, flags) {
	const state = requireState(root, sid);
	const ex = requireExecuting(state);
	if (nextTask(state) !== null || Object.values(ex.tasks).some(t => t.status !== "done")) {
		fail(`아직 끝나지 않은 작업이 있습니다: ${Object.entries(ex.tasks).filter(([, t]) => t.status !== "done").map(([id]) => id).join(", ")}`);
	}
	const input = readInput(flags);
	const evidence = input.criteria;
	if (!evidence || typeof evidence !== "object") fail('criteria가 필요합니다: { "AC-1": { "cmd": "<명령>", "note": "..." }, ... }');
	const results = {};
	const failed = [];
	for (const c of state.spec.criteria) {
		const entry = evidence[c.id];
		if (!entry || !isText(entry.cmd)) {
			failed.push(`${c.id}: 증거 명령이 없습니다`);
			continue;
		}
		const run = runCommand(root, entry.cmd);
		results[c.id] = { ...run, note: entry.note ?? null, text: c.text };
		if (run.exit_code !== 0) failed.push(`${c.id}: 종료 코드 ${run.exit_code}`);
	}
	ex.criteria_evidence = { results, at: new Date().toISOString(), passed: failed.length === 0 };
	writeState(root, sid, state);
	if (failed.length) {
		return { ok: true, passed: false, failed, results, next: "실패한 완료 기준을 고치고 verify를 다시 실행하세요. 작업을 고쳐야 하면 그 작업의 테스트도 다시 통과해야 합니다" };
	}
	return { ok: true, passed: true, results, next: "새 리뷰 에이전트에게 전체 변경을 스펙과 대조시키고 final-review로 기록하세요" };
}

/** 전체 리뷰 판정을 기록한다. pass면 done, 3회 revise면 stuck. */
function cmdFinalReview(root, sid, flags) {
	const state = requireState(root, sid);
	const ex = requireExecuting(state);
	if (!ex.criteria_evidence?.passed) fail("verify가 통과한 뒤에만 최종 리뷰를 기록할 수 있습니다");
	const input = readInput(flags);
	if (!["pass", "revise"].includes(input.verdict)) fail('verdict는 "pass" 또는 "revise"여야 합니다');
	const findings = Array.isArray(input.findings) ? input.findings : [];
	if (input.verdict === "revise" && findings.length === 0) fail("revise 판정에는 findings가 하나 이상 있어야 합니다");
	const round = ex.final_reviews.length + 1;
	ex.final_reviews.push({ round, verdict: input.verdict, findings, summary: input.summary ?? null, at: new Date().toISOString() });
	if (input.verdict === "pass") {
		state.status = "done";
		state.done_at = new Date().toISOString();
	} else if (round >= MAX_REVIEW_ROUNDS) {
		state.status = "stuck";
		ex.failed_reason = `최종 리뷰 ${MAX_REVIEW_ROUNDS}회 뒤에도 revise`;
	} else {
		// 고친 뒤 verify부터 다시 한다. 증거는 무효로 돌린다.
		ex.criteria_evidence = null;
	}
	writeState(root, sid, state);
	return {
		ok: true,
		round,
		verdict: input.verdict,
		status: state.status,
		rounds_left: Math.max(0, MAX_REVIEW_ROUNDS - round),
		next:
			state.status === "done"
				? "구현이 끝났습니다. 변경 요약과 커밋 여부를 사용자에게 보여주세요 (자동 커밋 안 함)"
				: state.status === "stuck"
					? "전체를 멈춥니다. 남은 지적을 사용자에게 보여주세요"
					: "지적을 고친 뒤 verify부터 다시 실행하세요",
	};
}

function cmdStatus(root, sid) {
	const state = readState(root, sid);
	if (!state) return { ok: true, exists: false };
	return { ok: true, exists: true, ...summary(state), ...executionSummary(state), reviews: state.reviews, plan: state.plan, final_reviews: state.execution?.final_reviews ?? [] };
}

const COMMANDS = {
	start: cmdStart,
	design: cmdDesign,
	plan: cmdPlan,
	review: cmdReview,
	execute: cmdExecute,
	"task-done": cmdTaskDone,
	"task-review": cmdTaskReview,
	verify: cmdVerify,
	"final-review": cmdFinalReview,
	status: cmdStatus,
};

export function run(argv, cwd = process.cwd()) {
	const { command, flags } = parseArgs(argv);
	const handler = COMMANDS[command];
	if (!handler) fail(`알 수 없는 명령입니다: ${JSON.stringify(command)}. 가능한 명령: ${Object.keys(COMMANDS).join(", ")}`);
	if (!isText(flags.session)) fail("--session이 필요합니다");
	const root = projectRoot(isText(flags.root) ? flags.root : cwd);
	return handler(root, flags.session, flags);
}

if (process.argv[1]?.endsWith("build.mjs")) {
	try {
		process.stdout.write(`${JSON.stringify(run(process.argv.slice(2)), null, 2)}\n`);
	} catch (error) {
		process.stdout.write(`${JSON.stringify({ ok: false, error: error.message }, null, 2)}\n`);
		process.exit(1);
	}
}
