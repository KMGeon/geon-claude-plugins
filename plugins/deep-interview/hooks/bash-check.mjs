// 인터뷰 중에 허용하는 '읽기 전용' Bash 명령 목록과 검사기.
// 코드를 살펴보는 건 되고, 바꾸는 건 안 된다.
// 목록에 없는 명령은 모두 막는다 (허용 목록 방식). 놓친 명령은 '막히는' 쪽으로 틀리게 된다.

// 파일을 바꾸지 않는 명령. 이 중에서도 쓰기 옵션이 있는 명령(git, find, sed, sort, tree)은 아래에서 따로 검사한다.
const READ_ONLY_COMMANDS = new Set([
	"basename",
	"cat",
	"cd",
	"cmp",
	"column",
	"cut",
	"date",
	"df",
	"diff",
	"dirname",
	"du",
	"echo",
	"egrep",
	"fd",
	"fgrep",
	"file",
	"find",
	"git",
	"grep",
	"head",
	"jq",
	"ls",
	"nl",
	"printf",
	"pwd",
	"readlink",
	"realpath",
	"rg",
	"sed",
	"sort",
	"stat",
	"tail",
	"tr",
	"tree",
	"true",
	"uniq",
	"wc",
	"which",
]);

// 저장소를 바꾸지 않는 git 하위 명령.
const READ_ONLY_GIT = new Set([
	"blame",
	"cat-file",
	"describe",
	"diff",
	"grep",
	"log",
	"ls-files",
	"ls-tree",
	"rev-parse",
	"shortlog",
	"show",
	"status",
]);

// find에서 파일을 지우거나, 다른 명령을 실행하거나, 파일에 쓰는 옵션.
const FIND_MUTATING = new Set(["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls"]);

/** 거부 결과를 만든다. */
function deny(reason) {
	return { ok: false, reason };
}

/**
 * 명령 문자열을 `;`, `&&`, `||`, `|` 등으로 나눈 '구간'별 단어 목록으로 바꾼다.
 * 따옴표 안의 `>`, `|` 같은 글자는 연산자로 보지 않는다 (JSON 인자를 안전하게 넘기기 위해).
 * 대신 숨은 명령 실행이 가능한 구문은 바로 거부한다:
 * 명령 치환 `$(...)`·백틱, 프로세스 치환 `<(...)`, heredoc `<<`, `/dev/null` 이외로의 출력 리다이렉트.
 */
export function tokenize(command) {
	const segments = [];
	let words = [];
	let current = "";
	let inWord = false;
	const pushWord = () => {
		if (inWord) words.push(current);
		current = "";
		inWord = false;
	};
	const endSegment = () => {
		pushWord();
		if (words.length) segments.push(words);
		words = [];
	};
	// 리다이렉트(`>`, `<`) 뒤에 오는 대상 경로를 읽는다.
	const readRedirectTarget = start => {
		let j = start;
		while (j < command.length && /[ \t]/.test(command[j])) j += 1;
		let target = "";
		while (j < command.length && !/[\s;&|<>()]/.test(command[j])) {
			target += command[j];
			j += 1;
		}
		return { target, end: j };
	};

	let i = 0;
	while (i < command.length) {
		const c = command[i];
		const next = command[i + 1];
		// 작은따옴표: 안쪽은 셸이 아무것도 해석하지 않으므로 그대로 한 단어로 붙인다.
		if (c === "'") {
			const close = command.indexOf("'", i + 1);
			if (close < 0) return deny("따옴표가 닫히지 않음");
			current += command.slice(i + 1, close);
			inWord = true;
			i = close + 1;
			continue;
		}
		// 큰따옴표: 안쪽에서도 `$(...)`와 백틱은 실행되므로 거부한다.
		if (c === '"') {
			let j = i + 1;
			let buffer = "";
			while (j < command.length && command[j] !== '"') {
				if (command[j] === "\\" && j + 1 < command.length) {
					buffer += command[j + 1];
					j += 2;
					continue;
				}
				if (command[j] === "`" || (command[j] === "$" && command[j + 1] === "(")) return deny("명령 치환");
				buffer += command[j];
				j += 1;
			}
			if (j >= command.length) return deny("따옴표가 닫히지 않음");
			current += buffer;
			inWord = true;
			i = j + 1;
			continue;
		}
		// 역슬래시 이스케이프: 다음 글자를 일반 글자로 취급한다 (줄 끝이면 줄 이어쓰기).
		if (c === "\\" && next !== undefined) {
			if (next !== "\n") {
				current += next;
				inWord = true;
			}
			i += 2;
			continue;
		}
		if (c === "`" || (c === "$" && next === "(")) return deny("명령 치환");
		if ((c === "<" || c === ">") && next === "(") return deny("프로세스 치환");
		if (c === "<" && next === "<") return deny("heredoc 대신 Write 도구로 임시 폴더에 파일을 쓰세요");
		// 출력 리다이렉트: `2>&1` 같은 fd 복제와 `/dev/null`만 허용한다.
		if (c === ">" || (c === "&" && next === ">")) {
			if (c === ">" && inWord && /^\d$/.test(current)) {
				current = "";
				inWord = false;
			} else {
				pushWord();
			}
			let j = c === "&" ? i + 2 : i + 1;
			if (command[j] === ">") j += 1;
			if (command[j] === "&") {
				j += 1;
				while (/\d/.test(command[j] ?? "")) j += 1;
				i = j;
				continue;
			}
			const { target, end } = readRedirectTarget(j);
			if (target !== "/dev/null") return deny(`${target || "(비어 있음)"}(으)로 출력 리다이렉트`);
			i = end;
			continue;
		}
		// 입력 리다이렉트(`< 파일`)는 읽기라서 허용하고 대상만 건너뛴다.
		if (c === "<") {
			pushWord();
			const { end } = readRedirectTarget(i + 1);
			i = end;
			continue;
		}
		// 구간 구분자: 각 구간을 따로 검사해야 `ls; rm -rf x` 같은 이어붙이기를 잡을 수 있다.
		if (c === ";" || c === "\n" || c === "|" || c === "&" || c === "(" || c === ")" || c === "{" || c === "}") {
			endSegment();
			i += (c === "|" || c === "&") && next === c ? 2 : 1;
			continue;
		}
		if (/\s/.test(c)) {
			pushWord();
			i += 1;
			continue;
		}
		current += c;
		inWord = true;
		i += 1;
	}
	endSegment();
	return { ok: true, segments };
}

