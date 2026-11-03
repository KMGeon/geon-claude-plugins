import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MAX_CONDITION_LENGTH, buildCondition, run, sectionBullets } from "../skills/deep-goal/scripts/goal.mjs";

const SPEC = `# 사내 휴가 신청 기능 — 딥 인터뷰 스펙

## 한눈에 보기
- 한 문장 요약: 직원이 신청하면 팀장이 승인한다.
- 결과: 기준 통과

## 무엇을 만드나
설명

**고정 항목**
- \`화면:신청폼\` — 직원이 휴가를 신청하는 화면

## 경계
**지킬 조건**
- 팀장 1단계 승인

**하지 않을 것**
- 반차

**나중으로 미룬 것**
- 없음

## 다 됐다는 기준
- [ ] 신청하면 팀장 DM이 온다
- [ ] 과거 날짜는 거부된다
`;

function project(spec = SPEC, name = "deep-interview-leave.md") {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "deep-goal-test-"));
	fs.mkdirSync(path.join(root, ".deep-interview", "specs"), { recursive: true });
	fs.writeFileSync(path.join(root, ".deep-interview", "specs", name), spec);
	return { root, spec: `.deep-interview/specs/${name}` };
}

test("조건: 완료 기준 본문, 기준별 테스트 출력 요구, 경계, 테스트 약화 금지가 들어가고 목표 파일이 생긴다", () => {
	const { root, spec } = project();
	const out = run(["condition", "--spec", spec, "--root", root, "--test-cmd", "npm test"], root);
	assert.equal(out.ok, true);
	assert.equal(out.form, "full");
	assert.equal(out.goal_path, ".deep-interview/goals/leave.md");
	assert.match(out.condition, /완료 기준 2개가 모두 충족됐다: AC-1 신청하면 팀장 DM이 온다; AC-2 과거 날짜는 거부된다\./);
	assert.match(out.condition, /종료 코드 0으로 끝난 출력/);
	assert.match(out.condition, /`npm test`/);
	assert.match(out.condition, /하지 않을 것\(반차\)/);
	assert.match(out.condition, /지킬 조건\(팀장 1단계 승인\)/);
	assert.match(out.condition, /건너뛰게 바꿔서 통과시키지 않았다/);
	assert.ok(!out.condition.includes("\n"), "조건은 한 줄");
	assert.equal(out.goal_command, `/goal ${out.condition}`);
	const file = fs.readFileSync(path.join(root, out.goal_path), "utf8");
	assert.match(file, /- \[ \] AC-1 — 신청하면 팀장 DM이 온다/);
	assert.match(file, /- `화면:신청폼` — 직원이 휴가를 신청하는 화면/);
	assert.ok(file.includes(out.condition));
	assert.deepEqual(out.fixed_items, ["화면:신청폼"]);
});

test("조건: 기준 미달 스펙은 --force 없이는 거부한다", () => {
	const { root, spec } = project(SPEC.replace("- 결과: 기준 통과", "- 결과: 기준 미달로 조기 종료"));
	assert.throws(() => run(["condition", "--spec", spec, "--root", root], root), /조기 종료/);
	const out = run(["condition", "--spec", spec, "--root", root, "--force"], root);
	assert.equal(out.forced, true);
});

test("조건: 완료 기준이 없으면 거부한다", () => {
	const { root, spec } = project(SPEC.replace(/## 다 됐다는 기준[\s\S]*$/, ""));
	assert.throws(() => run(["condition", "--spec", spec, "--root", root], root), /다 됐다는 기준/);
});

test("조건: 한도를 넘으면 기준 본문 대신 파일 참조로 줄이고, 그래도 넘으면 실패한다", () => {
	const criteria = Array.from({ length: 40 }, (_, i) => ({ id: `AC-${i + 1}`, text: "아주 긴 기준 ".repeat(20) }));
	const short = buildCondition({ goalPath: ".deep-interview/goals/x.md", criteria, keep: [], avoid: [], testCmd: null });
	assert.equal(short.form, "short");
	assert.ok(short.condition.length <= MAX_CONDITION_LENGTH);
	assert.match(short.condition, /40개\(AC-1…AC-40\)/);
	assert.throws(() => buildCondition({ goalPath: "g.md", criteria, keep: ["조건 ".repeat(1500)], avoid: [], testCmd: null }), /4000자를 넘습니다/);
});

test("경계 절 읽기: 굵은 소제목 아래 줄만, 다음 소제목에서 멈춘다", () => {
	assert.deepEqual(sectionBullets(SPEC, "지킬 조건"), ["팀장 1단계 승인"]);
	assert.deepEqual(sectionBullets(SPEC, "하지 않을 것"), ["반차"]);
	assert.deepEqual(sectionBullets(SPEC, "없는 절"), []);
});
