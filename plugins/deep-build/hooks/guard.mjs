#!/usr/bin/env node
// PreToolUse 가드 훅: 계획(.deep-interview/plans/)과 빌드 상태(.deep-interview/builds/)는
// build.mjs로만 쓴다. 계획을 직접 쓰면 고정 항목·완료 기준 연결 검사를 건너뛰게 되기 때문이다.
// 설계 문서(.deep-interview/designs/)는 직접 써도 된다. design 명령이 등록할 때 검사한다.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const PROTECTED = ["plans", "builds"];
const BUILD_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../skills/deep-build/scripts/build.mjs");

function realish(p) {
	try {
		return fs.realpathSync(p);
	} catch {
		const parent = path.dirname(p);
		return parent === p ? p : path.join(realish(parent), path.basename(p));
	}
}

/** 경로 안에 `.deep-interview/plans` 또는 `.deep-interview/builds`가 들어 있는지. */
export function evaluate(input) {
	if (!FILE_TOOLS.has(input?.tool_name)) return null;
	const target = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
	if (typeof target !== "string") return null;
	const cwd = typeof input.cwd === "string" ? input.cwd : process.cwd();
	const parts = realish(path.resolve(cwd, target)).split(path.sep);
	const at = parts.lastIndexOf(".deep-interview");
	if (at < 0 || !PROTECTED.includes(parts[at + 1])) return null;
	return `.deep-interview/${parts[at + 1]}/는 직접 쓸 수 없습니다. 계획은 node "${BUILD_SCRIPT}" plan --input으로 등록하세요 (고정 항목·완료 기준 연결을 검사합니다).`;
}

async function main() {
	let raw = "";
	for await (const chunk of process.stdin) raw += chunk;
	let reason = null;
	try {
		reason = evaluate(JSON.parse(raw));
	} catch {
		return;
	}
	if (!reason) return;
	process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }));
}

if (process.argv[1]?.endsWith("guard.mjs")) await main();
