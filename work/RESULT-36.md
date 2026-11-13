<!-- grove-handoff:v1
{"state":"ready","remaining":[],"blockers":[],"integration_checks":["통합 candidate에서 e2e/mcp-oauth.spec.ts 재현","소유 범위 밖 e2e/mcp-settings.spec.ts:169의 폐기된 approval-mcp locator와 승인 인자 원문 표시 기대는 현재 승인 projection 계약에 맞춘 별도 유지보수 필요"]}
-->

# 36 — HTTP MCP OAuth 연결·명시적 갱신

- 배치/번호: b02 / 36, `RESOURCE-005`.
- worktree: `/home/ubuntu/.local/share/paseodog/paseo/worktrees/0q796rug/b02-36-mcp-oauth`.
- branch: `parallel/b02-mcp-oauth`.
- 고정 기준: `11e51d6efaf0b10a6f0c2c682da7bb1db5738955`. 시작 HEAD 일치·clean과 `a453f18` ancestor를 확인했다.
- 상태: 소유 구현·실제 API/UI 연결·로컬 브라우저 인수 완료. 실행 가능한 소유 잔여와 blocker 없음.
- TODO 체크·다른 checkout 편집·merge/rebase·push·배포·workspace 관리·모델/runtime 설정 변경·위임은 하지 않았다.

## 지원 계약

공식 근거는 MCP `2025-06-18/basic/authorization`과 RFC 7636/8414/8707/9207/9700이다.
구현 전에 공식 본문을 조회했다:

- `https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization`
- `https://www.rfc-editor.org/rfc/rfc9700.html`

지원 범위는 수동으로 사전 등록한 HTTP MCP client다. 일반 OAuth/issuer 자동 호환성을 주장하지 않는다.

- `ServerConfig::Http.oauth`에 `issuer`, `authorization_endpoint`, `token_endpoint`, `client_id`, `redirect_uri`, `scopes`, 선택적 `client_secret_id`를 지정한다.
- public client의 `none`, vault secret 참조를 사용하는 confidential client의 `client_secret_post`를 지원한다.
- S256 PKCE, authorization-code grant, 명시적 refresh-token grant, Bearer token과 정수 `expires_in`을 지원한다.
- issuer의 RFC 8414 well-known metadata와 resource의 RFC 9728 well-known metadata를 조회한다. resource URI는 저장된 MCP endpoint와 정확히 같아야 한다.
- authorization/token endpoint는 지정 issuer와 같은 origin이고 metadata 값과 정확히 일치해야 한다. metadata의 S256/code/client 인증 방식 및 `authorization_response_iss_parameter_supported=true`를 확인한다.
- authorization·token 요청 모두 `resource`를 포함한다. callback의 `iss`도 고정 issuer와 정확히 비교한다.
- HTTPS만 허용하며, HTTP 예외는 literal loopback fixture IP뿐이다. 자격 내장 URL·query·fragment를 금지한다.
- 자동 client 등록, 임의 challenge/metadata URL 추적, OIDC discovery 대체 경로, 다른 origin의 token endpoint, DPoP, client_secret_basic은 지원하지 않는다.
- 고정 redirect는 현재 앱 origin의 `/api/mcp-oauth/callback/{server_id}`다. 기존 MCP CRUD로 먼저 ID를 만든 후 등록된 redirect와 OAuth 설정을 저장할 수 있다.
- OAuth는 HTTP 전용이다. 기존 stdio·secret 헤더·명시적 구 SSE 계약은 유지한다.

## 제공 동작·안전 경계

연결 시작은 Owner·expected_revision·기존 idempotency receipt를 사용한다.
한 번만 응답하는 승인 URL은 receipt 저장본에서 가린다. 응답 유실 후 같은 키 확인은 URL을 재발급하지 않으며 상태 확인·취소·새 연결로 복구한다.
서버별 UI는 승인 URL, issuer, scope, token endpoint, MCP resource, 정확한 redirect를 보여 준 뒤 연결·승인 페이지 열기·취소·상태 확인·명시적 갱신을 제공한다.

