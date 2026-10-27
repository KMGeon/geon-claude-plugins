// 테스트 공용 도우미.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "../skills/deep-interview/scripts/interview.mjs";
import { record } from "../hooks/record-answer.mjs";

export const SID = "test-session";

/** 빈 임시 프로젝트 폴더를 만든다. */
export function tempProject() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "deep-interview-test-"));
}

/** 이 세션으로 interview.mjs 명령을 실행한다. */
export function cli(root, ...args) {
	return run([...args, "--session", SID, "--root", root], root);
}

/** `--input` 플래그 값을 만든다. */
export function input(value) {
	return ["--input", JSON.stringify(value)];
}

/** 사용자가 채팅창에 메시지를 보낸 것처럼 기록 훅을 부른다. */
export function say(root, text) {
	return record({ hook_event_name: "UserPromptSubmit", session_id: SID, cwd: root, prompt: text });
}

/** 사용자가 선택지 창에서 답한 것처럼 기록 훅을 부른다. */
export function choose(root, header, label) {
	const question = `${header} 질문?`;
	return record({
		hook_event_name: "PostToolUse",
		tool_name: "AskUserQuestion",
		session_id: SID,
		cwd: root,
		tool_input: { questions: [{ question, header, options: [{ label }] }] },
		tool_response: { answers: { [question]: label } },
	});
}

/** 모든 체크에 "예"(근거 포함)로 답한 체크리스트. */
export function allYes(ids) {
	return Object.fromEntries(ids.map(id => [id, `${id} 근거`]));
}

export const CORE_IDS = ["g0", "g1", "g2", "g3", "c1", "c2", "c3", "s1", "s2", "s3"];

/** 인터뷰를 시작하고 덩어리 하나(app)로 범위를 확정한다. */
export function startWithScope(root, { components = [{ id: "app", name: "앱" }], flags = [] } = {}) {
	cli(root, "start", "--topic", "휴가 신청", ...flags);
	say(root, "맞아요");
	return cli(root, "scope", ...input({ components, fixed_items: [{ id: "화면:신청폼", statement: "신청 화면" }] }));
}

/** 다음 라운드를 기록한다. */
export function recordRound(root, round, checks, extra = {}) {
	return cli(
		root,
		"record",
		...input({ round, component: "app", dimension: "goal", question: `질문 ${round}`, answer: `답 ${round}`, checks: { app: checks }, ...extra }),
	);
}
