<!-- grove-handoff:v1
{"state":"ready","remaining":[],"blockers":[],"integration_checks":["source /data/project/paseodog_opus/.envrc.dev && flock /home/ubuntu/.cache/grove-rust-check.lock python3 scripts/build.py test --e2e e2e/rewind.spec.ts"]}
-->

# 45 — CMP-012 압축 저장 실패·중단·재시작 보존

- 상태: 소유 범위 구현·실제 API 연결·선택 검증 완료, blocker 없음. 기존 브라우저 회귀는 중앙 통합 인수로 남긴다.
- Worktree: `/home/ubuntu/.local/share/paseodog/paseo/worktrees/0q796rug/b02-45-compaction-faults`
- Branch: `parallel/b02-compaction-faults`
- 고정 기준 및 시작 HEAD: `7d5a6e57776f5770162b577dc4e372a2d67ae3e3`
- 정본: `/data/project/paseodog_opus/work/ENTRY.md`, `/data/project/paseodog_opus/work/COMMON.md`, `/data/project/paseodog_opus/work/45.md`
- 변경: `tests/compaction_faults.rs`, `work/RESULT-45.md`만 작성했다. 저장 결함이 재현되지 않아 `src/context.rs::compact`와 기존 회귀는 변경하지 않았다.
- 최종 시험 소스 Git blob: `d88cdd65e4cb51d89654398fee680a8935855b45`. 최종 선택 시험 이후에는 이 인계 파일만 작성했다.

## 제공 동작과 실제 연결

신규 Cargo integration target `compaction_faults`는 기존 `tests/common::TestServer`와 로컬 HTTP 모델 `Fixture::gated_text`를 재사용한다. 별도 실행기·fault framework·제품 hook·public export는 없다. 각 시험은 독립 `TempDir`의 실제 서버·DB·프로젝트 파일만 사용한다.

실제 HTTP 경로는 다음과 같다.

- `POST /api/v1/sessions/{id}/turns`: 도구 사용을 포함한 확정 대화를 만든다.
- `POST /api/v1/sessions/{id}/compact`: 이전 유효 요약을 먼저 저장하고, 다음 후보의 응답을 보류한 상태에서 실패 또는 경합을 주입한다.
- `GET /api/v1/sessions/{id}/messages?limit=200`: 원문과 이전 요약 note를 조회한다.
- `GET /api/v1/sessions/{id}/model-input?limit=200`: 기존 projection과 살아 있는 tool call/result 짝을 확인한다.
- `POST /api/v1/sessions/{id}/rewind`: 실제 timeline 변경 API로 오래된 후보를 거부시킨다.

공통 연결은 이미 `src/lib.rs`의 compact/model-input route와 `src/context.rs::post_compact` → `compact` → `history` 경로에 존재한다. 추가 연결이나 통합 담당의 구현 보완은 필요 없다. 인증된 fixture owner 요청만 사용하며, 기존 `compaction_details`의 미인증 compact 401 회귀도 통과했다. 권한·오류 형식·CAS·요약 prompt·schema·dependency는 변경하지 않았다.

## CMP-012 충족 근거

