// 세션 ID → 프로젝트 루트 색인. deep-interview와 deep-build, 훅이 함께 쓴다.
//
// 왜 필요한가: 루트를 cwd(git 최상위)로만 정하면, 인터뷰 중에 `cd`로 다른 저장소에 간 순간 훅과 상태 명령이
// 다른 루트를 봐서 차단이 풀리고, 엉뚱한 곳에 새 인터뷰를 시작할 수 있다. 그래서 start가 "이 세션은 이 루트"를
// cwd와 무관한 곳에 적어 두고, 그 루트에 이 세션의 진행 중인 인터뷰·빌드가 있는 동안은 cwd가 어디든 그 루트를 쓴다.
//
// 색인 파일: <색인 폴더>/<세션ID>.json  { "root": "/abs/path", "updated_at": "..." }
// 색인 폴더: $DEEP_WORKFLOW_HOME/sessions → $CLAUDE_CONFIG_DIR/deep-workflow/sessions → ~/.claude/deep-workflow/sessions
// start(인터뷰·빌드)가 쓰고 지우지 않는다. 가리키는 루트에 진행 중인 상태가 없으면 무시된다 (끝난 뒤 다른 프로젝트에서 새로 시작할 수 있게).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

export const DIR_NAME = ".deep-interview";

// 아직 끝나지 않은 빌드 상태. build.mjs와 색인 판정이 같은 목록을 본다.
export const BUILD_IN_PROGRESS = new Set(["designing", "planning", "reviewing", "revising", "planned", "executing"]);

/** 세션 ID를 폴더·파일 이름으로 써도 안전한지 확인한다 (`../` 같은 경로 조작 방지). */
export function assertSessionId(sessionId) {
	if (typeof sessionId !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(sessionId) || sessionId.startsWith(".")) {
		throw new Error(`세션 ID가 올바르지 않습니다: ${JSON.stringify(sessionId)}`);
	}
	return sessionId;
}

/** `start`에서 위로 올라가며 `.deep-interview` 폴더가 있는 디렉터리를 찾는다. 없으면 null. */
export function findRoot(start) {
	let dir = path.resolve(start);
	for (;;) {
		try {
			if (fs.statSync(path.join(dir, DIR_NAME)).isDirectory()) return dir;
		} catch {}
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/**
 * cwd 기준 프로젝트 루트: git 최상위 폴더 → 이미 있는 `.deep-interview`의 위치 → `cwd` 순서로 정한다.
 * git을 먼저 보는 이유: 홈 폴더 같은 상위에 `.deep-interview`가 있어도 기록이 그쪽으로 새지 않게 하기 위해서다.
 */
export function projectRoot(cwd = process.cwd()) {
	try {
		const top = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, stdio: ["ignore", "pipe", "ignore"] })
			.toString()
			.trim();
		if (top) return top;
	} catch {}
	return findRoot(cwd) ?? path.resolve(cwd);
}

/** 색인 폴더. 환경 변수는 부를 때마다 읽는다 (테스트가 세션마다 다른 폴더를 쓸 수 있게). */
export function indexDir() {
	const home = process.env.DEEP_WORKFLOW_HOME || path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "deep-workflow");
	return path.join(home, "sessions");
}

export const indexPath = sid => path.join(indexDir(), `${assertSessionId(sid)}.json`);

/** 이 세션의 루트를 색인에 적는다. 임시 파일에 쓰고 rename해서 반쯤 쓰인 파일이 남지 않게 한다. */
export function writeSessionIndex(sid, root) {
	const file = indexPath(sid);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify({ root: path.resolve(root), updated_at: new Date().toISOString() }, null, 2)}\n`);
	fs.renameSync(tmp, file);
}

/** 색인을 읽는다. 없거나 깨졌으면 null. */
export function readSessionIndex(sid) {
	try {
		const parsed = JSON.parse(fs.readFileSync(indexPath(sid), "utf8"));
		return typeof parsed?.root === "string" && parsed.root ? parsed : null;
	} catch {
		return null;
	}
}

function readJson(file) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return null;
	}
}

/** 이 루트에 이 세션의 진행 중인 인터뷰(active)나 빌드(끝나지 않은 상태)가 있는지. */
export function sessionBusy(root, sid) {
	const interview = readJson(path.join(root, DIR_NAME, "sessions", sid, "state.json"));
	if (interview?.active === true) return true;
	const build = readJson(path.join(root, DIR_NAME, "builds", `${sid}.json`));
	return Boolean(build) && BUILD_IN_PROGRESS.has(build.status);
}

/**
 * 이 세션이 쓸 프로젝트 루트.
 * 색인이 가리키는 루트에 이 세션의 진행 중인 인터뷰·빌드가 있으면 cwd가 어디든 그 루트다.
 * 아니면 cwd 기준(`projectRoot`)으로 정한다. 세션 ID가 이상하면 색인을 보지 않는다.
 */
export function resolveRoot(sid, cwd = process.cwd()) {
	let indexed = null;
	try {
		indexed = readSessionIndex(sid);
	} catch {
		indexed = null;
	}
	if (indexed && sessionBusy(indexed.root, sid)) return indexed.root;
	return projectRoot(cwd);
}
