// 테스트 공용 도우미.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "../skills/deep-interview/scripts/interview.mjs";
import { record } from "../hooks/record-answer.mjs";

export const SID = "test-session";

/**
 * 빈 임시 프로젝트 폴더를 만든다.
 * 세션 → 루트 색인(DEEP_WORKFLOW_HOME)도 매번 새 폴더를 쓰게 해서, 같은 세션 ID를 쓰는 테스트끼리 색인이 섞이지 않게 한다.
 */
export function tempProject() {
	process.env.DEEP_WORKFLOW_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "deep-workflow-home-"));
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

/** 사용자가 조서 낭독 선택지 창에서 "서명"을 고른 것처럼 기록한다. */
export function sign(root) {
	return choose(root, "조서", "서명 (추천)");
}

/** 인터뷰를 시작한다. 기본은 새로 만들기(greenfield). */
export function start(root, ...flags) {
	return cli(root, "start", "--topic", "휴가 신청", ...flags);
}

/** 사용자 진술 하나. */
export const said = (text, area, extra = {}) => ({ text, area, source: "user", ...extra });
/** 형사가 정리한 진술 하나. */
export const inferred = (text, area, extra = {}) => ({ text, area, source: "inferred", ...extra });

/** 턴 하나를 적는다. 질문·답은 자동으로 채운다. */
export function note(root, turn, body = {}) {
	return cli(root, "note", ...input({ turn, question: `질문 ${turn}`, answer: `답 ${turn}`, ...body }));
}

/**
 * 새로 만들기 인터뷰에서 낭독 조건(구멍 0·모순 0·항목마다 진술)을 맞춘 상태로 만든다.
 * 턴 1~3에서 왜·무엇(고정 항목)·지킬 조건·완료 기준을 사용자 말로 적는다.
 */
export function readyInterview(root) {
	start(root);
	note(root, 1, { statements: [said("휴가 신청이 메일이라 누락됨", "why"), said("직원이 웹에서 연차를 신청한다", "what", { fixed: "화면:신청폼" })] });
	note(root, 2, { statements: [said("기존 로그인 그대로 쓴다", "keep"), said("반차는 이번에 안 한다", "avoid")] });
	note(root, 3, { statements: [said("신청하면 목록에 '대기'로 보인다", "done")] });
	return root;
}
