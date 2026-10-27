#!/usr/bin/env node
// PreToolUse 가드 훅 (deep-interview + deep-build 공용).
// - 인터뷰 상태(.deep-interview/sessions/)는 언제나 직접 고칠 수 없다. 상태는 interview.mjs로만 바꾼다.
// - 계획(.deep-interview/plans/)과 빌드 상태(.deep-interview/builds/)도 직접 쓸 수 없다. build.mjs로만 쓴다.
//   계획을 직접 쓰면 고정 항목·완료 기준 연결 검사를 건너뛰게 되기 때문이다.
// - 이 세션에서 딥 인터뷰가 진행 중이면 코드 수정을 막는다.
//   허용: 조건을 만족한 스펙 저장(.deep-interview/specs/), 프로젝트 밖 임시 폴더 쓰기, 읽기 전용 셸 명령, interview.mjs.
// Claude Code가 도구 호출 정보를 stdin JSON으로 넘겨주고, 막을 때는 deny JSON을 stdout으로 돌려준다.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkBashCommand } from "./bash-check.mjs";
import { completionBlocker, findRoot, isActive, readState, sessionsDir, specsDir } from "../skills/deep-interview/scripts/state.mjs";

// 파일을 직접 쓰는 도구.
const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

// 막을 때 안내할 상태 명령 스크립트 경로.
const HOOKS_DIR = path.dirname(fileURLToPath(import.meta.url));
const INTERVIEW_SCRIPT = path.join(HOOKS_DIR, "../skills/deep-interview/scripts/interview.mjs");
const BUILD_SCRIPT = path.join(HOOKS_DIR, "../skills/deep-build/scripts/build.mjs");

// build.mjs로만 쓸 수 있는 .deep-interview 하위 폴더.
const BUILD_PROTECTED = new Set(["plans", "builds"]);

/** 심볼릭 링크를 풀어 실제 경로를 얻는다 (macOS의 /tmp → /private/tmp 등). 없는 경로면 가능한 데까지 푼다. */
function realish(p) {
	try {
		return fs.realpathSync(p);
	} catch {
		const parent = path.dirname(p);
		return parent === p ? p : path.join(realish(parent), path.basename(p));
	}
}

/** `child`가 `parent` 안(또는 같은 경로)에 있는지. */
function isInside(child, parent) {
	const rel = path.relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** 임시 폴더 안의 파일인지. 스펙 초안 같은 메모를 임시 폴더에 쓰는 것은 허용한다. */
function isTempPath(file) {
	const roots = ["/tmp", "/private/tmp", "/var/tmp", "/private/var/tmp", os.tmpdir()].map(realish);
	return roots.some(root => isInside(realish(file), root));
}

/** 인터뷰 중 코드 수정을 막을 때 보여줄 안내문. */
function blockedMessage(reason, sessionId) {
	return [
		`딥 인터뷰 진행 중이라 ${reason}`,
		"스펙 저장(.deep-interview/specs/)과 읽기 전용 명령만 쓸 수 있습니다.",
		`사용자가 인터뷰를 그만두기로 했다면 먼저 실행하세요: node "${INTERVIEW_SCRIPT}" end --session ${sessionId} --status cancelled`,
	].join(" ");
}

/** 경로가 `.deep-interview/plans/` 또는 `.deep-interview/builds/` 아래면 그 폴더 이름, 아니면 null. */
function buildProtectedDir(abs) {
	const parts = abs.split(path.sep);
	const at = parts.lastIndexOf(".deep-interview");
	return at >= 0 && BUILD_PROTECTED.has(parts[at + 1]) ? parts[at + 1] : null;
}

/** 도구 호출을 판정한다. 막아야 하면 이유 문자열, 허용하면 null. */
export function evaluate(input) {
	const sessionId = input?.session_id;
	const cwd = typeof input?.cwd === "string" ? input.cwd : process.cwd();
	const tool = input?.tool_name;
	const toolInput = input?.tool_input ?? {};

	let abs = null;
	if (FILE_TOOLS.has(tool)) {
		const target = toolInput.file_path ?? toolInput.notebook_path;
		if (typeof target === "string") abs = realish(path.resolve(cwd, target));
		// 계획과 빌드 상태는 손으로 쓸 수 없다 (어느 세션이든, 프로젝트 루트를 못 찾아도).
		const dir = abs && buildProtectedDir(abs);
		if (dir) {
			return `.deep-interview/${dir}/는 직접 쓸 수 없습니다. 계획은 node "${BUILD_SCRIPT}" plan --input으로 등록하세요 (고정 항목·완료 기준 연결을 검사합니다).`;
		}
	}

	const root = findRoot(cwd);
	if (!root || typeof sessionId !== "string") return null;

	// 상태 파일과 답 기록은 손으로 고칠 수 없다 (어느 세션이든, 인터뷰 중이 아니어도).
	if (abs && isInside(abs, realish(sessionsDir(root)))) {
		return `.deep-interview/sessions/는 직접 고칠 수 없습니다. 상태는 node "${INTERVIEW_SCRIPT}" 명령으로만 바꾸세요.`;
	}

	// 이 세션의 인터뷰만 본다. 다른 세션의 인터뷰는 이 세션을 막지 않는다.
	let state = null;
	try {
		state = readState(root, sessionId);
	} catch {
		state = null;
	}
	if (!isActive(state)) return null;

	if (FILE_TOOLS.has(tool)) {
		if (!abs) return null;
		if (isInside(abs, realish(specsDir(root)))) {
			// 빈틈 막기: 기록 없이, 기준 미달로, 사용자 확인 없이 스펙을 저장하지 못하게 한다.
			const blocker = completionBlocker(root, sessionId, state);
			return blocker ? `아직 스펙을 저장할 수 없습니다. ${blocker}` : null;
		}
		// 임시 폴더라도 프로젝트 안쪽이면 허용하지 않는다 (프로젝트가 /tmp 아래에 있는 경우).
		if (isTempPath(abs) && !isInside(abs, realish(root))) return null;
		return blockedMessage("파일을 고칠 수 없습니다.", sessionId);
	}

	if (tool === "Bash") {
		const result = checkBashCommand(toolInput.command);
		if (!result.ok) return blockedMessage(`이 명령은 실행할 수 없습니다 (${result.reason}).`, sessionId);
	}
	return null;
}

/** stdin으로 받은 도구 호출을 판정하고, 막아야 하면 deny 결정을 출력한다. */
async function main() {
	let raw = "";
	for await (const chunk of process.stdin) raw += chunk;
	let reason = null;
	try {
		reason = evaluate(JSON.parse(raw));
	} catch {
		return; // 입력이 깨졌으면 허용한다. 훅 오류 때문에 세션 전체가 멈추지 않게 하기 위해서다.
	}
	if (!reason) return;
	process.stdout.write(
		JSON.stringify({
			hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
		}),
	);
}

// 훅으로 직접 실행될 때만 동작한다 (테스트에서 import할 때는 실행하지 않음).
if (process.argv[1]?.endsWith("guard.mjs")) await main();
