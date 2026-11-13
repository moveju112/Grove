# b01 / 08 — 안전한 웹 본문 조회 인계

## 위치와 상태

- worktree: `/home/ubuntu/.local/share/paseodog/paseo/worktrees/0q796rug/b01-08-web-fetch`
- branch: `parallel/b01-web-fetch`
- 공통 기준: `c186b31ab62734c9f91803cf7848b639ad9871fb`
- 실제 Git top-level·branch가 README의 08 행과 일치했고, 시작 시 clean 및 merge-base 일치를 확인했다.
- 상태: 소유 범위의 독립 구현 종료, 제품 연결·Rust 검증 대기. `INTEGRATION-002`는 부분 구현이며 전체 완료가 아니다.
- blocker: 현재 의존성으로 신뢰할 만한 HTML 본문 추출기를 제공하지 못한다. HTML 원문을 추출 본문으로 가장하지 않고 `extraction: "unsupported"`로 표시한다.
- 세션 조회는 런타임에서 `session: cross-session control is unavailable in this runtime`으로 실패했다. 다른 세션 제어·worktree 이동은 하지 않았다.

## 소유 변경

| 경로 | 내용 |
| --- | --- |
| `src/tools/web_fetch/mod.rs` | spec·plan·execute, 승인 대상 일치, 전체 deadline·취소, redirect·결과 형식 |
| `src/tools/web_fetch/network.rs` | URL·IP·DNS 정책, fallback 없는 pinned resolver, 실제 peer 검증, 익명 HTTP client |
| `src/tools/web_fetch/content.rs` | streaming 수신 상한, 제한된 gzip 해제, charset·Content-Type, 원문/추출 구분 |
| `src/tools/web_fetch/cache.rs` | public opt-in cache, 민감 헤더·query 제외, 만료·entry/byte eviction |
| `src/tools/web_fetch/tests.rs` | 실제 모듈의 정책·상태 전이·경계 시험 및 내부 transport fixture |
| `tests/web_fetch.rs` | 소유 소스의 path 포함, public 계약·승인·계획 불일치·사전 취소·Send 시험 |
| `work/RESULT-08.md` | 이 인계 |

공통 파일·의존성·lockfile·TODO는 수정하지 않았다.
별도 crate·대체 구현·금지 IP를 허용하는 production/test 분기는 만들지 않았다.

## 공개 계약

```rust
pub fn spec() -> ToolSpec;
pub fn plan(args: &serde_json::Value) -> ToolResult<Planned>;
pub async fn execute(
    args: &serde_json::Value,
    planned: &Planned,
    cancel: tokio::sync::watch::Receiver<bool>,
) -> ToolResult<serde_json::Value>;
```

- 입력: 필수 `url`, 선택 `max_bytes`(본문 byte 상한, 기본 16384, 1..=32768). 추가 인자·헤더·cookie·인증 입력은 거부한다. 선택 null은 기존 registry 계약처럼 생략으로 취급한다.
- 계획: 정규화·fragment 제거한 URL과 본문 상한을 `{"tool":"web_fetch","url":...,"max_bytes":...}`에 고정한다. 계획은 DNS·네트워크를 수행하지 않는다. 실행 시 재파싱한 대상과 계획이 다르거나 precondition이 있으면 `stale_plan`이다.
- 권한: 기존 `Effect::Execute`를 보수적으로 사용한다. `needs_approval`을 우회하거나 로컬 `Read` 권한으로 외부 요청을 자동 허용하지 않는다. 새 effect는 추가하지 않았다.
- 결과: `requested_source`·최종 `source`(`url`, `query_redacted`), `status`, `redirects`, `content_type`, `representation`, `extraction`, `content`, `truncated`, `bytes_received`, `bytes_decoded`, `untrusted: true`, `cache.hit`.
- 출처 URL의 query는 제거하고 제거 여부만 표시한다. fragment도 반환하지 않는다. 요청 자체에는 원래 query를 사용하므로 승인 화면의 정확한 대상은 유지된다.
- UTF-8·ASCII만 지원한다. plain/markdown은 `text`·`not_needed`, HTML/XHTML은 `html_source`·`unsupported`, JSON/XML은 `structured_source`·`unsupported`다. binary·미지원 charset/압축은 명시적으로 실패한다.
- 오류 code: `invalid_arguments`, `invalid_url`, `blocked_url`, `blocked_address`, `dns_failed`, `stale_plan`, `invalid_redirect`, `too_many_redirects`, `http_status`, `invalid_response`, `unsupported_content_type`, `unsupported_charset`, `unsupported_encoding`, `invalid_encoding`, `response_too_large`, `output_too_large`, `network_failed`, `timeout`, `cancelled`, `internal`.
- 오류 메시지에는 원래 URL·query·redirect Location·헤더 값·응답 본문·reqwest 오류 원문을 넣지 않는다. HTTP 실패는 숫자 상태만 포함한다.