| 시험 | 실제 주입·응답 | 보존·거부 근거 |
| --- | --- | --- |
| `sqlite_full_rolls_back_candidate_and_preserves_prior_projection_after_restart` | 요약 요청 도착 뒤 서버의 소유 SQLite 연결에 현재 `page_count`를 `max_page_count`로 고정한다. 실제 후보 저장은 HTTP 507 `storage_full`로 실패한다. | 별도 읽기 전용 연결로 실패 직후 transaction rollback을 확인한다. 재시작 뒤 원문·이전 projection·seq·이벤트·CLI native context와 두 조회 API 결과가 동일하다. |
| `actual_journal_permission_refusal_preserves_source_and_projection_after_restart` | 소유 DB를 checkpoint 후 DELETE journal로 전환하고 소유 data 디렉터리만 `0500`으로 바꾼다. `create_new`가 실제 `PermissionDenied`를 반환해야 진행한다. 후보의 journal 생성도 HTTP 503 `storage_permission`으로 거부된다. | 권한은 guard로 복원한다. 실패 직후와 재시작 뒤 원문·이전 projection·CLI context가 동일하다. chmod 성공만으로 권한 실패를 가정하거나 시험을 skip하지 않는다. |
| `restart_cancels_held_summary_without_recalling_or_applying_its_late_response` | 모델 응답을 보류한 채 실제 서버를 종료·재시작한다. 이전 compact 요청은 HTTP 409 `cancelled`로 끝난다. 이후 보류 응답을 해제한다. | 이전 후보를 적용하거나 provider를 자동 재호출하지 않는다. 조회·재시작 전후 동일성과 다음 실제 모델 요청의 기존 projection·tool 짝을 확인한다. |
| `changed_source_rejects_candidate_and_keeps_prior_projection_across_restart` | 응답 보류 중 소유 fixture의 대상 원문 하나를 명시적으로 변경한다. HTTP 409 `source_changed`. | 변경된 원문을 기준으로 후보 거부 직전·직후·재시작 뒤 DB/API 결과가 동일하다. 이전 유효 요약과 도구 짝도 유지한다. |
| `changed_timeline_rejects_candidate_and_keeps_prior_projection_across_restart` | 응답 보류 중 최신 사용자 메시지부터 실제 rewind API를 적용한다. HTTP 409 `timeline_changed`. | 승인된 rewind 결과와 이전 요약을 거부 직전·직후·재시작 뒤 동일하게 유지한다. 되감긴 원문도 DB에서는 삭제되지 않는다. |
| `competing_candidates_apply_once_and_cannot_replace_the_winner_after_restart` | 같은 원문 구간의 후보 둘을 보류하고 두 번째 후보를 먼저 확정한다. 승자는 HTTP 201, 늦은 후보는 HTTP 200 `compacted=false`. | 늦은 후보는 승자의 projection·note·이벤트를 변경하지 못한다. 재시작 뒤에도 같은 결과이고 원문은 남는다. |

보존 비교는 메시지 ID·seq·role·원문 `content` 문자열·별도 `model_input` 문자열·turn 연결·rewound 상태, 세션 마지막 seq·timeline revision·갱신 시각, 세션 이벤트 kind/payload, CLI native context를 포함한다. 저장 실패가 성공 note/event로 위장되거나 seq만 증가하는 것도 비교에서 실패한다. 재시작 후 `PRAGMA integrity_check=ok` 및 foreign key 위반 0을 확인한다.

공통 fixture는 첫 tool 교환을 이전 요약으로 치환하고 두 번째 tool 교환은 원문으로 남겨, 이미 압축된 짝과 아직 살아 있는 짝을 구분한다. FULL·권한 거부·응답 보류 재시작·source 변경 시험에서는 다음 실제 provider 요청이 이전 요약과 살아 있는 call/result를 포함하고, 압축된 옛 원문과 거부 후보를 포함하지 않음을 확인한다. 명시적인 새 턴에는 요청이 정확히 하나만 추가되고 요약 재호출은 없다.

## 실행한 검증과 재사용 조건

모든 Rust 명령은 공통 환경을 source하고 **명령 전체**를 공용 Rust/E2E lock 안에서 실행했다. 여러 target은 하나의 `--rust` 옵션 뒤에 지정했다.

```bash
source /data/project/paseodog_opus/.envrc.dev && rustfmt --edition 2024 --config skip_children=true tests/compaction_faults.rs && flock /home/ubuntu/.cache/grove-rust-check.lock python3 scripts/build.py test --rust compaction_faults context model_input_pages rewind compaction_details
```

