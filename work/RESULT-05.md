# b01 / 05 — USAGE-007 인계

## 식별·상태
- Worktree: `/home/ubuntu/.local/share/paseodog/paseo/worktrees/0q796rug/b01-05-usage-ui`
- Branch: `parallel/b01-usage-ui`
- 공통 기준 SHA: `c186b31ab62734c9f91803cf7848b639ad9871fb`
- 실제 Git top-level·branch가 ENTRY/README/05와 정확히 일치하며 `git merge-base HEAD <기준 SHA>`도 기준 SHA였다. 시작 시 working tree는 clean이었다.
- 상태: 지정 범위 구현 종료, 통합·실행 검증 대기. 공통 파일 연결 blocker는 없다. 웹 의존성 부재로 실행 검증은 하지 못했다.
- 개발 세션 조회는 `session list`에서 `session: cross-session control is unavailable in this runtime` 오류로 불가능했다. 다른 세션의 변경을 인수하거나 수정하지 않았다.

## 제공 동작·소유 변경
- `web/app/components/UsagePanel.tsx`: 기존 조회·기간·그룹·시간대와 CapacitySection을 보존하고 표현 컴포넌트를 연결했다. 로딩·오류·빈 결과·마지막 성공 데이터 구분, 새로고침/재시도를 추가했다.
- `web/app/components/usage/model.ts`: 기존 Row/Report 형태의 타입, 총 token·비율·금액 표시와 정렬. 원본 배열을 변경하지 않는다.
- `web/app/components/usage/UsagePresentation.tsx`: 총 token/입력/출력/응답/통화별 비용 카드, 입력·출력 SVG 도넛, 그룹별 비교 표, 정렬 선택, 보고·미보고 상세.
- `web/app/components/usage/usage.css`: 프로젝트 테마 변수를 사용하는 전용 스타일. 좁은 화면에서는 카드가 줄바꿈되고 비교 표는 키보드로 접근 가능한 가로 스크롤 영역이다. 수치 갱신 애니메이션은 넣지 않았다.
- `web/app/components/usage/model.test.ts`: 독립 기대값으로 변환·통화·정렬·0/미설정/작은 비용을 검증하는 5개 단위시험.
- `web/app/components/usage/presentation.test.ts`: React 정적 렌더링으로 텍스트 대체·0 분모·미보고·가격 미설정·표 접근성을 검증하는 2개 단위시험.
- `web/e2e/usage-presentation.spec.ts`: 카드/도넛/정렬/키보드/기간·그룹, 로딩/실패/빈 결과/0 token/stale/재시도, 실행 용량/대기/취소 오류·재시도 등 3개 브라우저 시나리오. 조회·취소 응답은 페이지별 route fixture로 격리하며 실제 요청 취소나 모델 호출을 하지 않는다.
- `work/RESULT-05.md`: 이 인계.

## 공개 계약·연결
- `UsagePanel()`의 기존 export와 `usage-panel`, `usage-total`, `usage-table`, `usage-capacity` test ID를 유지했다. 기존 `Settings.tsx` 호출로 이미 연결되므로 새 API/store/공통 등록이 필요하지 않다.
- `UsagePresentation({ report: UsageReport, groupLabel: string })`: 기존 `/usage` 응답의 `rows`, `total`, `pricing_versions`를 받는다. 정렬 상태만 내부 소유하며 외부 변경 callback은 없다.
- `TokenDonut({ total: UsageRow })`: 입력·출력 구성과 동일한 수치·비율·분모의 텍스트를 제공한다. SVG는 보조기술에서 숨기고 figcaption을 읽도록 한다.
- `model.ts` exports: `UsageRow`, `UsageReport`, `SortKey`, `SortDirection`, `formatNumber`, `totalTokens`, `tokenShare`, `formatShare`, `formatCost`, `costCurrencies`, `sortRows`.
- `SortKey`는 `label | tokens | input_tokens | output_tokens | responses | cost:${string}`이며 `SortDirection`은 `asc | desc`다. 숫자는 숫자로, 이름은 한국어 locale로 비교하며 동점은 key 오름차순이다. 선택 통화 추정치가 없는 행은 방향과 무관하게 마지막이다. 통화가 기간/그룹에서 사라지면 총 token 기준으로 표시한다.
- `totalTokens`와 모든 비율 분모는 `input_tokens + output_tokens`다. 서버 `src/usage.rs` 계약상 cache는 입력, reasoning은 출력에 이미 포함되어 재합산하지 않는다. 0 분모는 비율 `—`와 계산 불가 문구, 작은 양의 비율은 `0.1% 미만`으로 표시한다.
- 비용 배열의 통화를 합산·환산하지 않는다. 통화별로 계산된 금액만 정렬하고 미설정 token의 비용 제외를 표시한다. 비용 배열 없음은 `가격 정보 없음`, 실제 가격표상 0은 `0 USD` 등으로 구분하며 서버의 소수 여섯 자리 정밀도를 보존한다.
- reasoning은 보고된 합계와 미보고 응답 수를 구분한다. 모든 응답이 미보고면 0 대신 `보고된 값 없음`을 표시한다.
- 오류/권한: 기존 `api.get("/usage?...")`, `useQuery`, 인증·ApiError·취소 동작을 그대로 사용한다. 조회 실패는 일반 오류 문구와 재시도를 제공하며, 이전 성공 데이터가 남아 있으면 오래된 값임을 명시한다. `CapacitySection` 본문은 변경하지 않았다.