state는 256-bit 난수의 hash만 저장한다. PKCE verifier는 기존 vault로 암호화한다.
시작 root Owner와 실제 principal/browser ID, 서버 ID·revision·전체 설정 hash·기한에 결합한다.
완료 접수 때 state/verifier를 소비한다. 잘못된 state/issuer/소유자/서버/revision, 재사용, 취소·만료·재시작 뒤 callback은 교환 전에 거부한다.
기한은 문자열 정렬이 아니라 시각으로 비교한다.

callback 문서는 인증이나 토큰 교환을 하지 않는다.
외부 query를 HTML에 보간하지 않고 주소 표시줄에서 즉시 지운 뒤 원래 창에만 message를 전달한다.
원래 UI는 origin·popup source·state를 검사하고 기존 인증 client로 Owner 완료 API를 호출한다.
문서는 `no-store`, `no-referrer`, hash CSP, `frame-ancestors 'none'`, `nosniff`를 적용한다.
`/api/` 아래 독립 route를 사용해 기존 service worker의 navigation shell 치환을 피한다. `src/auth.rs`나 PWA/SW를 변경하지 않았다.
원래 창/응답을 잃으면 상태 확인 후 pending 요청 취소 또는 새 연결을 명시적으로 선택한다.

교환·갱신은 네트워크 전에 결과 불명 receipt를 commit하고 자격을 비활성화한다.
같은 키의 재요청은 receipt만 반환하며 token endpoint를 다시 호출하지 않는다.
동일 서버 자격의 pending/exchanging은 직렬화한다. 교환 task는 HTTP 응답 대기 폐기와 분리하고 자체 15초 상한·shutdown 경계를 둔다.
실제 응답 유실, timeout, shutdown, 불명확한 응답은 `unknown`이다. unknown 자격의 refresh 재사용은 막고 새 연결만 명시적으로 허용한다.
교환 중 취소도 unknown으로 보존하며 늦은 결과를 활성화하지 않는다. 시작 복구는 pending을 interrupted, exchanging을 unknown으로 만들 뿐 재전송하지 않는다.
명확한 OAuth 거절은 외부 본문을 보관하지 않고 failed로 반환한다.

access/refresh token은 전용 테이블에 기존 `grove_encrypt`로 저장한다.
client secret 참조는 기존 vault 목록·삭제 보호·변경 시 실행 중 제한 및 revision 무효화에 연결했다.
token/code/verifier/외부 오류 본문은 API 결과·이벤트·감사·모델 입력으로 내보내지 않는다.
HTTP MCP의 모든 요청에는 준비된 Bearer 헤더만 전달하고 기존 민감 헤더·redirect 금지·SSE·timeout·크기 제한을 그대로 사용한다.
기존 scrub에 access/refresh/client secret을 포함해 원격 MCP가 되돌려준 비밀도 가린다.

교환 접수와 성공 각각 revision을 증가시키고 catalog를 무효화한다.
성공 자격마다 별도 opaque identity를 계획에 고정하고 실행 직전에 다시 검사한다.
갱신 전 승인은 새 자격으로 실행할 수 없다. 새 연결 확인과 새 승인이 필요하다.
동일 config의 사용 설정 토글은 암호화 자격을 유지하지만 revision과 연결 확인 결과는 갱신한다. endpoint/OAuth 설정 또는 참조 자격 변경은 저장 자격을 폐기한다.
MCP 401/403은 기존 `mcp_auth_required`를 유지하며 자동 token 갱신이나 도구 재전송을 하지 않는다.
OAuth 완료, MCP 연결 확인 성공, 도구 실행 성공은 별도 상태다.

## 변경 파일·연결

