#!/usr/bin/env node
// 사용자 답 원문 기록 훅. 인터뷰가 진행 중인 세션에서만 answers.jsonl에 한 줄씩 덧붙인다.
// - PostToolUse(AskUserQuestion): 선택지 창에서 고른 답
// - UserPromptSubmit: 채팅창에 직접 쓴 메시지 (선택지를 쓰지 않고 답한 경우까지 잡기 위해)
// Claude가 옮겨 적은 정리본과 별개로 "사용자가 실제로 한 말"을 남기고, 범위 확정·스펙 저장 조건의 근거로 쓴다.
// UserPromptSubmit 훅의 출력은 Claude 대화에 끼어들므로 아무것도 출력하지 않는다.

import { appendAnswer, isActive, projectRoot, readState } from "../skills/deep-interview/scripts/state.mjs";

/** 객체인지. */
const isObject = value => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** 훅 입력을 기록 한 줄로 바꾼다. 기록할 게 아니면 null. */
function buildRecord(input, now = new Date()) {
	if (input?.hook_event_name === "UserPromptSubmit" || typeof input?.prompt === "string") {
		if (typeof input.prompt !== "string" || !input.prompt.trim()) return null;
		return { ts: now.toISOString(), source: "chat", text: input.prompt };
	}
	if (input?.tool_name === "AskUserQuestion") {
		const questions = Array.isArray(input.tool_input?.questions) ? input.tool_input.questions : [];
		const answers = [input.tool_response?.answers, input.tool_input?.answers].find(isObject) ?? {};
		// 고른 답이 없으면(취소, 빈 응답) 기록하지 않는다. 빈 기록이 "사용자 확인"으로 세어지지 않게.
		if (Object.keys(answers).length === 0) return null;
		return {
			ts: now.toISOString(),
			source: "ask",
			questions: questions.map(question => ({
				question: question?.question,
				header: question?.header,
				options: Array.isArray(question?.options) ? question.options.map(option => option?.label) : [],
			})),
			answers,
		};
	}
	return null;
}

/** 이 세션에 진행 중인 인터뷰가 있을 때만 기록한다. 기록했으면 true. */
export function record(input) {
	if (typeof input?.session_id !== "string") return false;
	// 인터뷰 CLI와 같은 규칙으로 루트를 정한다 (git 최상위 우선).
	const root = projectRoot(typeof input.cwd === "string" ? input.cwd : process.cwd());
	if (!isActive(readState(root, input.session_id))) return false;
	const line = buildRecord(input);
	if (!line) return false;
	appendAnswer(root, input.session_id, line);
	return true;
}

/** stdin으로 받은 훅 입력을 기록한다. */
async function main() {
	let raw = "";
	for await (const chunk of process.stdin) raw += chunk;
	try {
		record(JSON.parse(raw));
	} catch {
		// 기록에 실패해도 세션은 멈추지 않는다. 대신 범위 확정·스펙 저장 조건에서 "답 기록 없음"으로 드러난다.
	}
}

// 훅으로 직접 실행될 때만 동작한다 (테스트에서 import할 때는 실행하지 않음).
if (process.argv[1]?.endsWith("record-answer.mjs")) await main();