## 검증 근거·미실행
- 실행: `git rev-parse --show-toplevel`, `git branch --show-current`, `git status --short`, `git merge-base HEAD c186b31ab62734c9f91803cf7848b639ad9871fb` — 지정 경로/브랜치, clean 시작, 공통 기준 확인.
- 실행: `source .envrc.dev && python3 scripts/build.py test --vitest app/components/usage/model.test.ts app/components/usage/presentation.test.ts --dry-run` — exit 0. 선택 실행 계획이 `npx vitest run app/components/usage/model.test.ts app/components/usage/presentation.test.ts`임만 확인했다. 시험 통과 근거가 아니다.
- 실행: `git diff --check`, `git diff --cached --check` — 모두 exit 0. staged 검사는 새 코드·시험·인계를 포함한 8개 파일에 적용했다.
- 미실행: 위 선택 Vitest 실제 실행. `web/`에 `node_modules`가 없으며 COMMON은 의존성 설치·복사를 금지한다. 설치나 npx 다운로드 우회는 하지 않았다.
- 미실행: typecheck, 웹 build, Rust 컴파일·통합시험, E2E. COMMON에서 통합 단계로 유보했고 브라우저·서버를 띄우지 않았다. 따라서 실제 렌더링·키보드·반응형·테마·기존 회귀를 통과했다고 주장하지 않는다.
- 영향 경계 확인: Settings의 기존 UsagePanel 연결, useQuery의 `data/error/loading/reload` 계약과 stale 데이터 보존, API 인증·오류·취소 계약, `queueText`의 공급자 한도 문구, `src/usage.rs` token/통화 집계, 기존 `web/e2e/workspace.spec.ts`의 사용량 test ID/가격 미설정 기대를 확인했다.

## TODO 전체 요구·남은 조건
- `USAGE-007` 카드: 기존 합계의 입력/출력/총 token/응답과 통화별 비용을 표시한다.
- 도넛·색상·텍스트 대체: 입력/출력 비율은 동일 분모의 숫자·텍스트로도 제공하고, 그룹별 표에 절대값과 기간 전체 대비 비율을 제공한다. cache/reasoning은 상세로 분리한다.
- 정렬·접근: 이름/총 token/입력/출력/응답/통화별 추정 비용과 양방향 정렬을 native select로 제공한다. 표는 caption·scope·포커스 가능한 스크롤 영역을 갖는다.
- 기존 기간·그룹 변경과 용량/대기/취소를 유지했으며 해당 시나리오를 시험으로 작성했다.
- 남은 요구: 실제 단위·타입·빌드·브라우저 검증과 통합 담당의 TODO 판단. 구현 근거만 있으며 전체 요구 충족·완료 후보를 확정하지 않는다. `TODO.md`는 수정하지 않았다.

## 다음 통합 단계·위험
1. 준비된 공통 웹 환경에서 위 선택 Vitest와 typecheck를 실행한다.
2. 순차 실행 슬롯에서 `python3 scripts/build.py test --e2e e2e/usage-presentation.spec.ts`를 실행하고 기존 `e2e/workspace.spec.ts`의 사용량 흐름도 영향 회귀로 확인한다. 실제 키보드·좁은 화면·테마별 대비와 도넛/표를 확인한다.
3. 검증 결과와 USAGE-007 전체 요구를 대조한 뒤 통합 담당이 `TODO.md`를 갱신한다.
- 남은 위험은 실행 검증 부재다. 서버 데이터·권한·집계·공통 store·dependency/lockfile은 변경하지 않았다.
- 작업 관련 코드·시험·RESULT만 로컬 커밋하며 push·merge·배포·서비스 중단은 하지 않는다. 이 파일에는 자신을 포함한 커밋 SHA를 쓰지 않는다.