## 보안·자원 경계

- 최초 URL 및 각 redirect에 HTTP(S)·사용자 자격정보 금지·URL 2048 byte 제한을 적용한다.
- DNS의 모든 응답(최대 32개)이 공개 주소여야 하며 혼합 public/private 결과도 거부한다. literal IP·port 일치도 확인한다.
- IPv4 loopback/private/shared/link-local/문서/benchmark/multicast/reserved와 metadata 대상을 거부한다. Azure 플랫폼 IP `168.63.129.16`도 차단한다.
- IPv6는 보수적으로 `2000::/3`에서 특수 영역을 제외한다. mapped·NAT64·Teredo·6to4·ULA·link-local을 허용하지 않는다. 일부 publicly reachable 특수 anycast도 의도적으로 제외한다.
- 최초 DNS snapshot의 복사본만 돌려주는 `reqwest::dns::Resolve`를 연결 client에 사용한다. 다른 host는 실패하며 시스템 DNS로 fallback하지 않는다. URL의 원래 host는 유지하므로 Host·TLS 검증을 IP로 대체하지 않는다.
- hop마다 별도 client, 자동 redirect 금지, 환경 proxy 금지, 자동 Referer 금지, 자동 gzip/brotli/deflate/zstd 해제 금지다. cookie 저장소·사용자 헤더·profile 자격정보를 사용하지 않는다.
- 응답의 실제 peer가 검증한 socket 집합에 속하는지 확인한다. HTTPS downgrade는 거부한다. redirect 최대 5회이며 직접/최종 HTTP 200만 성공이다.
- wire 최대 1 MiB, 해제 최대 2 MiB, 본문 최대 32 KiB, JSON escaping을 포함한 전체 결과는 기존 `MAX_OUTPUT` 64 KiB 이하로 자른다. UTF-8 경계를 유지하고 `truncated`를 표시한다.
- connect timeout 5초, hop timeout 15초, DNS·전체 redirect·body·해제를 포함하는 전체 deadline 30초다. watch 취소는 대기 future/body를 drop하며 bounded 해제 loop도 취소·deadline을 확인한다.
- OS DNS 작업 자체는 Tokio의 시스템 resolver 특성상 future drop 뒤 백그라운드에서 끝날 수 있다. 취소된 요청이 후속 HTTP 연결을 시작하지는 않는다.
- cache는 프로세스 내 최대 16개, key+직렬화 값 합계 512 KiB, TTL 최대 60초다. query 없는 익명 요청의 직접 200 응답만 대상으로 명시적 `Cache-Control: public, max-age=...`를 요구하고 `Age`를 차감한다.
- redirect·실패·취소·금지 요청, query URL, cookie·인증·Vary·Pragma·Content-Disposition 응답, private/no-store/no-cache/불명확한 cache 정책은 저장하지 않는다. cache hit 전에도 현재 DNS를 재검증한다.
- cache의 민감도 판단은 익명 요청·URL query·HTTP 응답 정책/헤더에 근거한다. 원격 서버가 민감 본문을 잘못 public으로 선언하는 경우까지 내용 분류로 보장하는 기능은 없다.
- HTML을 실행하거나 DOM으로 렌더링하지 않는다. 출력은 끝까지 tool 데이터로 취급해야 하며 UI에서 raw HTML로 삽입하면 안 된다.

