# 00 — 타당성 보고서: 기존 제품(TS/Node + 기존 엔진) → Grove(Rust 서버 + 공용 웹앱)

작성일: 2026-11-05. 조사 대상: `<기존 제품 원본>` (읽기 전용).

## 키트 6단계 색인

1. 지도와 규칙: 의존성 지도·gap inventory·rulebook(재설계이므로 설계 문서).
2. 규칙 시험: 재설계라 bakeoff 무효 → 설계 문서 적대적 검토로 대체.
3. 전체 번역: 단위(재설계: 서브시스템)마다 구현·검토·수정.
4. 컴파일: 서베이 빌드 → 오류 큐.
5. 실행: hello world → smoke.
6. 동작 일치: judge(동등성 판정기)로 기존 대비 동작 대조.

## 떠나야 하는 이유 (이 저장소의 근거)

- 런타임 3중 계층: 이전 서버(`android/packages/server/src`, TS 1,068파일·442,636줄), 기존 엔진(`engine/node_modules/<기존 엔진>/src`, mjs 2,568파일·545,190줄), 그 둘을 잇는 플러그인(`plugin`, 36파일·5,520줄)과 엔진 브리지(`engine/src`, 16파일·2,052줄)가 별도 프로세스·JSON Lines로 연결됨 (TODO ARCH-004가 제거 대상으로 명시).
- upstream 패치 부담: `patches/` 53파일·3,748줄이 두 upstream에 덧대는 수정이며, 기준 SHA `73416e27`에서 원본 HEAD가 이미 25커밋 이동(`bd84a7e`).
- 빌드 그래프: APK·데스크톱·웹·데몬이 한 릴리스 스크립트(`scripts/build-release.mjs`)에 묶여 UI 변경만으로도 여러 산출물 재빌드(TODO FLOW-10).

## 세 가지 판단

1. **구조 보존 vs 재설계 → 재설계.** 목표 구조가 단일 Rust 실행 파일 + 정적 웹/PWA이며, 기존 데몬/엔진/플러그인 경계와 React Native/Expo 구조(`android/packages/app/src`, 2,188파일)를 재현하지 않는다는 결정이 TODO §0에 있음. 구제품 wire protocol 호환도 비목표(DEC-014).
   결정 근거 파일: `android/packages/server/src`, `engine/node_modules/<기존 엔진>/src/runtime`, `plugin/server`, `android/packages/app/src`.
2. **검증 비용.** 기준선: `npm --prefix plugin run typecheck` 2.67초·RSS 534MB(실측). 전체 Android/데스크톱 빌드는 시간 측정하지 않음(가정: 수 분~수십 분). 대상 Rust는 `cargo check`가 증분 수 초~수십 초 예상(가정: 단일 crate, 의존성 컴파일 1회 후 증분) → 컴파일러를 각 서브시스템 루프 안에 둔다.
   결정 근거 파일: `plugin/tsconfig.json`, `scripts/build-release.mjs`.
3. **테스트 생존 → 거의 생존하지 않음.** 저장소 루트 `tests/*.test.mjs` 128개 중 프로세스/HTTP/WebSocket을 쓰는 것 25개, 나머지 103개는 내부 모듈 import. `android/packages`의 `*.test.ts(x)` 1,239개(server 559·app 680) 대부분이 TS 내부 import이고, 실제 외부 e2e는 server `*.e2e.test.ts` 136개(대부분 실 provider 필요). 프로토콜이 바뀌므로 외부 표면 테스트도 신규 제품에 그대로 실행할 수 없다.
   - 공용 표면 예: `tests/connection.test.mjs`, `tests/graceful-shutdown.test.mjs`, `android/packages/server/src/server/agent/agent-response-loop.real.e2e.test.ts`.
   - 내부 import 예: `tests/journal.test.mjs`, `tests/json-lines.test.mjs`, `tests/markdown-table.test.mjs`.
   → **judge를 먼저 만든다.** 재설계 이전의 done-gate는 키트 README 규칙대로 "구축한 동등성 판정기의 시나리오 목록"이며, 시나리오 씨앗은 TODO §2의 FLOW-01~17이다.

## 이 저장소에 대입한 6단계

| 단계 | 이 저장소에서의 의미 | 키트 프롬프트 |
|---|---|---|
| 1 | TODO.md 기능 ID를 서브시스템 단위 작업 지도로, 설계 문서 `migration/RULEBOOK.md`, gap inventory(소유권·취소·불명 상태 지점) | 01, 02 (재설계 변형) |
| 2 | 설계 문서 적대적 검토(보안·복구·동시성 관점), 일회성 전체 실행 대신 P1 수직 슬라이스 | 03 (bakeoff 대체) |
| 3 | 서브시스템별 구현 + 회귀 시험 (`src/<module>`, `web/app`) | 04 |
| 4 | `cargo check`/`tsc`가 저렴하므로 3단계에 흡수 | 05 생략 |
| 5 | `grove --version` → 서버 기동 → 로그인/세션 smoke | — |
| 6 | FLOW 시나리오 harness(`tests/flow_*.rs`, `web/e2e`)로 판정, 이후 `TODO(port)` 정리 | 06 |

작업 단위 수: TODO 체크박스 1,086개 → 서브시스템 약 40개(TODO 2~33절 영역 접두어 기준).

## 비용과 기간 (대역 추정)

- 동인: 서브시스템 ~40 × (구현 + 자기 검토 + 수정) × 컴파일러 비용(저렴). 서브에이전트 fan-out 없음(Solo 모드).
- 토큰: 10⁷~10⁸ 대역. 정확한 수치는 의도적으로 제시하지 않음.
- 실제 기기·계정이 필요한 항목(Android 실기기, Windows 실기기, OAuth 구독 계정, 과금 모델 호출, 상표 조사)은 이 환경에서 완료 불가 → blocker로 남는다.

## 모델 계획

| 단계 | 모델 | 이유 |
|---|---|---|
| 설계 문서 작성·수정 | 현 세션 모델(최상위) | 모든 결과물에 복제되는 오류의 폭발 반경이 가장 큼 |
| 구현·수정 | 현 세션 모델 | Solo 모드: 위임은 사용자 명시 요청 시에만 |
| 검토 | 현 세션 모델의 별도 검토 패스 | 독립 reviewer 서브에이전트 미사용 → DEV-002로 기록 |

## 판정

**지금 이전한다 — 단, 재설계 경로로.** 원본은 고정 SHA를 명세로만 쓰고 런타임 의존성으로 쓰지 않는다.
판정을 바꿀 수 있는 사실: 실제 사용할 OAuth 구독 계정을 서드파티 Rust 클라이언트에서 쓸 수 있는지(DEC-010). 하루 안 확인 방법: provider 공식 약관/문서 확인과 API 키 경로 실호출 1회(과금 승인 필요).

## 읽은 것과 실행한 것

읽음: `package.json`, TODO.md 전체 구조, `tests/` 목록, `android/packages` 구성, 기존 엔진 `src/runtime` 목록. 실행: 파일/줄 수 집계, `git rev-parse`, 기준 SHA 존재 확인, `npm --prefix plugin run typecheck` 1회.