| 경로 | 소유 변경 |
|---|---|
| `src/mcp/oauth.rs` | Config 검증, metadata, connect/status/cancel/complete/refresh, vault 자격, identity·준비, callback, 시작 복구 |
| `src/mcp.rs` | HTTP OAuth 설정, client secret 사용·변경 보호, config 변경 시 OAuth 무효화, check 전 자격 준비, 기존 recover 경로 연결 |
| `src/mcp/execute.rs` | 계획/실행 identity 검사, 실행 전 자격 준비 |
| `src/mcp/client.rs` | 준비된 OAuth Bearer 전달과 새 enum 필드에 필요한 기존 단위 fixture 수정만 |
| `src/lib.rs` | OAuth 전용 API 및 독립 callback route |
| `src/store.rs` | 끝에 독립 migration 추가: `mcp_oauth_credentials`, `mcp_oauth_attempts`, 서버별 active unique index |
| `tests/mcp_oauth.rs` | 로컬 issuer/MCP HTTP fixture·통합 시험 8개 |
| `web/app/api/mcpOAuth.ts` | typed 전용 API, 결과 불명 판별, callback message 검증 |
| `web/app/components/mcp-oauth/McpOAuth.tsx` | 서버별 실제 연결/취소/상태/완료/갱신 UI·같은 receipt 재확인 |
| `web/app/components/mcp-oauth/McpOAuth.test.ts` | callback source/origin/state·형식·결과 불명 시험 3개 |
| `web/app/components/McpServers.tsx` | OAuth 타입/import 및 서버별 mount만 |
| `web/e2e/mcp-oauth.spec.ts` | 실제 등록 서버·로컬 issuer·승인된 도구 실행까지 이어지는 전용 browser flow |
| `work/RESULT-36.md` | 이 인계 |

미연결 지점은 없다. 공용 auth/client/store/Settings 상위 mount/runner/hooks/PWA/SW 및 dependency/lockfile은 수정하지 않았다.
TTS·재생·마이크 차단·STT 범위도 건드리지 않았다.

### 공개 입출력

- `mcp::oauth::{status, connect, complete, cancel, refresh, callback, recover_on_start}`, 공개 `Config`와 요청 DTO.
- `/api/v1/mcp/servers/{id}/oauth`: Owner GET. revision, 본인 최근 attempt의 상태, 자격 사용 가능 여부·갱신 가능 여부·기한만 반환한다.
- 같은 경로 아래 POST `/connect`, `/refresh`: `{expected_revision, confirmed:true}`.
- POST `/complete`: `{expected_revision, attempt_id, state, code, error, iss}`. code/error는 둘 중 하나만 지정한다.
- POST `/cancel`: `{expected_revision, attempt_id}`. 교환 접수 후에는 상태 조회의 최신 revision을 사용한다.
- connect 결과: attempt ID·기한·최초 응답의 authorization URL. terminal 교환 결과: `{attempt_id,status}`. token 원문은 반환하지 않는다.
- 교환 중 같은 키의 receipt는 `409 result_unknown`, 확정된 unknown은 `200`과 `status:"unknown"`으로 구분한다. 둘 다 자동 재시도 허가는 아니다.
- 기존 권한/revision/idempotency/busy 오류와 `mcp_oauth_metadata`, `mcp_oauth_state`, `mcp_oauth_issuer`, `mcp_oauth_reconnect`, `mcp_auth_required`, `mcp_auth_expired`, `mcp_auth_changed`를 사용한다.
- `McpOAuth` props: `{serverId, revision, resource, config, disabled, onChanged}`. 외부 상태 갱신은 기존 MCP query reload를 재사용한다.

## 실제 검증

공용 환경 복구 후 사용한 진입점은 아래와 같다. `b.DEV` 보정은 기준 버전 `scripts/build.py`가 환경의 CARGO_HOME/RUSTUP_HOME을 worktree `.dev`로 덮어쓰는 문제를 피하기 위한 실행 시 보정이다. 스크립트 파일은 수정하지 않았다.

```bash
source /data/project/paseodog_opus/.envrc.dev
CARGO_NET_OFFLINE=true RUSTUP_AUTO_INSTALL=0 \
CARGO_TARGET_DIR=/data/project/paseodog_opus/target \
flock /home/ubuntu/.cache/grove-rust-check.lock python3 - <<'PY'
import scripts.build as b
b.DEV = "/data/project/paseodog_opus/.dev"
b.main(["test", "--rust", "mcp_oauth"])
b.main(["test", "--lib", "--filter", "mcp"])
b.main(["test", "--e2e", "e2e/mcp-oauth.spec.ts",
        "e2e/mcp-settings.spec.ts:7", "e2e/mcp-settings.spec.ts:49",
        "e2e/mcp-settings.spec.ts:93", "e2e/mcp-settings.spec.ts:224"])
b.main(["test", "--rust", "mcp_connect", "--filter",
        "stdio_handles_success_crash_timeout_and_size_limit_and_always_reaps_its_owned_tree"])
PY
```