## 실제 검증과 미실행

| 명령/입력 | 결과 |
| --- | --- |
| `git rev-parse --show-toplevel`, `git branch --show-current`, `git status --short` | 지정 위치·branch 일치, 시작 clean |
| `git merge-base HEAD c186b31ab62734c9f91803cf7848b639ad9871fb` | 공통 기준 SHA 일치 |
| `source .envrc.dev && python3 scripts/build.py test --rust web_fetch --dry-run` | exit 0, `rust tests: cargo test --test web_fetch` |
| `source .envrc.dev && python3 -`에서 `Path('src/tools/web_fetch').glob('*.rs')`와 `tests/web_fetch.rs`를 UTF-8로 읽고 최종 LF·행 끝 공백 검사 | 최종 Rust 파일 6개 통과. Rust 실행 검사는 아님 |
| Rust 컴파일·`python3 scripts/build.py test --rust web_fetch` | COMMON 자원 계약에 따라 미실행. 시험 통과·타입/Send 검증 성공을 주장하지 않음 |
| 실제 HTTP/TLS/proxy/DNS 연결·서버·브라우저·E2E·전체 회귀 | 미실행. 연결·등록은 통합 단계 범위 |

작성한 시험은 URL 우회 표기, 특수 IP, 혼합 DNS, DNS snapshot/fallback 금지, peer 불일치, 사용자 자격 헤더 미전달, redirect 재검증·5/6회 경계, 형식/charset/압축 오류, wire·해제 상한, gzip checksum/member, UTF-8/JSON 출력 상한, public cache·TTL·eviction·DNS 재검증, 실행 중 DNS/connect/body 취소, deadline·닫힌 false 취소 채널, 승인 대상·Send를 다룬다.
fixture는 공인 형태 주소를 반환하는 내부 transport일 뿐 실제 TCP가 그 주소로 연결됐다는 증거가 아니다. production 금지 IP 정책은 그대로 통과한다.

정책 근거는 IANA IPv4/IPv6 Special-Purpose Address Space(2025-10-09 갱신판), HTTP client/resolver API 근거는 lockfile의 reqwest 0.12.28 문서다. 본문 추출 의존성은 추가하지 않았다.

## 통합 담당의 다음 작업

1. `src/tools/mod.rs`에서 `pub mod web_fetch`, `specs()`의 spec, `plan()`의 plan 연결을 추가한다.
2. `execute()`의 async match에서 `web_fetch::execute(args, planned, cancel).await`를 직접 연결한다. 네트워크 future를 현재 동기 도구용 `spawn_blocking` 분기에 넣지 않는다.
3. 기존 승인 저장·대상 표시·runner tool 노출에 연결하고 `Effect::Execute` 승인이 실제로 적용되는지 확인한다. 계획의 URL query는 정확한 요청 대상이므로 불필요하게 로그에 복제하지 않는다.
4. 승인된 공통 빌드 환경을 적용한 뒤 `python3 scripts/build.py test --rust web_fetch`를 실행한다. 현재 시험 target은 registry 연결 전에도 실제 소스와 내부 시험을 포함하도록 path로 참조한다. 타입·컴파일·행동 검증은 아직 남아 있다.
5. 실제 client의 proxy 차단·TLS host 유지·DNS 고정·peer·취소와 runner/승인 경계를 검증한다. localhost fixture를 위해 production IP 정책을 낮추지 않는다.
6. 안전한 HTML 본문 추출 지원 방법을 별도로 결정한다. 지금의 원문 fallback을 본문 추출 완료로 표시하지 않는다.
7. `INTEGRATION-002`의 본문 추출·제품 연결·필수 검증이 모두 충족되기 전까지 `TODO.md`의 `[ ]`를 유지한다. 검색·브라우저·로그인·JS·유료 API·LAN 허용으로 확장하지 않는다.

로컬 커밋 범위는 위 소유 파일뿐이다. push·merge·배포·서비스 중단은 수행하지 않는다.
