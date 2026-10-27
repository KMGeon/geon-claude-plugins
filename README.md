# geon-claude-plugins

KMGeon의 개인 Claude Code 플러그인 마켓플레이스.

## 설치

```
/plugin marketplace add KMGeon/geon-claude-plugins
/plugin install deep-workflow@geon-claude-plugins
```

## 플러그인

[deep-workflow](plugins/deep-workflow) 하나에 스킬 두 개가 들어 있습니다. 각각 따로 불러도 되고, 인터뷰가 끝나면 빌드로 자동으로 이어집니다.

| 스킬 | 설명 |
|:---|:---|
| `/deep-interview` | 코드 작업 전 요구사항 인터뷰. 한 번에 한 질문, 코드가 계산하는 모호도, 스펙 저장 후 deep-build로 넘김 |
| `/deep-build` | 스펙을 받아 설계 → 계획 → 검토 → 구현 → 완료 판정까지 사람 승인 없이 진행. 계획은 고정 항목·완료 기준이 모두 연결돼야 저장되고, 작업은 코드가 실행한 테스트가 통과해야 끝남 |

## deep-interview 사용법

```
/deep-interview [--quick|--deep] <아이디어>
```

1. 기준값을 정하고(기본 20%, `--quick` 35%, `--deep` 5%) 큰 덩어리를 먼저 확정합니다 (Round 0).
2. 가장 흐릿한 부분을 골라 한 번에 한 질문씩 묻습니다.
3. 답마다 Claude가 체크리스트(예+근거 / 아니오)에 답하고, **코드가** 모호도와 최저선을 계산해 점수표로 보여줍니다.
4. 기준 아래로 내려가면 한 번 더 의심하고, 한 문장으로 맞춰 본 뒤 스펙을 `.deep-interview/specs/`에 저장합니다.
5. 기준을 통과한 스펙은 `deep-build`로 넘어갑니다. 조기 종료 스펙은 한 번 묻습니다.

## deep-build 사용법

```
/deep-build .deep-interview/specs/deep-interview-<주제>.md
```

1. 스펙에서 고정 항목 ID와 완료 기준 ID(AC-1…)를 뽑습니다.
2. 설계 문서를 씁니다. 시퀀스·상태·ERD·API 네 절이 모두 있어야 하고, 해당 없으면 "생략: 이유" 한 줄을 둡니다.
3. 작업 목록을 만듭니다. 모든 고정 항목과 완료 기준에 담당 작업이 있어야 코드가 계획 파일을 씁니다.
4. 계획을 쓰지 않은 새 에이전트가 스펙·설계·계획을 대조합니다. 수정은 최대 3회, 넘으면 멈춥니다.
5. 구현: 작업 3개 이하면 한 세션이, 4개 이상이면 작업별 구현 에이전트 + 리뷰 에이전트가 만듭니다. 작업은 **코드가 테스트 명령을 직접 실행**해 통과해야 끝나고, 3회 실패하면 전체를 멈춥니다.
6. 완료 판정: 완료 기준(AC)마다 증거 명령을 코드가 실행하고, 새 에이전트가 전체를 스펙과 대조해 `pass`하면 끝납니다. 커밋은 자동으로 하지 않고 묻습니다.

## 코드가 지켜 주는 것

| 장치 | 하는 일 |
|:---|:---|
| 코드 수정 차단 | 인터뷰 중에는 그 세션의 소스 수정과 쓰기 명령을 막음 |
| 답 원문 기록 | 선택지 창 답과 채팅 메시지를 `answers.jsonl`에 그대로 남김 |
| 모호도 계산 | 체크리스트 답으로 점수를 세고, 최저선(뒤집힌 사실, 빈 덩어리, AI 대리 답)을 적용 |
| 스펙 저장 조건 | 기록이 없거나, 기준 미달이거나, 마지막 라운드 뒤 사용자 확인이 없으면 저장을 막음 |
| 계획 저장 조건 | 모든 고정 항목·완료 기준에 담당 작업이 있어야 계획 파일을 씀 |
| 작업 완료 판정 | 테스트 명령을 코드가 실행해 종료 코드 0일 때만 완료. 작업당 3회, 검토·리뷰 3회 제한 |
| 완료 기준 증거 | AC마다 증거 명령을 코드가 실행, 전부 통과해야 최종 리뷰로 넘어감 |

기록은 `.deep-interview/sessions/<세션>/`(상태, 답 원문)에, 결과는 `.deep-interview/specs/`에 남습니다.
설계 근거는 [.deep-interview/specs/deep-interview-my-deep-interview.md](.deep-interview/specs/deep-interview-my-deep-interview.md)에 있습니다.

## 확인

```
node --test plugins/deep-workflow/tests/*.test.mjs
claude plugin validate .
```
