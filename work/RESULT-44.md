<!-- grove-handoff:v1
{"state":"ready","remaining":[],"blockers":[],"integration_checks":[]}
-->

# 44 — REC-012 기록 경계 저장 실패·재시작 수렴

- 상태: 소유 범위 구현·기존 API 연결·선택 검증 완료. blocker 없음.
- worktree: `<세션 worktree 루트>/b02-44-recovery-faults`
- branch: `parallel/b02-recovery-faults`
- 고정 기준: `7d5a6e57776f5770162b577dc4e372a2d67ae3e3`에서 시작했고 최초 HEAD·merge-base가 모두 일치했으며 clean이었다.
- 정본: `<원본 저장소>/work/ENTRY.md`, `<원본 저장소>/work/COMMON.md`, `<원본 저장소>/work/44.md`. README의 경로·브랜치 행과도 일치한다.

## 변경·연결 계약

| 경로 | 제공 동작 |
|---|---|
| `tests/recovery_faults.rs` | Unix 전용 시험 8개. 13개 기록 지점 각각에 실제 SQLite full·OS 권한 거부를 주입하고 원문·receipt·소유권·반복 재시작 수렴을 검증한다. |
| `src/runner.rs::recover_on_start` | 재현된 live-owner 결함만 수정했다. 현재 epoch의 턴에 속한 `running`·`approved` 도구는 복구 대상에서 제외한다. |
| `work/RESULT-44.md` | 이 인계. |

새 export·route·UI·schema·dependency는 없다. `server::start`가 원래 호출하던 `runner::recover_on_start`에 직접 연결되므로 추가 mount나 등록은 필요 없다.
실행 루프·`load_step`·store·도구 구현·공용 fixture는 변경하지 않았다. `tests/recovery.rs`와 `tests/turns.rs`도 변경 없이 회귀 근거로 재사용했다.

기존 `GET /api/v1/recovery`, 턴 상세·메시지 조회, `/turns/{id}/acknowledge`, 도구 상세·`observe`·revision/fingerprint 기반 `review`를 사용한다.
Bearer 인증·Idempotency-Key·revision·오류 envelope 계약은 그대로다. 쓰기 실패는 `storage_full`/507 또는 `storage_permission`/503이고, 이후 DB 작업은 `storage_recovery_required`로 차단된다.
목록은 원문 없이 요약만 제공한다. 검토는 `unknown`을 성공으로 바꾸지 않으며 확인·검토 뒤에도 증거를 남긴다.

## 장애 주입과 REC-012 충족 근거

모든 쓰기는 시험이 만든 `tempfile::TempDir` 안에서만 수행한다.
연결 전용 TEMP trigger가 지정 기록 SQL에서 실제 실패를 일으키며 제품 schema에는 남지 않는다. 합성 `ApiError`, `RAISE`, 공용 fault hook은 사용하지 않는다.

- 용량: 기존 `actual_sqlite_full_stops_live_work_and_restart_keeps_the_result_unknown`의 방식을 확장했다. 현재 페이지 수에 작은 여유 32페이지를 둔 `max_page_count`에서 trigger가 1 MiB `zeroblob`을 실제 할당하다 SQLite full로 실패한다. 선행 소규모 쓰기가 아니라 지정 경계의 할당을 실패시킨다. 공유 디스크를 채우지 않는다.
- 권한: 전용 보조 fixture DB를 0400으로 만들고, 실행 사용자의 `OpenOptions::write(true)`가 실제 `PermissionDenied`를 반환하는지 먼저 확인한다. 그 DB를 ATTACH한 연결의 TEMP trigger 쓰기가 실제 SQLite read-only 오류를 반환한다. chmod만으로 주입 성공을 간주하지 않는다. fixture 권한은 Drop에서 복원한다.
- 오류 이후: recovery latch와 다음 DB closure의 미실행을 확인한다. 원본 관측은 별도 read-only 연결로 수행한다.
- 재시작: 각 실패에서 같은 disposable DB를 실제 서버로 세 번 재시작한다. 첫 복구 이후 전체 턴·도구·메시지·관련 receipt 행이 반복 재시작 동안 동일하고, 모델 fixture 요청 수와 셸 실행 표식 바이트가 증가하지 않는지 확인한다. `integrity_check`와 `foreign_key_check`도 확인한다.

