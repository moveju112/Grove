# 혼동하기 쉬운 계약

## 실행 migration 위치 혼동

Symptom: `migration/`에 SQL 파일을 추가하고 schema 갱신이 끝났다고 판단한다.
Cause: 설계 문서 디렉터리와 `MIGRATIONS` 실행 배열을 혼동했다.
Fix: [DB_RULES.md](DB_RULES.md)에 따라 배열 끝에 추가하고 기존 DB·신규 DB 경로를 검사한다.
근거: `evidence: src/store.rs`.

## 일부 검사만 실행

Symptom: `--rust pairing --rust access`로 두 대상을 실행했다고 보고한다.
Cause: 같은 argparse 옵션을 재지정해 앞 목록이 대체된다.
Fix: `--rust pairing access`처럼 한 옵션 뒤에 대상을 모은다. [CODING_RULES.md](CODING_RULES.md) 참조.
근거: `evidence: scripts/build.py:522`.

## 시험 파일을 찾지 못함

Symptom: `No test files found, exiting with code 1`
Cause: 확장자가 Vitest의 `app/**/*.test.ts` 선택 범위와 다르다.
Fix: 기존 선택 범위에 맞춰 작성한다. JSX가 필요하면 `web/app/components/HelpTip.test.ts`처럼 `createElement`를 사용할 수 있다.
근거: `evidence: web/app/components/HelpTip.test.ts`, `evidence: web/vite.config.ts`.

## 타입만 맞고 런타임 계약은 불일치

Symptom: `서버 응답이` 포함된 `invalid_response` 오류가 발생한다.
Cause: Rust 계약·생성 TypeScript·metadata 중 일부만 갱신했다.
Fix: [RESPONSE_KEYS.md](RESPONSE_KEYS.md)의 두 산출물 생성과 drift 검사를 함께 수행한다.
근거: `evidence: web/app/api/validation.ts`.

## 기능 접수를 완료로 오해

Symptom: `unknown`을 자동 재실행하거나 `deferred` 업데이트를 적용 완료로 보고한다.
Cause: 접수와 외부 부작용 확정·release 전환을 같은 상태로 취급했다.
Fix: [ENUM_CODES.md](ENUM_CODES.md), [DEPLOY.md](DEPLOY.md)의 결과 불명·전환 기준을 따른다.
근거: `evidence: src/runner.rs:365`, `evidence: src/update.rs:754`.
