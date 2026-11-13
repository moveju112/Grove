# 병렬 개발: 선정 → 독립 구현 → 일괄 통합

## 사용법
사용자는 메인 세션에 “남은 거 10개 뽑아줘”라고 요청한다.
통합 담당은 이 대화에 고정되지 않는다. 원본 프로젝트에서 다른 세션을 열고 `work/INTEGRATE.md`로 같은 역할을 수행할 수 있다.
통합 담당이 현재 변경·TODO·의존성을 확인하고 기준 커밋, 겹치지 않는 기능, worktree, 작업 문서와 시작 프롬프트를 준비한다.
사용자는 준비된 워크스페이스 각각에서 세션을 열고 `work/START.md`의 동일한 공통 프롬프트를 보낸다.
`work/ENTRY.md`가 실제 Git top-level 경로와 브랜치를 대조해 번호 문서를 자동 선택한다. 사용자가 번호를 바꿔 붙여넣을 필요가 없다.
각 담당은 구현을 끝내면 자기 worktree의 `work/RESULT-NN.md`에 인계 내용을 남기고 종료한다.
일부 또는 전체 작업이 종료되면 사용자는 메인 세션에 `work/START.md`의 통합 프롬프트를 보낸다. 완료된 작업만 통합하고 나머지는 계속 진행한다.
통합 담당이 직접 인계 파일과 Git 상태를 읽으므로 사용자에게 결과 복사·실시간 중계를 요구하지 않는다.
관리·검증 전용 에이전트를 추가로 띄울 필요는 없다. 원본 프로젝트의 메인 세션 하나가 통합을 맡는다. 사용자가 부르는 “00 메인 세션”도 가능하며, 기존 00 원본 설정 기능 worktree와는 구분한다.
초기 배치는 06을 제외한 00~09, 총 9개 기능 담당이었다. 운영 목표는 활성 10개이며, 정리 직후 같은 흐름에서 목표 수까지 다음 번호로 보충한다. 다음 최초 번호는 10이며 기존 번호는 재사용하지 않는다.
통합·검증·TODO 반영 후 종료된 작업의 worktree와 Paseo 워크스페이스를 정리하고 다음 작업을 자동 준비한다. 세부 절차는 `work/INTEGRATE.md`가 정본이다.

## b01 고정 기준
- 기준 SHA: `c186b31ab62734c9f91803cf7848b639ad9871fb`.
- 원본 프로젝트: `/data/project/paseodog_opus`.
- 지시 문서: `/data/project/paseodog_opus/work/COMMON.md`와 번호별 문서.
- 이 문서는 원본 프로젝트에만 있으므로 기능 세션은 위 절대 경로로 읽는다. 원본 프로젝트는 편집하지 않는다.
- 소스 공통 파일에는 준비용 가짜 구현을 넣지 않았다. 미연결 모듈은 제품 기능 완료가 아니라 통합 대기다.
- 03은 parser 의존성이 없는 assistant 이름·사진 표시로 변경했다. 코드 구조 분석은 이번 배치 밖이다.
- 기존 개발 세션에서 같은 기능의 연속 개발을 동시에 재개하지 않는다.
- 사용자 결정으로 06 작업은 취소됐고 빈 워크스페이스도 제거했다. 재생성·재배정·통합하지 않는다. 다음 배치는 원본 `TODO.md`의 최신 제외 결정을 따른다.

## 준비 완료된 워크스페이스
| 번호 | 브랜치 | worktree 절대 경로 |
|---|---|---|
| - | 없음 | b01 작업 workspace는 모두 정리했다 |

## 완료·정리 이력
통합 담당은 정리 전에 통합 SHA·검증·보존 근거를 기록하고, 서비스 결과 확인 후 정리 상태를 갱신한다.
새 작업을 준비하면 보충 번호를 기록한다. 재실행 시 이미 보충한 자리를 중복 생성하지 않는다.
06의 사용자 취소는 보충 대상 완료로 세지 않는다. 아래 정리 대상은 `53f634b`에 코드·인계·TODO와 통합 연결이 보존돼 있다. 02의 실제 원격 호스팅·TLS 검증은 미실행이며 `WEB-003`은 미완료로 유지한다.
00·01·04·07·08은 사용자 요청으로 남은 작업을 `master`에서 이어 하도록 정리했다. 브랜치 코드·RESULT는 통합 SHA에 보존돼 있고, 각 RESULT의 미연결·미검증 항목과 해당 TODO `[ ]`는 그대로 남는다. 08은 `31585a2`에서 도구 목록·승인 화면에 연결했지만 HTML 본문 추출이 미지원이라 `INTEGRATION-002`는 미완료다.

