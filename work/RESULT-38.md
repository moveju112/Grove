<!-- grove-handoff:v1
{"state":"ready","remaining":[],"blockers":[],"integration_checks":["메인 통합 후 source /data/project/paseodog_opus/.envrc.dev && flock /home/ubuntu/.cache/grove-rust-check.lock python3 scripts/build.py test --e2e e2e/local-models.spec.ts e2e/model-catalog.spec.ts e2e/profile-check.spec.ts e2e/cli-profile.spec.ts:5 — Settings/Profiles의 ServerActionButton 및 ProfileCatalog의 useServerBlockReason 결합을 보존한 통합 트리에서 재확인"]}
-->

# 38 — MODEL-025 로컬 HTTP 모델 연결

구현·소유 브라우저 인수 완료, blocker 없음. TODO는 수정하지 않았다.

- 배치: b02 / 38.
- Worktree: `/home/ubuntu/.local/share/paseodog/paseo/worktrees/0q796rug/b02-38-local-models`.
- Branch: `parallel/b02-local-models`.
- 고정 기준: `eb841bb51dfde92a714f48189d02b0f568ad23c0`.
- 포함된 제품 입력: `339f5167b1883d4db17134bd4277ffeee983f47b`. 두 SHA 모두 시작 시 merge-base로 포함을 확인했다.
- 시작 상태 clean. 세션 조회 도구는 `cross-session control is unavailable in this runtime`으로 다른 세션 상태를 제공하지 않았다. 이 checkout의 배정 범위만 직접 편집했다.

## 제공 동작·계약

`Settings::Profiles`에 선택적 로컬 연결 폼을 mount했다. endpoint는 처음부터 비어 있으며, 사용자가 이름·HTTP(S) endpoint·수동 모델 ID를 명시해야 저장된다. localhost는 브라우저/휴대폰이 아닌 Grove 서버의 주소임을 안내한다. 설치·시작·다운로드·탐색·자동 모델 선택은 없다.

키 없는 endpoint는 `secret_id:null`을 사용한다. 인증이 필요하면 기존 secret 참조를 선택하며 표시에는 label·masked만 사용한다. URL의 계정·비밀번호·query·fragment는 신규 OpenAI-compatible 입력에서 거절해 키를 endpoint에 넣지 않게 한다. 새 route·DB·dependency·transport·API 응답 필드는 없다.

기존 `/model-profiles` 생성·수정, `/check`, `/models` 및 OpenAI HTTP transport를 재사용한다. 상태 확인은 실제 모델 목록 HTTP 조회이며 생성 요청을 보내지 않는다. 목록에 모델이 없는 성공과 연결 실패를 구분한다. 목록 오류·빈 목록에서도 수동 모델을 유지하고, 기존 모델 변경 입력도 사용할 수 있다. 목록에서 모델을 선택해야만 기존 revision 기반 수정 API가 호출된다.

로컬 생성은 동기 중복 제출 잠금과 동일 본문·Idempotency-Key를 유지한다. 응답 유실 시 입력을 지우거나 자동 재전송하지 않고 같은 요청 확인만 제공한다. 확정 거절은 입력 수정을 허용한다. 미확정 요청/입력 보관은 해당 폼 인스턴스의 메모리 범위다. 브라우저를 닫아도 보관되는 새 자격증명/설정 저장소는 추가하지 않았다.

ProfileCatalog는 진행 중 프로필 ID/revision이 바뀌면 이전 응답을 폐기한다. 이전 목록은 보존하되 stale 또는 조회 실패 상태에서는 선택을 막고 재조회를 안내한다. 첫 조회 중 변경도 명시적으로 알린다. 기존 owner·capability·revision·secret 변경 stale·활성 프로필 보호를 재사용했다. `/check`의 인증 범위도 기존 Principal 계약을 변경하지 않았다.

## 소유 파일·연결 지점

| 경로 | 변경 |
| --- | --- |
| `web/app/components/local-models/LocalModelConnection.tsx` | 선택적 연결 폼·안내·저장/실패 상태. 기존 `useServerBlockReason`으로 생성 버튼 차단 |
| `web/app/components/local-models/connection.ts` | `LocalDraft`, `LocalProfileInput`, `CreateLocalProfile`, `localProfileInput`, `LocalProfileCreation` |
| `web/app/components/local-models/connection.test.ts` | 입력·안내·중복/미확정 생성의 단위 회귀 |
| `web/app/components/Settings.tsx` | import와 `Profiles`의 좁은 mount/create callback만 |
| `web/app/components/ProfileCatalog.tsx` | ID/revision 경합·오류 후 선택 차단·수동 fallback 안내 |
| `src/models.rs` | OpenAI-compatible 생성/수정의 endpoint 입력 검증. 생성 receipt replay는 기존 순서 보존 |
| `tests/local_models.rs` | 격리 HTTP fixture의 생성·권한·secret·revision·목록·상태·대화 회귀 |
| `web/e2e/local-models.spec.ts` | 독립 loopback fixture를 통한 소유 브라우저 인수 2개 |
| `work/RESULT-38.md` | 이 인계 |

