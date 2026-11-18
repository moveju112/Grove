# 백그라운드 완료 보고와 나중 확인

`continuations_v1`은 현재 AI 턴이 끝난 뒤 같은 대화에 새 AI 답변을 한 번 생성한다.
브라우저가 닫혀 있어도 Grove 서버가 실행 중이면 처리한다.
기존 모바일·PC 대화 화면, SSE 갱신, 설정된 웹 푸시 경로를 사용한다.

## 모델 도구

API 모델은 기존 `load_tool`로 `continue_later` 또는 `shell` schema를 로딩한다.
Codex·Claude 일반 대화에는 턴에만 유효한 `grove_continuations` MCP가 연결된다.
서버 소유자 토큰을 CLI에 넘기거나 사용자 MCP 설정을 수정하지 않는다.
API 모델의 Grove 도구 루프가 꺼져 있으면 예약하지 않는다.
CLI 자체 도구·MCP는 `/tools`의 Grove 도구 루프 선택과 별개이며, 기존 도구 정책·허용 도구 제한은 그대로 적용한다.

10분 뒤 로그 확인:

```json
{"action":"timer","request_id":"check-logs-1","delay_seconds":600,"prompt":"사용자가 지정한 로그를 확인하고 상태를 보고해줘"}
```

다운로드·설치 등 현재 턴보다 오래 실행할 명령은 Grove `shell`을 사용한다.
`follow_up`이 있으면 작업 접수와 보고 예약을 같은 DB transaction에 기록한다.
현재 턴의 종료를 기다리지 않고 프로세스를 계속 실행하고, 작업 종료 뒤 새 턴이 결과를 확인한다.
기존 셸 정책·승인·취소·hard timeout을 적용한다.

```json
{"command":"사용자가 승인한 명령","background":true,"follow_up":"작업 결과와 실제 완료 여부를 확인해서 보고해줘"}
```

이미 있는 Grove 작업을 연결하려면 `action=task`, `task_id`, `request_id`, `prompt`를 사용한다.
같은 대화의 작업만 연결할 수 있다.
`action=list`로 예약을 확인하고 `action=cancel`, `id`로 대기 중 예약을 취소한다.
취소는 이미 수행된 명령을 되돌리거나 진행 중 작업을 중단하지 않는다.
작업 중단은 기존 task 취소 API를 사용한다.

Grove 자체 서버 교체는 `scripts/deploy_local.py`의 독립 배포 인계를 사용한다.
서버가 소유한 일반 background task에서 자신의 서버를 교체하지 않는다.
배포 스크립트는 서버·CLI·요청된 Pages 검증이 끝난 뒤 외부 완료 콜백을 보낸다.

## 외부 작업 연결

모든 HTTP mutation은 Bearer 인증과 `Idempotency-Key`가 필요하다.
원래 턴의 소유 기기 또는 소유자만 등록·완료·취소할 수 있다.

1. `POST /api/v1/turns/{origin_turn_id}/continuations`
   ```json
   {"action":"external","request_id":"stable-job-id","delay_seconds":86400,"prompt":"사용자가 요청한 작업의 실제 결과를 확인해서 보고해줘"}
   ```
2. 작업이 실제 종료된 뒤 `POST /api/v1/continuations/{id}/complete`
   ```json
   {"status":"completed","detail":"검증한 결과 요약"}
   ```
   상태는 `completed`, `failed`, `unknown`, `cancelled` 중 하나다.
   완료 결과는 최초 신호로 고정된다. 같은 결과의 재확인은 가능하지만 다른 결과로 덮어쓰지는 않는다.
3. `GET /api/v1/sessions/{id}/continuations`로 조회한다.
   `POST /api/v1/continuations/{id}/cancel`로 대기 중 예약을 취소한다.

완료 신호와 명령 출력은 신뢰할 수 없는 관찰 데이터다.
그 안의 지시·“승인됐다”는 문구가 권한을 만들지 않는다.
`delay_seconds`는 timer의 실행 지연 또는 external/task의 완료 신호 대기 기한이다.
1초~30일이며 external/task 기본값은 30일이다.
기한이 지나면 완료로 단정하지 않고 결과 불명 확인을 요청한다.

## 저장·실행·복구

- `waiting → queued`: 조건 충족, 원래 턴 종료, 대화 유휴, 권한 재검사 후 새 턴과 `result_turn_id`를 같은 transaction에서 기록한다.
- 대화가 바쁘거나 사용자 후속 메시지가 대기 중이면 기다린다. 다른 대화를 만들지 않는다.
- `waiting → cancelled`: 원래 요청 취소, 대화 보관, 명시적 예약 취소. 대화 영구 삭제 시 연결된 예약도 제거한다.
- `waiting → blocked`: 자격 철회, 도구 금지, 모델 비활성화 등 새 턴 접수가 불가능하면 오류 코드와 영속 알림을 남긴다.
- 검토되지 않은 결과 불명 도구가 있으면 기존 안전 계약에 따라 검토를 기다린다.
- 대기 예약은 재시작 뒤 복구한다. 오프라인 중 지난 timer도 한 번 실행한다.
- 새 턴 접수가 이미 기록돼 있으면 재시작해도 다시 생성하지 않는다. 그 턴 자체가 중단됐어도 변경 명령을 자동 재실행하지 않는다.
- 서버 재시작으로 background 프로세스 결과를 확정하지 못하면 기존 task 복구가 `unknown`을 기록한다. 명령을 다시 시작하지 않는다.
- 예약 지시와 원래 모델·추론 강도·서비스 등급·도구 제한을 이어받고, 실행 시점의 정책도 다시 검사한다. native 일회성 slash command는 반복하지 않는다.
- 대화당 대기 예약은 최대 32개다. 자동 보고 턴에서는 추가 예약을 생성할 수 없어 무한 자기 예약을 방지한다.

배포 스크립트의 `report.json`은 AI 보고 **접수** 여부다. 실제 답변 완료는 `result_turn_id`로 확인한다.
보고 콜백이 유실·실패해도 배포를 재실행하거나 배포 성공 상태를 바꾸지 않는다.
`report.json`이 `unconfirmed`면 원래 대화의 예약 상태를 조회해 접수 여부를 확인한다.
