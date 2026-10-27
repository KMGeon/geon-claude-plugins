import { test } from "node:test";
import assert from "node:assert/strict";
import { checkBashCommand } from "../hooks/bash-check.mjs";

test("읽기 전용 셸 명령은 통과한다", () => {
	for (const command of [
		"ls -la",
		"git log --oneline -5 && git status",
		"git diff HEAD~1 -- src",
		"grep -rn 'foo > bar' src | head -20",
		"rg -n TODO src",
		"sed -n '1,40p' README.md",
		"find . -name '*.ts' 2>/dev/null | wc -l",
		"cat package.json | jq .scripts",
		'node "/Users/a b/plugins/deep-workflow/skills/deep-interview/scripts/interview.mjs" end --session s1',
	]) {
		assert.deepEqual(checkBashCommand(command), { ok: true }, command);
	}
});

test("파일을 바꾸는 셸 명령은 막는다", () => {
	for (const command of [
		"rm -rf src",
		"echo hi > file.txt",
		"cat a >> b",
		"ls; touch x",
		"git commit -m wip",
		"git checkout -b x",
		"git branch -D old",
		"sed -i 's/a/b/' f",
		"find . -delete",
		"find . -exec rm {} \\;",
		"ls $(rm -rf x)",
		'echo "$(touch x)"',
		"cat <<'EOF' > f\nx\nEOF",
		"npm install",
		"npm test",
		'node "/x/scripts/interview.mjs" end --session s; rm -rf src',
		"node script.js",
		"sort -o out.txt in.txt",
	]) {
		assert.equal(checkBashCommand(command).ok, false, command);
	}
});

test("막을 때 이유를 알려준다", () => {
	assert.match(checkBashCommand("npm install").reason, /허용 목록에 없습니다/);
	assert.match(checkBashCommand("echo hi > a.txt").reason, /리다이렉트/);
	assert.match(checkBashCommand("git push").reason, /읽기 전용이 아닙니다/);
});
