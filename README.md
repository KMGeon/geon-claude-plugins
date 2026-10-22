# geon-claude-plugins

KMGeon의 개인 Claude Code 플러그인 마켓플레이스.

## 설치

```
/plugin marketplace add KMGeon/geon-claude-plugins
/plugin install deep-interview@geon-claude-plugins
```

## 플러그인

| 이름 | 설명 |
|:---|:---|
| [deep-interview](plugins/deep-interview) | 코드 작업 전 요구사항 인터뷰. 한 번에 한 질문, 코드가 계산하는 모호도, 스펙 저장 후 멈춤 |

## deep-interview 사용법

```
/deep-interview [--quick|--deep] <아이디어>
```

1. 기준값을 정하고(기본 20%, `--quick` 35%, `--deep` 5%) 큰 덩어리를 먼저 확정합니다 (Round 0).
2. 가장 흐릿한 부분을 골라 한 번에 한 질문씩 묻습니다.
3. 답마다 Claude가 체크리스트(예+근거 / 아니오)에 답하고, **코드가** 모호도와 최저선을 계산해 점수표로 보여줍니다.
4. 기준 아래로 내려가면 한 번 더 의심하고, 한 문장으로 맞춰 본 뒤 스펙을 `.deep-interview/specs/`에 저장하고 멈춥니다.

## 코드가 지켜 주는 것

| 장치 | 하는 일 |
|:---|:---|
| 코드 수정 차단 | 인터뷰 중에는 그 세션의 소스 수정과 쓰기 명령을 막음 |
| 답 원문 기록 | 선택지 창 답과 채팅 메시지를 `answers.jsonl`에 그대로 남김 |
| 모호도 계산 | 체크리스트 답으로 점수를 세고, 최저선(뒤집힌 사실, 빈 덩어리, AI 대리 답)을 적용 |
| 스펙 저장 조건 | 기록이 없거나, 기준 미달이거나, 마지막 라운드 뒤 사용자 확인이 없으면 저장을 막음 |

기록은 `.deep-interview/sessions/<세션>/`(상태, 답 원문)에, 결과는 `.deep-interview/specs/`에 남습니다.
설계 근거는 [.deep-interview/specs/deep-interview-my-deep-interview.md](.deep-interview/specs/deep-interview-my-deep-interview.md)에 있습니다.

## 확인

```
node --test plugins/deep-interview/tests/*.test.mjs
claude plugin validate .
```