| 실패 기록 지점 | 관측·검증한 결과 |
|---|---|
| 입력 접수 transaction의 마지막 idempotency receipt | 앞서 쓴 사용자 메시지·턴·receipt가 전부 rollback되며 모델은 호출되지 않는다. |
| stream 진행 시각 | 기존 증거 bytes·step·현재 owner_epoch·입력 receipt를 보존한다. |
| 주기적 증거 snapshot | 새 증거 쓰기 실패가 기존 원본을 덮어쓰지 않는다. |
| 취소 시 마지막 증거 flush | 실패를 recovery latch로 드러내고 이전 원본을 보존한다. |
| 답변 확정의 evidence 삭제·usage·step 갱신 | 같은 transaction의 assistant 메시지·usage·step 증가·증거 삭제를 모두 rollback한다. |
| 모델 도구 계획 행 생성 | 앞선 assistant 메시지·증거 삭제도 rollback하며 도구를 실행하지 않는다. |
| 승인 결정 | revision·결정·기존 receipt를 보존하며 실패한 승인 receipt는 남기지 않는다. |
| 외부 실행 접수(`running`·`started_at`) | 확정 승인 receipt는 유지하지만 실행은 시작하지 않는다. 재시작은 미실행 승인 호출을 cancelled로 정리한다. |
| 실제 셸 실행 뒤 결과 확정 | `printf x >> executions`의 부작용은 한 번만 발생한다. 결과 미기록 시 `running`·시작 receipt를 보존하고 재시작에서 unknown으로 수렴한다. |
| 최종 종료 note | 먼저 쓴 상태·종료 시각·error도 transaction과 함께 rollback한다. 실제 runner가 남긴 마지막 증거를 보존하고 재시작 뒤 종료 note는 하나뿐이다. |
| startup 복구의 턴 종료 기록 | 앞서 수행한 unknown 전이·도구 메시지도 rollback한다. 이후 정상 재시작에서 interrupted·unknown으로 수렴한다. |
| 턴 확인 기록 | 실패 시 acknowledged_at과 원본이 그대로며 정상 재시도·반복 확인은 같은 확인 시각을 돌려준다. |
| 도구 검토 transaction의 마지막 receipt | review·revision 변경도 rollback한다. 정상 재시도 후 같은 키는 receipt를 replay하고 unknown·원본은 그대로다. |

입력 receipt replay는 원래 턴 ID를 반환하며 추가 턴·모델 호출을 만들지 않는다.
이미 commit된 승인 receipt는 실패·복구·반복 재시작 전후 원문 그대로 유지된다.
승인 재전송은 기존 제품에서 명시적 사용자 재개 행동일 수 있으므로, 자동 재시작 비재호출 검증과 혼동하지 않았다.

live owner 회귀는 `queued`·`running`·`awaiting_approval` 각각에서 같은 epoch의 읽기/변경 도구 running receipt와 approved receipt, 증거 및 메시지가 반복 복구 호출로 변하지 않는지 확인한다.
같은 fixture를 죽은 epoch로 바꾸면 읽기 도구는 failed, 변경 도구는 unknown, 미실행 approved 도구는 cancelled가 된다. 모델·도구를 자동 호출하지 않는다.

## 검증 입력·결과

Rust 실행마다 아래 공유 환경을 먼저 적용했고, 컴파일부터 시험 종료까지 동일한 전체 명령 잠금을 사용했다.

```bash
source <원본 저장소>/.envrc.dev
export CARGO_TARGET_DIR=<원본 저장소>/target
flock /home/ubuntu/.cache/grove-rust-check.lock python3 scripts/build.py test --rust recovery_faults recovery turns
```

실제 cargo 산출물 경로는 실행 로그의 `/home/ubuntu/.cache/cargo-build/d5/849042383b1349/debug/deps/`이며, 컴파일 로그는 이 worktree의 crate 경로를 명시한다.
다른 checkout이나 서비스를 수정하지 않았다.