| 번호 | 작업 브랜치·tip | 통합 SHA | RESULT 경로·검증 근거 | workspace ID·절대 경로 | 정리 상태 | 보충 번호 |
|---|---|---|---|---|---|---|
| 02 | `parallel/b01-web-base` · `7de966564c3d426f2a90e6157c5874157318b137` | `53f634b` | `work/RESULT-02.md`; 서버 2개, base/worker/Pages 단위 52개, 루트·하위 경로 E2E 4개 및 기존 PWA 회귀 통과 | `wks_e675c092ea9c3feb` · `/home/ubuntu/.local/share/paseodog/paseo/worktrees/0q796rug/b01-02-web-base` | workspace·종료 세션 archive, 디렉터리·Git 등록 제거 확인; 브랜치 유지 | 미배정 |
| 03 | `parallel/b01-assistant-identity` · `df94a3056ab58759c488aaecc198f4b7a79f0c14` | `53f634b` | `work/RESULT-03.md`; 단위 50개, identity E2E 3개 및 기존 봇 회귀 통과 | `wks_df7a705fd9c77bdb` · `/home/ubuntu/.local/share/paseodog/paseo/worktrees/0q796rug/b01-03-assistant-identity` | workspace·종료 세션 archive, 디렉터리·Git 등록 제거 확인; 브랜치 유지 | 미배정 |
| 05 | `parallel/b01-usage-ui` · `fd1e3bf4fbd754b2fe6bd963f049042cf9d9e17f` | `53f634b` | `work/RESULT-05.md`; 단위 7개, 사용량 E2E 3개 통과 | `wks_4eb1e336ad21d6c9` · `/home/ubuntu/.local/share/paseodog/paseo/worktrees/0q796rug/b01-05-usage-ui` | workspace·종료 세션 archive, 디렉터리·Git 등록 제거 확인; 브랜치 유지 | 미배정 |
| 09 | `parallel/b01-approval-ui` · `ab5413d2ed6fcd1e543d992bbc7872818d5d9546` | `53f634b` | `work/RESULT-09.md`; 단위 27개, 승인 E2E 4개 및 workspace 회귀 통과 | `wks_424ce685e3fd8e91` · `/home/ubuntu/.local/share/paseodog/paseo/worktrees/0q796rug/b01-09-approval-ui` | workspace·종료 세션 archive, 디렉터리·Git 등록 제거 확인; 브랜치 유지 | 미배정 |
| 00 | `parallel/b01-source-settings` · `241ff11b293eb581ac929717f394b16ca82d02e7` | `53f634b` | `work/RESULT-00.md`; 원본 설정 시험 10개·화면 단위 5개 통과, 화면 연결은 남음 | `wks_91d76c31ae4ecfea` · `/home/ubuntu/.local/share/paseodog/paseo/worktrees/0q796rug/b01-00-source-settings` | 남은 작업 `master` 이관 후 archive; 브랜치 유지 | 미배정 |
| 01 | `parallel/b01-skills` · `44734ca2000a41f95a452735d76663ff286c49fb` | `53f634b` | `work/RESULT-01.md`; 스킬 시험 12개·화면 단위 7개 통과, 모델 경로 연결은 남음 | `wks_16d610705b66acbc` · `/home/ubuntu/.local/share/paseodog/paseo/worktrees/0q796rug/b01-01-skills` | 남은 작업 `master` 이관 후 archive; 브랜치 유지 | 미배정 |
| 04 | `parallel/b01-image-read` · `787b4f14f1334fc91feebea7552a721dcaecd627` | `53f634b` | `work/RESULT-04.md`; 이미지 읽기 11개·첨부 15개 통과, 모델 경로 연결은 남음 | `wks_4d1f2e6439fd1201` · `/home/ubuntu/.local/share/paseodog/paseo/worktrees/0q796rug/b01-04-image-read` | 남은 작업 `master` 이관 후 archive; 브랜치 유지 | 미배정 |
| 07 | `parallel/b01-linux-service` · `37b55bfbe34121592feecf62d015680d29fa09eb` | `53f634b` | `work/RESULT-07.md`; `scripts/test_user_service.py` 통과, 실제 서비스 검증은 남음 | `wks_9b5efc61967806b7` · `/home/ubuntu/.local/share/paseodog/paseo/worktrees/0q796rug/b01-07-linux-service` | 남은 작업 `master` 이관 후 archive; 브랜치 유지 | 미배정 |
| 08 | `parallel/b01-web-fetch` · `840c51ac51c140a64c6994fd10a7e612193302cf` | `31585a2` | `work/RESULT-08.md`; web_fetch 28개·승인 화면 20개 통과, HTML 본문 추출·실제 네트워크 검증은 남음 | `wks_b3a27f07ded8d599` · `/home/ubuntu/.local/share/paseodog/paseo/worktrees/0q796rug/b01-08-web-fetch` | 남은 작업 `master` 이관 후 archive; 브랜치 유지 | 미배정 |