/** 명령 앞의 `FOO=bar` 같은 환경 변수 지정을 떼어 낸다. */
function stripAssignments(words) {
	let index = 0;
	while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index])) index += 1;
	return words.slice(index);
}

/** `node .../scripts/interview.mjs ...` 형태인지. 인터뷰를 끝내려면 이 스크립트를 실행해야 하므로 항상 허용한다. */
export function isInterviewScript(words) {
	return words[0] === "node" && typeof words[1] === "string" && /(^|\/)scripts\/interview\.mjs$/.test(words[1]);
}

/**
 * git 명령 검사. `-C 경로`, `--no-pager` 같은 전역 옵션을 건너뛰고 하위 명령을 본다.
 * branch/remote/tag/config는 '조회'하는 형태일 때만 허용한다. 문제가 없으면 null.
 */
function checkGit(args) {
	let index = 0;
	while (index < args.length) {
		const arg = args[index];
		if (arg === "-C" || arg === "-c") index += 2;
		else if (arg === "--no-pager" || arg.startsWith("--git-dir=") || arg.startsWith("--work-tree=")) index += 1;
		else break;
	}
	const sub = args[index];
	const rest = args.slice(index + 1);
	if (READ_ONLY_GIT.has(sub)) {
		if (rest.some(arg => arg === "--output" || arg.startsWith("--output="))) return "git --output은 파일을 씁니다";
		return null;
	}
	if (sub === "branch" && rest.every(arg => ["-a", "-r", "-v", "-vv", "--list", "--show-current", "--all"].includes(arg))) return null;
	if (sub === "remote" && (rest.length === 0 || rest[0] === "-v" || rest[0] === "get-url" || rest[0] === "show")) return null;
	if (sub === "tag" && (rest.length === 0 || rest[0] === "-l" || rest[0] === "--list")) return null;
	if (sub === "config" && rest.length > 0 && ["--get", "--list", "-l", "--get-all"].includes(rest[0])) return null;
	return `git ${sub ?? ""}은(는) 읽기 전용이 아닙니다`;
}

/** 한 구간(명령 하나)을 검사한다. 문제가 없으면 null, 있으면 이유 문자열. */
function checkSegment(rawWords) {
	const words = stripAssignments(rawWords);
	if (words.length === 0) return null;
	if (isInterviewScript(words)) return null;
	const name = words[0].split("/").pop();
	const args = words.slice(1);
	if (!READ_ONLY_COMMANDS.has(name)) return `\`${name}\`은(는) 읽기 전용 허용 목록에 없습니다`;
	switch (name) {
		case "git":
			return checkGit(args);
		case "find":
			return args.some(arg => FIND_MUTATING.has(arg)) ? "find의 -exec/-delete/-fprint 옵션" : null;
		case "sed":
			if (args.some(arg => arg.startsWith("-i") || arg.startsWith("--in-place"))) return "sed -i는 파일을 고칩니다";
			if (!args.includes("-n")) return "sed는 -n과 함께만 쓸 수 있습니다";
			return args.some(arg => /(^|[;\s}])[wWe](\s|$)/.test(arg)) ? "sed의 w/e 명령" : null;
		case "sort":
			return args.some(arg => arg.startsWith("-o") || arg.startsWith("--output")) ? "sort -o는 파일을 씁니다" : null;
		case "tree":
			return args.some(arg => arg === "-o") ? "tree -o는 파일을 씁니다" : null;
		default:
			return null;
	}
}

/** 모든 구간이 읽기 전용 명령이거나 인터뷰 스크립트면 `{ ok: true }`, 아니면 `{ ok: false, reason }`. */
export function checkBashCommand(command) {
	if (typeof command !== "string") return deny("명령이 없습니다");
	const parsed = tokenize(command);
	if (!parsed.ok) return parsed;
	for (const words of parsed.segments) {
		const problem = checkSegment(words);
		if (problem) return deny(problem);
	}
	return { ok: true };
}