`LocalModelConnection` props는 `{secrets:SecretInfo[], onCreate:CreateLocalProfile}`다. callback은 정규화된 `{name,protocol:"openai",base_url,model,secret_id}`와 고정 key를 받아 Promise를 반환한다. 오류는 기존 ApiError로 처리한다. 입력 오류 메시지에는 endpoint/비밀 원문을 되돌리지 않는다. Settings callback에서 기존 API와 `requires:["model_management_v1"]`를 연결했다.

## 통합 seam

루트의 후속 PWA 통합은 이 기준에 아직 없는 `ServerActionButton`을 Profiles action에, `useServerBlockReason`을 ProfileCatalog에 추가한다. 이번 변경은 그 action들을 바꾸거나 보호 구현을 복제하지 않았다. 통합 시 **루트의 버튼 wrapper·실행 보호를 반드시 유지**하고, ProfileCatalog의 busy/stale/error 차단을 루트의 serverBlocked 조건과 함께 적용해야 한다. 신규 로컬 폼은 이미 기존 lifecycle hook을 직접 재사용한다.

37의 Settings 직접 링크 effect/anchor, 36의 MCP OAuth, 39의 DefinitionEditor 경계는 수정하지 않았다. fallback 순서·가격·전송 확인·공통 store/client/provider도 수정하지 않았다. 공통 mount 미연결은 없다.

## 검증 명령·근거

모든 Rust/E2E 명령은 아래와 같이 루트 환경을 source하고 **명령 전체**에 공통 잠금을 적용했다. 여러 Rust target은 한 `--rust` 옵션을 사용했다. `.dev` symlink는 변경하지 않았다. 없는 `web/node_modules`만 COMMON이 허용한 공유 symlink로 연결했으며 설치·cache/환경 설정 변경·다른 검사 취소는 하지 않았다. 사용자 지시에 따라 runtime 설정도 변경하지 않았다.

최종 Rust 입력의 유효 근거:

```bash
source /data/project/paseodog_opus/.envrc.dev && flock /home/ubuntu/.cache/grove-rust-check.lock python3 scripts/build.py test --rust local_models model_catalog profile_check profile_check_state --vitest app/components/local-models/connection.test.ts --typecheck --e2e e2e/local-models.spec.ts e2e/model-catalog.spec.ts e2e/profile-check.spec.ts
```

이 호출 전체는 최초 브라우저 기대 오류로 exit 1이었다. 선행 Rust는 **18/18 통과**: local_models 4, model_catalog 10, profile_check 1, profile_check_state 3. 이후 Rust 소스·시험은 변경하지 않았다. 근거: `/home/ubuntu/.local/share/paseodog/mixdog/data/shell-output/shell_d22e049e.stdout`, 같은 stem의 `.stderr`.

최종 웹·브라우저 전체 성공 명령:

```bash
source /data/project/paseodog_opus/.envrc.dev && flock /home/ubuntu/.cache/grove-rust-check.lock python3 scripts/build.py test --vitest app/components/local-models/connection.test.ts --typecheck --e2e e2e/local-models.spec.ts e2e/model-catalog.spec.ts e2e/profile-check.spec.ts e2e/cli-profile.spec.ts:5
```

exit 0. Vitest **5/5**, desktop E2E **6/6**, typecheck·debug 서버 빌드·웹 빌드 통과. CLI는 설정 UI 시험만 선택했고 실제 CLI/계정 시험은 선택하지 않았다. 근거: `/home/ubuntu/.local/share/paseodog/mixdog/data/shell-output/shell_b87efee6.stdout`, 같은 stem의 `.stderr`.

| 유효 단계 | wall seconds | CPU seconds |
| --- | ---: | ---: |
| Rust 18개 | 80.36 | 32.59 |
| 최종 typecheck | 7.42 | 11.69 |
| 최종 Vitest | 1.13 | 2.08 |
| 최종 debug 서버 빌드 | 5.60 | 0.35 |
| 최종 웹 빌드 | 3.28 | 5.01 |
| 최종 E2E 6개 | 9.64 | 8.43 |

위 시간은 실행기의 단계별 출력값이며 공유 잠금 대기를 포함한 전체 작업 시간이나 절감량으로 해석하지 않는다. 최종 검사 뒤에는 RESULT 작성과 Git 확인·커밋만 수행한다.

### 중간 실패·복구 이력