위 코드는 실제 실행한 선택 명령들을 같은 형태로 묶은 재현 진입점이며, 실행 결과는 아래 개별 로그에 대응한다.

| 실행 입력 | 결과 | runner wall / CPU |
|---|---|---|
| `test --rust mcp_oauth` | 8/8 통과. 연결, PKCE/resource, 권한, state 변조/재사용/다른 서버, revision, 취소, 만료, 재시작, 실제 응답 유실, timeout, refresh 직렬화, 이전 승인 거부, vault/redaction, 사용 설정 후 자격 보존 | 78.83s / 38.51s |
| `test --lib --filter mcp` | 5/5 통과. 소수초/offset 기한 판정과 기존 redaction/progress 경계 | 44.13s / 41.59s |
| `test --rust mcp_oauth mcp mcp_connect` | 관련 묶음에서 CRUD 4/4, transport 22/23 통과. stdio 성공 fixture가 기존 1초 상한을 초과해 실패. 후속 OAuth target·E2E는 이 실행에서 미실행 | 72.01s / 58.63s |
| 위 stdio의 단독 선택 1회 | timeout이나 fixture를 바꾸지 않고 통과. 앞선 실패를 취소하지 않음 | 16.79s / 4.26s |
| `test --vitest app/components/mcp-oauth/McpOAuth.test.ts --typecheck` | Vitest 3/3과 typecheck 통과 | Vitest 1.37s / 2.33s, typecheck 22.27s / 12.47s |
| 후속 `test --typecheck` | resource prop을 포함한 최종 제품 TS에서 통과 | 7.54s / 11.83s |
| 위 선택 E2E | **5/5 통과**. 전용 OAuth 1개와 기존 MCP 4개 | 8.57s / 7.26s |
| 최종 E2E 앞 debug/web build | 둘 다 통과 | debug 4.77s / 0.22s, web 3.33s / 5.12s |

검증 로그(이 세션의 보존된 실제 출력):

- OAuth 8개 및 수정 전 browser 실패: `/home/ubuntu/.local/share/paseodog/mixdog/data/shell-output/shell_e6207e54.{stdout,stderr}`.
- Rust 단위 5개: `/home/ubuntu/.local/share/paseodog/mixdog/data/shell-output/shell_f88939ea.{stdout,stderr}`.
- 최종 browser 5개·stdio 단독 통과: `/home/ubuntu/.local/share/paseodog/mixdog/data/shell-output/shell_0d21f5ee.{stdout,stderr}`.
- 최종 관련 transport 묶음의 1초 실패: `/home/ubuntu/.local/share/paseodog/mixdog/data/shell-output/shell_5326d0ed.{stdout,stderr}`.
- Vitest·최초 typecheck: `/home/ubuntu/.local/share/paseodog/mixdog/data/shell-output/shell_e302325a.{stdout,stderr}`.
- 후속 typecheck 및 당시 MCP 27개 전체 통과: `/home/ubuntu/.local/share/paseodog/mixdog/data/shell-output/shell_929a86d0.{stdout,stderr}`.

마지막 Rust 제품 변경은 기한 비교 보정이다. OAuth 8개·단위 5개·마지막 E2E는 그 코드를 사용했다.
이후 코드 변경은 전용 E2E의 폐기된 locator를 현재 의미 기반 승인 region으로 바꾼 것뿐이며 마지막 E2E가 이를 포함한다.
그 뒤에는 RESULT만 추가했다. 제품 TS는 후속 typecheck 이후 바뀌지 않았다.
서로 다른 실행의 결과를 한 번의 전체 suite 통과로 합치지 않았다.

### 실패·미실행·환경 이력