| 검사 | 결과·실행기가 기록한 시간 |
|---|---|
| 최초 live-owner 선택 검사 | 공유 잠금 대기 중 600초 timeout. stdout/stderr가 비어 컴파일·시험은 시작하지 못했다. 성공 근거로 계산하지 않는다. |
| 첫 `--rust recovery_faults recovery turns` | exit 101. recovery 6개 통과, recovery_faults 6개 통과·2개 실패. live-owner receipt 변경 결함과 시험의 취소 HTTP 기대값 오류를 확인했다. turns는 cargo가 앞 target 실패에서 중단해 미실행이었다. Rust 단계 wall 165.4s / CPU 226.27s. |
| 수정 후 동일한 세 target | exit 0. recovery 6개, recovery_faults 8개, turns 38개 모두 통과. Rust 단계 wall 91.26s / CPU 64.32s. |
| 최종 `--rust recovery_faults` | exit 0, 8개 모두 통과. 실행 표식의 예상 밖 읽기 오류를 숨기지 않도록 하고 최종 종료 실패 지점을 note 삽입으로 강화한 뒤 실행했다. Rust 단계 wall 37.55s / CPU 12.29s. |
| `python3 scripts/build.py test --vitest app/components/RecoveryPanel.test.ts --typecheck` | exit 0. typecheck 통과(wall 13.47s / CPU 13.19s), RecoveryPanel 2개 통과(Vitest 단계 wall 10.02s / CPU 2.39s). |
| `git diff --check` | 통과. |

웹 검사는 COMMON이 허용한 공유 `web/node_modules` symlink를 연결해 실행했고 설치하지 않았다.
웹 검증 이후 웹 입력은 변경하지 않았다.
세 target 통과 이후 제품 코드는 변경하지 않았으며, 마지막 변경은 전용 시험의 표식 읽기와 종료 note 주입 지점뿐이다.
그 변경은 최종 recovery_faults 재실행으로 검증했다. 이후 작성한 파일은 이 RESULT뿐이다.

로그:

- 최초 잠금 timeout: `<실행 로그>/shell_06fd1ac8.stdout`, `<실행 로그>/shell_06fd1ac8.stderr`
- 재현 실패: `<실행 로그>/shell_e055be15.stdout`, `<실행 로그>/shell_e055be15.stderr`
- 제품 수정 뒤 세 target 통과: `<실행 로그>/shell_9567b278.stdout`, `<실행 로그>/shell_9567b278.stderr`
- 최종 전용 target 통과: `<실행 로그>/shell_3d670b3f.stdout`, `<실행 로그>/shell_3d670b3f.stderr`
- 웹 통과: `<실행 로그>/shell_bbc260a5.stdout`

## 범위·남은 조건

REC-012의 배정된 기록 경계 full·권한 실패, 원본·확정 receipt 보존, live epoch 보호와 반복 재시작 비재실행 검증은 완료했다.
기존 강제 종료·손상 증거·backup/restore·모델/도구 비재호출 시나리오는 변경 없이 통과한 turns target에서 재사용했다.
`actual_sqlite_full_stops_live_work_and_restart_keeps_the_result_unknown`도 그대로 통과했으며, 그 하나의 성공을 다른 경계의 근거로 확대하지 않았다.

실제 호스트 디스크를 채운 ENOSPC, 주 DB/WAL 파일 자체의 chmod, Windows 권한 동작은 시험하지 않았다.
권한 시험의 보조 DB와 TEMP trigger는 기록 SQL의 실제 SQLite 실패·rollback을 검증하기 위한 disposable fixture이며, 주 DB의 영구 schema나 일반 fault framework가 아니다.
UI 변경 없는 서버 흐름이므로 새 브라우저 시험·E2E·전체 회귀·release는 실행하지 않았다.
세션 조회 도구는 이 runtime에서 `cross-session control is unavailable`을 반환했다. 다른 세션에 메시지를 보내거나 workspace를 조작하지 않았다.

blocker와 실행 가능한 잔여, 추가 공통 연결은 없다. 통합 담당은 이 변경과 위 유효한 검사 근거를 인수하면 된다.
`TODO.md` 갱신·merge/rebase·push·배포·workspace 관리는 수행하지 않았다.