- `python3 scripts/build.py test --vitest app/components/local-models/connection.test.ts --typecheck`를 루트 환경 source 후 실행했다. 초기 5개/타입 통과 뒤 E2E 추가로 `string | undefined` 타입 오류가 발생했다. 소유 시험의 배열/헤더 타입을 바로잡고 같은 명령이 통과했다. 실패 호출에서는 Vitest 미실행. 로그 stem: `/home/ubuntu/.local/share/paseodog/mixdog/data/shell-output/shell_e605a148`, 수정 후 `/home/ubuntu/.local/share/paseodog/mixdog/data/shell-output/shell_7fcf28cb`.
- 최초 선택 Rust 전용 명령 `source /data/project/paseodog_opus/.envrc.dev && flock /home/ubuntu/.cache/grove-rust-check.lock python3 scripts/build.py test --rust local_models model_catalog profile_check profile_check_state`도 18개 통과했다. 이후 endpoint 검증 순서·capability 회귀를 보완했으므로 위 최종 Rust 근거를 사용한다. 로그 stem: `/home/ubuntu/.local/share/paseodog/mixdog/data/shell-output/shell_05d9ffbd`.
- 최종 Rust 근거 호출의 E2E는 `conn`이 오프라인 즉시 바뀐다는 잘못된 기대 때문에 1개 실패·4개 미실행이었다. 실제 기존 EventStream은 열린 SSE가 끊겨야 상태가 바뀐다. 실제 offline 배너·전송 차단과 reload 후 새 연결/초안 복원을 검증하도록 고쳤다. 제품의 SSE 동작은 바꾸지 않았다.
- 다음 명령 `source /data/project/paseodog_opus/.envrc.dev && flock /home/ubuntu/.cache/grove-rust-check.lock python3 scripts/build.py test --typecheck --e2e e2e/local-models.spec.ts e2e/model-catalog.spec.ts e2e/profile-check.spec.ts`는 1개 통과·1개 실패·3개 미실행이었다. 실패는 모델과 `auth_failed`가 모두 code 요소인 소유 시험 locator의 모호함이었다. 직접 모델 표시로 범위를 좁혔다. 로그 stem: `/home/ubuntu/.local/share/paseodog/mixdog/data/shell-output/shell_8b3b7030`.
- 다음 명령 `source /data/project/paseodog_opus/.envrc.dev && flock /home/ubuntu/.cache/grove-rust-check.lock python3 scripts/build.py test --vitest app/components/local-models/connection.test.ts --typecheck --e2e e2e/local-models.spec.ts e2e/model-catalog.spec.ts e2e/profile-check.spec.ts`는 소유 E2E 2개 통과 후 기존 model-catalog의 이름 locator 충돌로 1개 실패·2개 미실행이었다. 새 폼을 `로컬 연결 이름`·`로컬 인증 비밀`로 구분했다. 기존 시험은 수정하지 않았으며 CLI UI도 선택 회귀에 포함해 최종 6개 통과했다. 로그 stem: `/home/ubuntu/.local/share/paseodog/mixdog/data/shell-output/shell_c389f908`.
- Vite 500 kB chunk 경고와 React Router v8 future flag 경고는 남는다. 이를 이유로 passing code·빌드 설정을 바꾸지 않았다. 관련 없는 전체 회귀·release·모바일/실기기·실모델 품질은 미선택이며 통과로 주장하지 않는다.

## MODEL-025 인수 대응·남은 조건

| 요구 | 충족 근거 |
| --- | --- |
| 명시 endpoint 저장·키 없음·생성 중복 방지 | 소유 첫 E2E의 실제 저장 응답 유실/같은 key 재확인, Rust receipt·optional secret 회귀 |
| 실제 상태·모델 조회·명시 선택·대화 | loopback `/models`와 `/chat/completions`, 생성은 선택된 `local-chosen`으로 정확히 1회 |
| 오류·빈 목록·수동 fallback·재조회 | 소유 둘째 E2E의 실제 잘못된 목록·401·empty·수동 변경·재조회 |
| owner·capability·revision·활성 보호 | 소유 Rust의 미인증/비소유 create/update/delete/catalog 거절, stale update, capability/check 무효화와 기존 선택 회귀 |
| secret 없음/사용·가림 | 소유 Rust의 Authorization 없음/참조 키 사용과 오류 가림, 둘째 E2E의 인증 HTTP 및 secret 원문 비표시 |
| 목록/확인 중 프로필 변경·연결 거부·복구 | 소유 Rust 경합·connect_failed·복구, 둘째 E2E 지연 목록 폐기, 기존 profile_check_state 3개 |
| 재접속·선택/초안·대화 중복 방지 | 첫 E2E의 실제 offline·reload 후 선택/초안 복원·turn 응답 유실 재확인 |

소유 범위에서 실행 가능한 잔여는 없다. 실제 로컬 추론 엔진 설치/품질·개인 endpoint·유료/외부 계정은 요청 범위 밖이라 호출하지 않았다. 다음 단계는 메인의 통합과 위 PWA seam 보존 후 선택 E2E 재확인이다. push·merge/rebase·배포·workspace 관리는 수행하지 않는다.