## 이월 작업
정리된 작업의 남은 연결·검증이다. 다음 보충에서 우선 배정 후보로 쓴다. 세부 조건은 각 RESULT가 정본이다.

| 출처 | 남은 작업 | 근거 | 배정 |
|---|---|---|---|
| 00 | 원본 설정 조회의 서버 라우트·설정 화면 연결 | `work/RESULT-00.md` | 미배정 |
| 01 | 스킬 선택·적용의 모델 경로 연결 | `work/RESULT-01.md` | 미배정 |
| 04 | 이미지 읽기 도구의 모델 입력 경로 연결 | `work/RESULT-04.md` | 미배정 |
| 07 | Linux 사용자 서비스의 실제 설치·재시작 검증 (외부 환경 필요) | `work/RESULT-07.md` | 미배정 |
| 08 | HTML 본문 추출 방식 결정·실제 네트워크 검증 (`INTEGRATION-002`) | `work/RESULT-08.md` | 미배정 |

## 통합 담당의 완료 절차
1. 사용자 통합 요청 뒤 각 worktree의 RESULT와 실제 branch·SHA·diff를 확인한다. 인계 파일만 보고 성공으로 단정하지 않는다.
2. 작업자가 편집을 끝냈는지 확인한다. 미커밋 작업은 승인 없이 수집·삭제하지 않는다.
3. 승인된 로컬 통합 범위에서 기능별 변경을 하나씩 합친다. 권장 순서: 05, 03, 09, 02, 07, 00, 01, 04, 08.
4. 공통 API·등록·화면·runner 연결을 완성한다. 구현 복제·권한 완화·가짜 성공으로 연결하지 않는다.
5. 입력이 유효한 통과 근거는 재사용하고 미실행·실패·통합 영향 검사를 수행한다. Rust와 웹 빌드·E2E는 기본 순차 실행한다.
6. 교차 경계: 배포 경로와 새 화면, 승인 대상과 새 도구, 이미지 모델 입력, 스킬 선택/적용 구분, 사용량 수치, 서비스 데이터 보존, 웹 조회 SSRF·취소.
7. 해당 TODO 전체 요구와 필수 검증이 충족되면 `TODO.md`를 반드시 `[x]`로 갱신하고 근거를 기존 형식에 맞춰 남긴다.
8. 부분 구현·미연결·실기기/플랫폼 미검증은 `[ ]`와 남은 조건을 유지한다. 이미 체크한 판단이 틀리면 다시 연다.
9. `work/INTEGRATE.md`의 보존·정리 조건을 확인해 종료된 작업의 worktree와 Paseo 워크스페이스를 제거하고 남은 일은 이월 작업 표로 옮긴다. 같은 흐름에서 활성 목표 수까지 다음 번호 작업을 준비한다. 진행 중인 작업은 수정하지 않는다.
10. 기능별 결과·정리 대상·새 워크스페이스와 blocker를 보고한다. 다음 번호 작업은 최신 검증 통합 기준에서 시작한다.

## 권한
준비 요청은 기능 세션 실행·stage·commit·merge·push·배포를 자동 승인하지 않는다.
START의 프롬프트를 사용자가 실제로 보내면 그 세션의 지정 작업과 관련 로컬 커밋을 승인하는 문구가 포함돼 있다.
START의 통합 프롬프트는 해당 배치의 로컬 통합·검증·관련 커밋, 조건을 충족한 완료 worktree/워크스페이스 정리, 다음 작업 준비를 승인한다.
원격 push·배포·서비스 중단·강제 삭제·브랜치 삭제·이력 재작성은 포함하지 않는다.
