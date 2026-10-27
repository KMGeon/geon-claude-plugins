# mem0-self

[Mem0 공식 Claude Code 플러그인](https://github.com/mem0ai/mem0) 0.3.3을 **self-host Mem0 서버**용으로 포크한 플러그인입니다.

세션 기록을 이 컴퓨터에 모았다가 self-host 서버에 기억으로 저장하고, 다음 세션에서 관련 기억을 다시 불러옵니다.

## 설치

```
/plugin marketplace add KMGeon/geon-claude-plugins
/plugin install mem0-self@geon-claude-plugins
```

설치할 때 아래 값을 묻습니다.

| 설정 | 필수 | 설명 |
|:---|:---:|:---|
| `api_url` | ✅ | self-host 서버 주소. 예: `http://<서버 IP>:8888` |
| `api_key` | ✅ | 서버의 `ADMIN_API_KEY` (`X-API-Key` 헤더로 보냄) |
| `user_id` | ✅ | 기억을 묶는 사용자 ID. 여러 컴퓨터에서 같은 값을 쓰면 기억을 같이 씀 |
| `top_k` |  | 추가 검색 때 가져올 기억 수 (기본 3) |
| `max_context_chars` |  | 한 번 검색에 넣을 최대 글자 수 (기본 4000) |
| `search_scope` |  | `repo`(기본) / `dir` / `mine` |

설치 후 Claude Code를 다시 시작합니다.

## 키 보관

- 훅이 실행될 때 설정의 `api_key`를 데이터 폴더의 `api-key` 파일(권한 600)로 복사해 둡니다.
- 백그라운드 저장 작업과 MCP 서버는 이 파일을 읽습니다.
- 설정에 키가 없는 세션이 시작돼도 이 파일은 **지우지 않습니다.**
  - Claude 설정 폴더(`CLAUDE_CONFIG_DIR`)를 여러 개 쓰면 키체인 항목이 폴더마다 따로 생깁니다.
  - 데이터 폴더를 같이 쓰는 경우, 키가 없는 프로필이 공용 키 파일을 지우던 문제를 막기 위해서입니다.
- 키를 직접 넣을 때는 아래처럼 합니다.

```bash
printf '%s' '<ADMIN_API_KEY>' > ~/.claude/plugins/data/mem0-self-geon-claude-plugins/api-key
chmod 600 ~/.claude/plugins/data/mem0-self-geon-claude-plugins/api-key
```

## 명령

| 명령 | 하는 일 |
|:---|:---|
| `/mem0-self:status` | 저장 상태, 키, 서버 연결 확인 |
| `/mem0-self:search` | 기억 검색 |
| `/mem0-self:remember` | 지금 내용을 기억으로 저장 |
| `/mem0-self:forget` | 이 저장소의 기억 삭제 |
| `/mem0-self:pause` / `resume` | 수집 멈춤 / 다시 시작 |

## 공식 플러그인과 다른 점

| 항목 | 공식 0.3.3 | 이 포크 |
|:---|:---|:---|
| 서버 | Mem0 Platform (`m0-` 키) | self-host OSS 서버 (`/memories`, `/search`, `X-API-Key`) |
| 서버 주소 | 고정 | `api_url` 설정 (없으면 `http://localhost:8888`) |
| 키 환경 변수 | `MEM0_API_KEY` 사용 | 무시 (Platform 키가 섞이지 않게) |
| 텔레메트리 | 기본 켜짐 | 기본 꺼짐 (`MEM0_TELEMETRY=true`일 때만) |
| 세션 시작 때 키 파일 | 설정에 키가 없으면 삭제 | 삭제하지 않음 |

## 라이선스

Apache-2.0. 원본 저작권은 Mem0에 있으며, 위 표의 내용을 바꿨습니다. 전문은 [LICENSE](LICENSE)를 보세요.
