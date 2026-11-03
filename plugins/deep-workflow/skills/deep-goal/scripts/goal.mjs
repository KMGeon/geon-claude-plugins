#!/usr/bin/env node
// deep-goal 명령. 딥 인터뷰 스펙을 Claude Code `/goal` 조건으로 바꾼다.
//
// 왜 코드가 하나: `/goal`의 완료 판정은 Claude Code의 평가자(모델)가 조건 문장을 읽고 한다. 조건이 흐리면 "거의 됐다"를
// 됐다고 할 수 있다. 그래서 조건 문장은 사람이나 모델이 즉석에서 쓰지 않고, 스펙의 완료 기준을 코드가 그대로 옮겨
// 만든다: 기준마다 자동 테스트와 실제 실행 출력(종료 코드 0)을 요구하고, 테스트를 약하게 만들어 통과시키는 것을 금한다.
//
// 사용법:
//   condition --spec <스펙 경로> [--force] [--test-cmd "<명령>"] [--root <프로젝트 루트>]
//     스펙을 해석해 목표 파일(.deep-interview/goals/<slug>.md)을 쓰고, `/goal`에 붙여 넣을 조건 문장을 돌려준다.
//     기준 미달로 조기 종료된 스펙은 --force가 있어야 한다. --test-cmd는 전체 테스트 명령(예: "npm test")을 조건에 넣는다.
// 결과는 JSON. 실패하면 {"ok": false, "error": "..."}와 종료 코드 1.

import fs from "node:fs";
import path from "node:path";
import { DIR_NAME, projectRoot } from "../../../lib/session-root.mjs";
import { findInterviewState, parseSpec } from "../../deep-build/scripts/build.mjs";

/** Claude Code `/goal` 조건 글자 수 한도 (2.1.317에서 확인한 값). */
export const MAX_CONDITION_LENGTH = 4000;

class CliError extends Error {}
const fail = message => {
	throw new CliError(message);
};
const isText = value => typeof value === "string" && value.trim().length > 0;

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

function realish(p) {
	try {
		return fs.realpathSync(p);
	} catch {
		const parent = path.dirname(p);
		return parent === p ? p : path.join(realish(parent), path.basename(p));
	}
}
const relative = (root, file) => path.relative(realish(root), realish(file)).split(path.sep).join("/");

/**
 * 스펙의 굵은 소제목(`**지킬 조건**` 등) 아래 "- " 줄을 모은다. 다음 소제목이나 제목에서 멈춘다.
 * 완료 기준·고정 항목은 build.mjs의 parseSpec이 읽으므로 여기서는 경계 절만 본다.
 */
export function sectionBullets(markdown, heading) {
	const lines = markdown.split("\n");
	const out = [];
	let on = false;
	for (const line of lines) {
		if (new RegExp(`^(\\*\\*${heading}\\*\\*|#{2,4} +${heading})\\s*$`).test(line)) {
			on = true;
			continue;
		}
		if (on && (/^#{1,4} /.test(line) || /^\*\*[^*]+\*\*\s*$/.test(line))) break;
		if (on) {
			const m = line.match(/^- (?:\[[ xX]\]\s*)?(.+)$/);
			if (m) out.push(m[1].trim());
		}
	}
	return out;
}

const oneLine = text => text.replace(/\s*\n\s*/g, " ").trim();

/**
 * `/goal` 조건 문장을 만든다. 평가자가 글자 그대로 읽으므로 "무엇이 있어야 끝인지"만 적는다:
 * 기준 본문, 기준마다 자동 테스트와 실제 실행 출력, (있으면) 전체 테스트 명령, 경계, 테스트를 약하게 만들지 않았다는 조건.
 * 한도를 넘으면 기준 본문 대신 목표 파일을 가리키는 짧은 형으로 바꾼다.
 */
export function buildCondition({ goalPath, criteria, keep, avoid, testCmd }) {
	const n = criteria.length;
	const ids = n === 1 ? criteria[0].id : `${criteria[0].id}…${criteria[n - 1].id}`;
	const tail = [
		"기준마다 그것을 검사하는 자동 테스트가 있고, 대화 기록에 그 테스트 명령을 실제로 실행해 종료 코드 0으로 끝난 출력이 있다.",
		isText(testCmd) ? `\`${oneLine(testCmd)}\`를 실행해 종료 코드 0으로 끝난 출력이 대화 기록에 있다.` : null,
		avoid.length ? `하지 않을 것(${avoid.map(oneLine).join(" / ")})은 만들지 않았다.` : null,
		keep.length ? `지킬 조건(${keep.map(oneLine).join(" / ")})을 어기지 않았다.` : null,
		"테스트를 지우거나 건너뛰게 바꿔서 통과시키지 않았다.",
	].filter(Boolean);
	const full = [`${goalPath}에 적힌 완료 기준 ${n}개가 모두 충족됐다: ${criteria.map(c => `${c.id} ${oneLine(c.text)}`).join("; ")}.`, ...tail].join(" ");
	if (full.length <= MAX_CONDITION_LENGTH) return { condition: full, form: "full" };
	const short = [`${goalPath}에 적힌 완료 기준 ${n}개(${ids})가 모두 충족됐다. 기준 본문은 그 파일을 읽어 하나씩 대조한다.`, ...tail].join(" ");
	if (short.length <= MAX_CONDITION_LENGTH) return { condition: short, form: "short" };
	fail(`조건이 ${MAX_CONDITION_LENGTH}자를 넘습니다 (${short.length}자). 스펙의 지킬 조건·하지 않을 것을 줄이거나 --test-cmd를 짧게 하세요`);
}

function renderGoalFile({ title, specRel, summary, criteria, fixedItems, keep, avoid, condition, testCmd }) {
	const list = (items, render) => (items.length ? items.map(render).join("\n") : "- 없음");
	return [
		`# ${title} — /goal 목표`,
		"",
		`- 스펙: ${specRel}`,
		`- 한 문장 요약: ${summary ?? "(없음)"}`,
		`- 만든 날짜: ${new Date().toISOString().slice(0, 10)}`,
		`- 전체 테스트 명령: ${isText(testCmd) ? `\`${oneLine(testCmd)}\`` : "(없음. 기준별 테스트만)"}`,
		"",
		"## 완료 기준",
		list(criteria, c => `- [ ] ${c.id} — ${oneLine(c.text)}`),
		"",
		"## 고정 항목",
		list(fixedItems, f => `- \`${f.id}\` — ${f.statement}`),
		"",
		"## 지킬 조건",
		list(keep, k => `- ${k}`),
		"",
		"## 하지 않을 것",
		list(avoid, a => `- ${a}`),
		"",
		"## /goal 조건",
		"```",
		condition,
		"```",
		"",
		"## 진행 메모",
		"(구현하면서 정한 것, 기준별 테스트 명령, 막힌 곳을 여기에 적는다)",
		"",
	].join("\n");
}

