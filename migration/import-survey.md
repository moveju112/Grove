# 기존 데이터 조사와 import 설계 (MIG-001~003, FLOW-08)

조사 방식: 읽기 전용. 자격증명 파일(`provider-accounts*.json`, OAuth 캐시)과 Postgres 데이터(`pgdata`)는 열지 않았다. 대화 파일은 key 구조·타입·개수만 집계하고 내용은 출력하지 않았다(2026-11-05).

## 위치

| 위치 | 내용 | 이전 대상 |
|---|---|---|
| `<기존 제품 데이터>/sessions/*.json` | 대화 기록(형식 version 2), 945개·항목 69,999개. `*.lock` 38개, `delivery-reports` | **가져옴**(`grove import(삭제됨)`) |
| `<기존 제품 데이터>/<이전 서버>/config.json`(+backup) | 이전 서버 설정 | 가져오지 않음(설정 체계가 다름, 사용자가 Grove 설정에서 다시 지정) |
| `<기존 제품 데이터>/기존 엔진/data/provider-accounts*.json`, `*-oauth-*` | 계정·OAuth | **가져오지 않음**(MIG-009/010, 재로그인 필요) |
| `기존 엔진/data/pgdata`, `history/*.jsonl`, `gateway-*` | 런타임 DB·추적·사용량 로그 | 가져오지 않음(런타임 내부, 대화 표시 기록은 sessions에 있음) |
| `기존 엔진/data/agents`, `bots`, `goals`, 메모리 | 에이전트·봇·Goal·메모리 | 이번 범위 밖(MIG-003, 형식 조사 필요) |

## 대화 파일 형식(version 2)

최상위: `version, id, cwd, promptHash, nativeSessionId, createdAt(ms), updatedAt(ms), items[], receipts{}, active, usage{}, historyTruncated` + 선택 `effortSettings, quotaResume, nativeRoute, backgroundTasks, backgroundEpoch`.

`items[]` = `{ timestamp(ISO), item }`. `item.type` 분포:

| type | 개수 | 필드 | Grove 표현 |
|---|---|---|---|
| user_message | 3,118 | id, clientMessageId, text | `user` {text} |
| assistant_message | 10,523 | id, text, phase?(commentary 2,873 / final_answer 1,391 / 없음) | `assistant` {text, imported_phase} |
| tool_call | 55,614 | callId, name, status(completed/failed/canceled/running 9), detail{type: plain_text, text}, error | `note` imported_tool(표시 전용) |
| notification | 644 | level(info/warning), message, source? | `note` imported_notice |
| compaction | 70 | trigger(auto), preTokens, status — **요약문 없음** | `note` imported_compaction |
| error | 30 | message | `note` imported_notice(level=error) |

## 결정

- **재개 범위:** 도구 호출은 표시 텍스트뿐이라 모델용 tool/result 짝을 복원할 수 없고, 압축 요약문도 없다. 그래서 import한 대화는 열람할 수 있고, 후속 요청에는 user·assistant 텍스트만 모델 입력으로 쓴다(`resume: text_only`). 대화 맨 앞 안내와 화면에 이 범위를 표시한다(MIG-008, MIG-014).
- **결과 불명:** `running` 도구와 `active` 턴은 `interrupted`로 옮긴다. 도구 호출 행·턴을 만들지 않으므로 재실행 경로가 없다(MIG-015).
- **정체성:** `import_map(source, source_id)`이 기본 키다. 같은 원본을 다시 가져오면 건너뛰고, 가져온 뒤 원본 내용이 바뀌면 덮어쓰지 않고 `changed_since_import`로 보고한다(MIG-005, MIG-012).
- **검증:** 대화마다 원본에서 정규화한 (role, content) 목록의 hash와 DB에서 되읽은 값의 hash·개수를 같은 transaction 안에서 비교하고, 다르면 그 대화를 롤백한다. 정규화 기준이 같으므로 표현만 다른 같은 데이터는 충돌로 보지 않는다(MIG-007, MIG-013).
- **프로젝트:** `cwd`별로 프로젝트를 만들거나 재사용한다. 없는 경로(22개)도 프로젝트로 두고, 기존 재연결 기능으로 고친다.
- **옮기지 않음:** 턴 영수증·사용량·effort·quota·native route·prompt hash. dry-run과 결과 보고서의 `not_imported`에 항목과 개수를 표시한다(MIG-004).
- **원본 보존:** 원본은 읽기만 하고, 서버와 같은 데이터 디렉터리 잠금을 잡는다(서버 실행 중 거부). 원본·백업 삭제 기능은 두지 않는다(MIG-011, MIG-017).

## 실데이터 검증(2026-11-05, scratch 데이터 디렉터리, 원본 사본 대상)

dry-run: 945개 모두 가져올 수 있음, 해석 실패·미지 항목 0. 결과 불명 11건(실행 중 도구 9 + 활성 턴 2), 잘린 기록 2건, 새 프로젝트 31개(없는 경로 22개).
실행: 945개 import, 대화별 hash 검증 모두 일치, 메시지 70,944개(안내 945개 포함), 소요 49초(debug 빌드). 다시 실행: 945개 모두 `already_imported`. 검증 후 scratch 사본은 삭제했다.
