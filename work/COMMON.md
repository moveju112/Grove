# b01 기능 담당 공통 계약

## 시작 즉시 독립 구현
이 파일과 자기 번호 문서, 적용되는 프로젝트·공통·UI 규칙을 읽는다.
현재 cwd·브랜치·Git 상태와 자기 번호 문서의 기준 SHA에서 분기했는지 확인한다. 초기 00~09는 `c186b31ab62734c9f91803cf7848b639ad9871fb`이며, 이후 번호는 번호 문서에 새 기준을 명시한다.
자기 worktree가 아니거나 출처 불명 변경이 있으면 편집하지 말고 구체적 blocker를 보고한다.
올바른 worktree에서는 추가 계획 승인을 기다리지 말고 배정 범위를 구현한다.
다른 세션·통합 담당에게 실시간 메시지·슬롯·승인을 요구하지 않는다.
새 공통 변경·계약 충돌은 해당 부분만 보류하고 독립 범위를 끝낸 뒤 인계 파일에 모은다.
핵심 범위 전체가 막히면 blocker를 기록하고 종료한다. 임의로 다른 기능을 맡지 않는다.

## 편집 소유권
번호 문서의 경로·공통 파일 연결 지점과 자기 `work/RESULT-NN.md`만 수정한다. 다른 경로는 읽기만 가능하다.
번호 문서가 연결 지점을 지정했다면 그 범위의 등록·라우트·화면 mount를 직접 연결해 기능이 실제 경로에서 동작하게 끝낸다. 지정되지 않은 다음 공통 파일은 메인 세션이 연결한다:
`TODO.md`, `AGENTS.md`, `src/lib.rs`, `src/store.rs`, `src/runner.rs`, `src/tools/mod.rs`,
`web/app/components/SessionView.tsx`, `web/app/components/Composer.tsx`, `web/app/components/Settings.tsx`,
`web/app/state/store.ts`, `web/app/api/`, `web/app/app.css`,
dependency/lockfile, 공통 빌드·E2E 설정, migration.
소유 파일 목록에 명시한 기존 파일 외에는 기존 파일을 수정하지 않는다.
전용 폴더 안 파일은 필요에 맞게 추가할 수 있으나 이름만 맞춘 범위 밖 기능은 넣지 않는다.
새 dependency·업그레이드·원격 설치는 하지 않는다. 필요성을 인계한다.
실제 파일을 재사용할 수 없다는 이유로 동일 구현을 복제하거나 보안을 낮추지 않는다.

## 공통 연결 방식
Rust 전용 모듈은 기존 `ToolResult`·`ToolError`·`Planned`와 권한 경계를 재사용한다.
공통 등록이 없어 컴파일 그래프에 아직 들어가지 않는다면 이를 인계에 명시한다.
도구용 모듈의 기본 연결은 기존 registry의 plan/execute 형태를 따른다.
기존 계약과 다르면 명시적 차이를 남긴다. 통합되지 않은 임시 standalone crate·가짜 실행기를 만들지 않는다.
웹 신규 컴포넌트는 typed props/callback으로 외부 상태·행동을 받는다.
공통 API·store를 바꾸거나 존재하지 않는 API를 실제로 호출해 완성처럼 보이게 하지 않는다.
00·01의 새 조회 UI는 데이터를 주입받는 방식으로 만들고 서버 라우트 연결은 통합 단계로 남긴다.
인계에는 export·입출력·오류·필요 호출 위치와 미연결 조건을 적는다.

## 검증·자원
독립 조사·관련 편집은 묶고 유효한 근거는 재사용한다. 보안·오류·복구 분기를 생략하지 않는다.
실시간 자원 조율은 하지 않는다. E2E·전체 회귀·release·패키징은 통합 단계에서 실행한다.
완료 직전 자기 기능의 선택 Rust 시험(컴파일 포함)과 Vitest·typecheck를 프로젝트 선택 검사 진입점으로 한 번 실행한다. 컴파일되지 않는 코드를 인계하지 않는다. 실패는 고친 뒤 실패한 검사만 다시 실행한다.
worktree에는 Rust 툴체인(`.dev`)과 `web/node_modules`가 없다. 설치·복사하지 말고 메인 것을 쓴다:
- Rust: `source /data/project/paseodog_opus/.envrc.dev`. 자기 worktree의 `.envrc.dev`가 `$PWD/.dev`를 가리키는 옛 버전이어도 이 절대 경로를 source한다.
- 웹: `web/node_modules`가 없으면 `ln -s /data/project/paseodog_opus/web/node_modules web/node_modules`. Git ignore 대상이라 worktree는 clean으로 남는다. `npm install`·`npm ci`는 하지 않는다.
- Rust 검사는 여러 세션이 동시에 빌드하지 않도록 `flock /home/ubuntu/.cache/grove-rust-check.lock python3 scripts/build.py test --rust ...`로 실행한다. 웹 검사는 잠금 없이 실행한다.
프로젝트의 해당 선택 검사 진입점을 사용한다. 환경이 없으면 설치나 우회 대신 미실행으로 기록한다.
시험은 작성하되 미실행을 통과로 보고하지 않는다. 연결 없는 모듈이 기존 검사에서 제외된 사실을 숨기지 않는다.
각 worktree에 target·node_modules·툴체인을 통째로 복사하거나 설치하지 않는다.
다운로드 cache는 기존 정책을 유지한다. 큰 산출물 생성은 이번 독립 단계에서 하지 않는다.
실제 사용자 데이터·자격증명·서비스·유료 모델·외부 시스템에 부작용을 일으키지 않는다.

## 완료 인계: 사용자에게 결과 복사를 요구하지 않기
사용자가 요청한 인계 파일 `work/RESULT-NN.md`를 자기 worktree 안에 작성한다.
다음 내용을 빠짐없이 포함한다:
- 배치/번호, worktree 절대 경로, branch, 공통 기준 SHA.
- 제공 동작, 소유 변경 파일, 구현 종료·통합 대기·blocker 중 현재 상태.
- public export/props, 입출력·오류·권한 계약, 공통 파일에서 필요한 연결.
- 실제 실행한 검사 명령·입력·결과, 실패·미실행과 이유.
- TODO ID별 전체 요구 충족 근거, 부분 완료·남은 요구. 미검증 항목을 완료 후보로 단정하지 않는다.
- 남은 위험·환경 제약, 다음 통합 단계.

RESULT 자체에 그 파일을 포함한 커밋 SHA를 써서 순환 수정하지 않는다.
로컬 커밋이 승인돼 있으면 관련 코드·시험·RESULT만 함께 커밋하고 한국어 메시지를 사용한다.
최종 채팅에는 완료 SHA와 RESULT 절대 경로, blocker 유무만 짧게 알린다.
커밋 승인이 없으면 파일은 남기고 미커밋임을 명시한다.
이후 편집을 멈춘다. push·merge·배포·서비스 중단·다른 기능 착수는 하지 않는다.
`TODO.md`는 기능 담당이 체크하지 않는다. 통합 담당이 실제 연결·필수 검증 후 반드시 체크하며 미완료는 남긴다.
통합 담당은 인계 보존·검증 후 완료 worktree와 Paseo 워크스페이스를 정리한다. 기능 담당은 직접 삭제하지 않는다.