function cmdCondition(root, flags) {
	if (!isText(flags.spec)) fail("--spec <스펙 경로>가 필요합니다");
	const abs = realish(path.resolve(root, flags.spec));
	if (!fs.existsSync(abs)) fail(`스펙 파일이 없습니다: ${flags.spec}`);
	const slug = path.basename(abs, ".md").replace(/^deep-interview-/, "");
	if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)) fail(`스펙 파일 이름은 소문자·숫자·하이픈만 쓸 수 있습니다: ${JSON.stringify(slug)}`);
	const markdown = fs.readFileSync(abs, "utf8");
	const spec = parseSpec(markdown);
	const warnings = [];

	// 스펙 글은 Claude가 옮겨 적은 것이다. 인터뷰 기록이 있으면 통과 여부는 그것을 믿는다 (deep-build와 같은 규칙).
	const interview = findInterviewState(root, abs);
	if (interview) spec.passed = interview.status === "done" && interview.early_exit !== true;
	else warnings.push("이 스펙을 만든 인터뷰 기록을 찾지 못했습니다. 스펙 글만 보고 진행합니다");
	if (!spec.passed && flags.force !== true) {
		fail("이 스펙은 기준 미달로 조기 종료된 스펙입니다. 사용자에게 남은 빈 곳을 보여주고 진행 여부를 물은 뒤, 진행하기로 했으면 --force를 붙이세요");
	}
	if (spec.criteria.length === 0) fail('스펙에 "## 다 됐다는 기준" 항목이 없습니다. 완료 기준 없이는 /goal 조건을 만들 수 없습니다');

	const keep = sectionBullets(markdown, "지킬 조건");
	const avoid = sectionBullets(markdown, "하지 않을 것");
	const goalsDir = path.join(root, DIR_NAME, "goals");
	fs.mkdirSync(goalsDir, { recursive: true });
	const goalAbs = path.join(goalsDir, `${slug}.md`);
	const goalPath = relative(root, goalAbs);
	const { condition, form } = buildCondition({ goalPath, criteria: spec.criteria, keep, avoid, testCmd: flags["test-cmd"] });
	fs.writeFileSync(
		goalAbs,
		renderGoalFile({ title: spec.title, specRel: relative(root, abs), summary: spec.summary, criteria: spec.criteria, fixedItems: spec.fixed_items, keep, avoid, condition, testCmd: flags["test-cmd"] }),
	);
	return {
		ok: true,
		goal_path: goalPath,
		spec_path: relative(root, abs),
		criteria: spec.criteria,
		fixed_items: spec.fixed_items.map(f => f.id),
		condition,
		form,
		length: condition.length,
		max_length: MAX_CONDITION_LENGTH,
		goal_command: `/goal ${condition}`,
		forced: !spec.passed,
		warnings,
		next: "사용자에게 goal_command 한 줄을 그대로 보여주고 붙여 넣게 한다. 목표가 걸리면 goal_path를 읽고 구현을 시작한다",
	};
}

const COMMANDS = { condition: cmdCondition };

export function run(argv, cwd = process.cwd()) {
	const { command, flags } = parseArgs(argv);
	const handler = COMMANDS[command];
	if (!handler) fail(`알 수 없는 명령입니다: ${command ?? "(없음)"}. 가능한 명령: ${Object.keys(COMMANDS).join(", ")}`);
	const root = projectRoot(isText(flags.root) ? flags.root : cwd);
	return handler(root, flags);
}

if (process.argv[1]?.endsWith("goal.mjs")) {
	try {
		process.stdout.write(`${JSON.stringify(run(process.argv.slice(2)), null, 2)}\n`);
	} catch (error) {
		process.stdout.write(`${JSON.stringify({ ok: false, error: error.message }, null, 2)}\n`);
		process.exit(1);
	}
}
