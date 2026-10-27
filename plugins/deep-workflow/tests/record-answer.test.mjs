import { test } from "node:test";
import assert from "node:assert/strict";
import { SID, choose, cli, say, tempProject } from "./helpers.mjs";
import { readAnswers } from "../skills/deep-interview/scripts/state.mjs";
import { record } from "../hooks/record-answer.mjs";

test("인터뷰 중이 아니면 기록하지 않는다", () => {
	const root = tempProject();
	assert.equal(say(root, "안녕"), false);
	cli(root, "start");
	cli(root, "end", "--status", "cancelled");
	assert.equal(say(root, "끝난 뒤"), false);
	assert.equal(readAnswers(root, SID).length, 0);
});

test("채팅 메시지는 원문 그대로 기록한다", () => {
	const root = tempProject();
	cli(root, "start");
	assert.equal(say(root, "아니 그게 아니라 팀장만 승인해"), true);
	const [line] = readAnswers(root, SID);
	assert.equal(line.source, "chat");
	assert.equal(line.text, "아니 그게 아니라 팀장만 승인해");
});

test("선택지 창 답은 질문, 선택지, 고른 답을 기록한다", () => {
	const root = tempProject();
	cli(root, "start");
	assert.equal(choose(root, "범위 확인", "맞아요"), true);
	const [line] = readAnswers(root, SID);
	assert.equal(line.source, "ask");
	assert.equal(line.questions[0].header, "범위 확인");
	assert.deepEqual(Object.values(line.answers), ["맞아요"]);
});

test("선택지 창에서 고른 답이 없으면(빈 응답) 기록하지 않는다", () => {
	const root = tempProject();
	cli(root, "start");
	const empty = record({ hook_event_name: "PostToolUse", tool_name: "AskUserQuestion", session_id: SID, cwd: root, tool_input: { questions: [] }, tool_response: {} });
	assert.equal(empty, false);
	const blank = record({ hook_event_name: "PostToolUse", tool_name: "AskUserQuestion", session_id: SID, cwd: root, tool_input: { questions: [] }, tool_response: { answers: { q: "  " } } });
	assert.equal(blank, false);
	assert.equal(readAnswers(root, SID).length, 0);
});

test("다른 세션의 메시지는 기록하지 않는다", () => {
	const root = tempProject();
	cli(root, "start");
	assert.equal(record({ hook_event_name: "UserPromptSubmit", session_id: "other", cwd: root, prompt: "x" }), false);
});