- exit 0. `compaction_faults` 6, `context` 12, `model_input_pages` 3, `rewind` 5, `compaction_details` 4: 총 30개 통과, 실패·무시·필터 제외 0.
- 실행기 측정: 173.86s wall, 247.69s CPU, 2179.3MB peak. 이 값은 실행기 내부 검사 단계의 값이며 바깥 `flock` 대기 시간을 포함한다고 주장하지 않는다.
- stdout: `/home/ubuntu/.local/share/paseodog/mixdog/data/shell-output/shell_b48a893e.stdout`
- stderr: `/home/ubuntu/.local/share/paseodog/mixdog/data/shell-output/shell_b48a893e.stderr`
- 처음 컴파일에서 신규 시험의 미사용 `Method` import 경고가 있었다. import만 제거했고 제품·공용 fixture·기존 target 입력은 그대로여서 기존 네 target의 24개 통과 근거는 재사용한다.

최종 신규 target은 import 제거 뒤 다시 실행했다.

```bash
source /data/project/paseodog_opus/.envrc.dev && flock /home/ubuntu/.cache/grove-rust-check.lock python3 scripts/build.py test --rust compaction_faults
```

- exit 0. 최종 blob 기준 6개 통과, 실패·무시·필터 제외 0, 컴파일 경고 없음.
- 실행기 측정: 30.9s wall, 13.35s CPU, 1497.9MB peak.
- stdout: `/home/ubuntu/.local/share/paseodog/mixdog/data/shell-output/shell_0e2b7bf2.stdout`
- stderr: `/home/ubuntu/.local/share/paseodog/mixdog/data/shell-output/shell_0e2b7bf2.stderr`

웹 compatibility 확인은 기존 공유 `node_modules`를 ignore 대상 symlink로 연결한 뒤 실행했다. 설치·복사는 하지 않았다.

```bash
ln -s /data/project/paseodog_opus/web/node_modules web/node_modules
source /data/project/paseodog_opus/.envrc.dev && python3 scripts/build.py test --typecheck
```

- exit 0. 실행기 측정: 28.17s wall, 13.01s CPU, 667.9MB peak.
- stdout: `/home/ubuntu/.local/share/paseodog/mixdog/data/shell-output/shell_5bab1ecf.stdout`
- 웹 제품 입력은 기준 SHA에서 변경하지 않아 이후 Rust 시험 import 정리에 영향받지 않는다.
- Vitest는 변경된 웹 동작이 없어 미선택했다. E2E·전체 회귀·release·실모델 호출은 실행하지 않았다. 실패·취소·timeout으로 끝난 검증 명령은 없다. 시험에서 예상한 storage/cancellation 오류와 검증 명령 실패를 구분한다.

기존 `context`의 원문 변경·과대 요약·도구 짝·별도 model_input 재시작, `rewind`의 timeline 경합·압축 범위 거부, `model_input_pages`의 페이지 경계·도구 짝·상속 projection, `compaction_details`의 실패/취소 성공 기록 금지 회귀를 변경 없이 재사용했다.

## 범위 한계와 다음 통합 단계

- FULL은 실제 SQLite 페이지 한도 초과이며 호스트 디스크를 채우지 않는다. 권한 거부는 Unix 실제 파일 생성 거부로 검증했고 비-Unix 경로는 미검증이다.
- 중단은 응답 보류 중 서버 shutdown cancellation과 동일 DB 재시작이다. SIGKILL·전원 차단·하드웨어 durability 검증을 했다고 주장하지 않는다.
- runner/44 복구 코드는 읽기 전용으로 유지했다. compaction 실패의 recovery latch는 관찰만 했으며 활성 turn 복구·증거 복구를 이 작업의 완료로 주장하지 않는다.
- TODO·다른 checkout·세션 메시지·workspace 관리·merge·push·배포·schema·dependency·prompt 변경은 없다. 실패 주입은 소유 disposable fixture만 대상으로 했고 directory 권한도 복원했다.
- 통합 담당은 structured handoff에 적은 공용 잠금 명령으로 기존 `e2e/rewind.spec.ts`를 실행하면 된다. 특히 “압축된 구간은 되감기를 막고 복구 가능한 범위와 파일 변경 분리를 설명한다” 시나리오의 기존 기대를 유지한다.
- 소유 범위의 실행 가능한 잔여와 외부 blocker는 없다. 본 문서를 포함하는 commit SHA는 순환 갱신하지 않고 최종 채팅으로 전달한다.
