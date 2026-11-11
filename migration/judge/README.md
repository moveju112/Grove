# 판정기(judge): FLOW 시나리오 harness

재설계 이전이라 구·신 제품이 공유하는 외부 인터페이스가 없다(DEC-014, DEV-005).
그래서 원본 동작에서 도출한 TODO §2 FLOW 시나리오를 Grove의 공개 표면(HTTP API, 실제 서버 + Chrome)으로 실행한다.

## 실행

```bash
python3 scripts/build.py test --rust api turns   # 변경에 해당하는 서버 target만 선택
python3 scripts/build.py test --vitest app/state/events.test.ts --typecheck
python3 scripts/build.py test --e2e e2e/workspace.spec.ts  # debug 서버 + 웹 + 선택 Chrome 흐름
python3 scripts/build.py test --full            # 전체 인수가 명시적으로 필요한 경우만
python3 migration/judge/mutate.py            # 판정기 자체 검증(결함 주입)
```

선택 검사의 성공은 전체 판정 시나리오의 통과를 뜻하지 않는다. 관련 입력이 그대로인 통과 결과는 재사용하고,
실패한 단계 뒤에 실행되지 않은 검사는 통과로 세지 않는다. 개발용 E2E를 위해 release 빌드를 만들지 않는다.

## 판정기 검증(2026-11-05)

`mutate.py`가 결함 8개를 하나씩 넣은 사본에서 해당 시험을 실행했고, 8개 모두 실패로 잡혔다(CAUGHT 8/8).
결함 종류: origin 검사 제거, idempotency 충돌 무시, 초안 revision 무시, crash 후 unknown 대신 succeeded, 거부를 승인으로 처리, 경로 탈출 허용, 편집 충돌 무시, SSE cursor 중복 재생.

## Burndown (2026-11-05 갱신)

17개 중 통과 13 · 부분 2(FLOW-02 외부 실계정, FLOW-07 실기기) · 미착수 0 · blocker 2(FLOW-15 품질 비교, FLOW-17 실기기). FLOW-07은 부분이면서 실기기 blocker.

## 시나리오 대응

| ID | 시나리오 | 판정 시험 | 상태 |
|---|---|---|---|
| FLOW-01 | 인증 없는/교차 사이트 요청 | `tests/api.rs::health_is_public_and_api_requires_token`, `cross_site_and_foreign_host_are_rejected` | 통과 |
| FLOW-02 | 실제 계정 로그인·첫 대화·새로고침 | 브라우저 로그인·새로고침 복원 `web/e2e/workspace.spec.ts`. 실모델 첫 대화·새로고침은 로컬 경량 모델로 `web/e2e/real-model.spec.ts`(qwen2.5:3b, 3회 통과), 서버 `tests/real_model.rs` | 부분(외부 provider 실계정 미검증) |
| FLOW-03 | 파일 변경 거부 후 재시도 | `tests/turns.rs::denied_write_keeps_file_absent_and_model_sees_denial`, e2e 거부 시험 | 통과 |
| FLOW-04 | 접수 응답 유실 후 같은 request ID 재전송 | `tests/turns.rs::one_active_turn_per_session_and_idempotent_create`, `tests/api.rs::idempotency_*` | 통과 |
| FLOW-05 | stream 단절 후 cursor 재생 | `tests/api.rs::sse_cursor_replay_without_duplicates`, `sse_expired_cursor_requires_resync` | 통과 |
| FLOW-06 | 외부 mutation 중 강제 종료 | `tests/turns.rs::crash_during_tool_marks_unknown_and_requires_review`, `running_turn_interrupted_by_restart_is_not_rerun` | 통과 |
| FLOW-07 | 승인 대기 중 기기 이동·process death | 서버 측 `approval_survives_restart_and_resumes` 통과; Android 실기기 미검증 | 부분(blocker: 실기기) |
| FLOW-08 | 긴 대화 import 후 재개 | `tests/import.rs`(개수·hash 일치, 원본 불변, 재실행 무중복, 재개는 텍스트만 명시·모델 입력 확인), `web/e2e/import.spec.ts`(열람·후속 대화). 실데이터 945개 dry-run·import·재실행 검증 | 통과(재개 범위: text_only) |
| FLOW-09 | 작업 중 업데이트·적용 실패 복구 | `scripts/test_update.py`(확인 중 무중단, 실행 중 작업 보류·종료 코드 3, 고장 버전 C readiness 실패 → 이전 버전·snapshot 복원, 새 쓰기가 있으면 덮어쓰지 않음 `update::tests::recovery_never_overwrites_new_writes`) | 통과(Linux) |
| FLOW-10 | 서버만 변경한 릴리스 | `scripts/test_build.py::test_server_only_does_not_rebuild_web_but_runs_e2e` 외 7개, `scripts/build.py package` 재사용·손상 artifact 재빌드, 업데이트는 같은 artifact hash면 재시작 없음 | 통과(APK 경로 없음) |
| FLOW-11 | 프로젝트 A/B 분할 중 요청 귀속 | `web/e2e/workspace.spec.ts`(두 pane 저장 메시지가 각 세션에만 기록) | 통과(셸 cwd·파일 변경 귀속은 서버 시험에서 project_id 고정으로 검증) |
| FLOW-12 | 최근 탭 전환·재시작·폰 이어보기 | `tests/workspace.rs::two_projects_recent_and_split_survive_restart`, `drafts_conflict_instead_of_silent_overwrite`, e2e 초안·모바일 | 통과(실기기 폰 미검증) |
| FLOW-13 | 기본 에이전트 수정·비교·복원 | `tests/definitions.rs`, e2e 설정 시험 | 통과(품질 비교는 EVAL blocker) |
| FLOW-14 | 설정 검색·범위·저장 실패 | e2e 설정 검색, `tests/settings.rs::precedence_and_isolation_between_projects`(A 변경이 B에 미적용), `invalid_values_scope_and_conflicts_keep_previous`(실패 시 기존 값 유지·충돌 시 현재값) | 통과 |
| FLOW-15 | 프롬프트 후보 품질 비교 | 실제 모델 시험 필요 | **blocker: 과금 승인 없음** |
| FLOW-16 | PWA 새 버전 중 입력 보존 | `web/e2e/pwa-update.spec.ts`(stream 진행 중 새 sw 발행 → 배너만, stream 완료·초안 유지, 사용자 선택 시 1회 reload 후 초안·대화·연결 복원, 턴 재실행 없음). 즉시 활성화 결함 주입 사본이 실패함을 확인 | 통과 |
| FLOW-17 | Windows/Linux 서버 + Android PWA 실제 연결 | Linux만 검증 | **blocker: Windows·Android 실기기 없음** |