- 첫 Rust 컴파일의 String 소유권/closure lifetime 오류 3건을 수정했다.
- 첫 OAuth 통합 시험의 잘못된 기대를 수정했다. 기존 승인 API는 HTTP 200으로 결정을 접수한 뒤 실행 시 재검증한다. 실제로 이전 자격 승인은 최종 `mcp_auth_changed`로 실패하고 원격 호출 수가 늘지 않는 것을 확인했다.
- browser 첫 실패는 로컬 issuer HTML의 charset 누락이었다. fixture에 UTF-8을 명시했다.
- 다음 실패는 root callback 문서가 기존 SW shell로 대체되는 실제 연결 결함이었다. 소유 route를 `/api/mcp-oauth/callback/{id}`로 옮겨 해결했다. SW/auth 수정이나 우회 테스트는 하지 않았다.
- 다음 실패는 기준의 승인 UI에서 사라진 `approval-mcp` test ID였다. 소유 새 spec만 현재 승인 region으로 고쳤다. 최종 flow는 승인 버튼 클릭과 실제 원격 호출 1회·succeeded까지 통과했다.
- `e2e/mcp-settings.spec.ts:169`도 폐기된 ID와 승인 인자 원문 노출을 기대한다. 현재 승인 projection은 원문 인자를 가리는 계약이다. 이 소유 밖 시험은 수정하지 않았고 최종 선택에서는 제외했다. 해당 spec 전체 통과를 주장하지 않는다.
- 기존 stdio 시험의 동시 target 실행 중 1초 timeout 실패는 원인 확정/수정하지 않았다. 이전 묶음과 최종 단독 선택에서 통과했지만 간헐 timing 위험으로 인계한다. 시험 상한·transport 코드를 바꾸지 않았다.
- callback route 변경 전 잠금 대기 중이던 검사는 입력 무효화 때문에 취소했다(exit 137, 실행 출력 없음). 통과로 집계하지 않았다.
- 초기 문서상의 표준 Rust 명령은 기준 build.py의 DEV 덮어쓰기 때문에 worktree에 툴체인·crate를 자동 다운로드했다. 의도하지 않은 환경 부작용이다. 이 호출이 만든 정확한 worktree `.dev`와 `target`을 확인 후 제거했다. 이후에는 기존 메인 DEV를 실행 시 지정하고 offline/auto-install 금지로 검증했다. dependency/lockfile 변경은 없다.
- 웹은 COMMON이 허용한 `/data/project/paseodog_opus/web/node_modules` symlink를 썼다. npm install/ci는 하지 않았다.
- 공용 Rust/E2E 잠금을 매번 지켰다. 대기 시간이 길었지만 다른 검사·서버를 종료하거나 실행 설정을 바꾸지 않았다. 표의 시간은 runner 단계 값이며 잠금 대기나 절감량을 추정해 넣지 않았다.
- 빌드의 500kB 초과 chunk·React Router v8 future flag 경고는 남았다. 이 범위 밖 최적화는 하지 않았다.
- 전체 회귀/release/패키징, 실제 외부 issuer·계정·실토큰·모바일 실기기 호환성은 미선택/미검증이다.

## RESOURCE-005 충족 근거·통합 후 주의

지원하는 사전 등록 HTTP 계약의 명시적 연결·취소·만료·완료·갱신과 자격 준비/identity를 실제 MCP 연결 검사·승인 실행까지 연결했다.
전용 browser flow는 UI 시작, 취소 뒤 늦은 callback 무시, token 교환 완료 응답의 실제 브라우저 transport abort, 같은 receipt 복구, 명시적 갱신, 새 연결 검사, 이번만 승인, 원격 호출 정확히 1회와 succeeded, 자격 비노출을 검증한다.
issuer token 응답 자체의 실제 끊김·unknown 비재전송·재시작·취소 경합은 별도 Rust fixture로 확인했다.
로컬 fixture 지원 범위 안의 미구현 요구나 미연결은 없다. 실외부 호환성은 완료 근거에 포함하지 않는다.

통합 담당은 독립 migration을 끝에 보존하고 callback route가 `/api/` SW 제외 경계에 남는지 확인하면 된다.
기존 승인 projection을 되돌리지 말고 소유 밖 legacy E2E 기대는 별도 범위에서 갱신해야 한다.
TODO 체크와 통합/워크스페이스 정리는 메인 소유로 남긴다.
