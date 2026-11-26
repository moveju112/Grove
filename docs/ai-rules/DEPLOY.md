# 빌드·통합·배포

소스 편집 요청을 commit·push·배포·서비스 중단 승인으로 확대하지 않는다.

## 요청 문구와 배포 범위

- **MUST** "컴파일만", "푸시만", "로컬만", "배포 금지" 같은 명시적 제한을 아래 일괄 흐름보다 우선한다. 컴파일만이면 컴파일에서, 푸시만이면 승인 범위를 커밋한 뒤 `GROVE_PUSH_ONLY=1 git push`로 릴리즈 훅을 생략한다. 로컬 반영만이면 `--skip-pages`로 공개 Pages 배포를 생략하고, 배포 금지이면 로컬 서버·CLI 업데이트와 Pages 배포를 모두 하지 않는다.
- **MUST** 명시적 제한 없이 사용자가 "빌드", "배포", "반영"처럼 말하면 컴파일만 하고 멈추지 않는다. 아래 전체 과정을 한 번에 끝까지 진행한다.
  1. 현재 작업 폴더의 변경(미커밋 포함)으로 검증·컴파일·패키징
  2. 로컬 서버 업데이트와 독립 CLI 설치
  3. Cloudflare Pages production 배포
  - `python3 scripts/deploy_local.py`가 2~3을 수행한다.
- **MUST** 제한 없는 "푸시"는 요청한 개발 변경을 먼저 커밋하고 `python3 scripts/push_release.py`를 실행한다. 최신 공식 태그에서 patch를 한 번 올리고(예: `v0.1.0`, `v0.1.1`, `v0.1.2`), 고정한 커밋으로 빌드·실행 검증한 뒤 main과 태그, GitHub Releases, 로컬 서버·CLI·Pages에 반영한다. 재시도는 기존 태그·패키지를 확인한다. 실제 게시와 로컬 적용 상태를 각각 확인한다.
- 평소에는 변경한 기능에 해당하는 테스트를 로컬에서 실행한다. PR·main의 GitHub Actions는 웹·브라우저 검사를 맡는다. 공개 릴리즈는 고정한 커밋에서 로컬 Rust 전체 검사(`cargo nextest run --locked --no-fail-fast`, nextest가 없으면 `cargo test`)가 통과해야 태그를 푸시하고 게시할 수 있다. nextest는 시험마다 별도 프로세스로 실행하므로 서로 직렬화해야 하는 시험은 프로세스 안 잠금이 아니라 `.config/nextest.toml`의 test-group으로 묶는다. Rust 시험은 임시 데이터를 메모리 파일 시스템(`/dev/shm`)에 두고(`build.rust_test_tmp`) 의존성만 최적화해(`profile.test.package."*"`) 실행 시간을 줄인다. nextest는 doctest를 실행하지 않으며, doctest를 추가하면 릴리즈 검사에 `cargo test --doc`을 함께 넣는다. 재시도는 같은 커밋의 검사 통과 기록과 패키지를 재사용한다.
- 로컬 개발 머신에서는 `python3 scripts/push_release.py --install-hook`으로 현재 checkout에 Git 훅을 연결하면 일반 `git push origin main`도 같은 절차를 이어간다. 새 clone마다 한 번 연결한다. fetch·다른 브랜치 푸시는 릴리즈 대상이 아니다. 최초 main 전송 뒤 후속 작업이 실패하면 `python3 scripts/push_release.py`로 재개한다.
- 공식 업데이트 소스는 GitHub Releases의 서명된 `release.json`이다. stable은 latest, beta는 공개 prerelease를 사용한다. 배포 호스트에는 기존 릴리즈 서명 키와 GitHub 쓰기 권한이 필요하다. 설치 파일과 SHA256SUMS, 패키지 manifest, SBOM, 서명 manifest를 게시하고 같은 압축본을 로컬과 Pages에 사용한다. push 경로는 유휴 상태에서 즉시 적용하고 다른 작업이 있으면 검증한 패키지를 기존 독립 배포 unit에서 유휴 상태까지 기다린다.
- 이 문구들이 곧 해당 범위의 승인이다. 각 단계마다 다시 묻지 않는다. 릴레이 Worker 배포, 강제 push·이력 재작성, 실행 중 작업을 중단하는 `--force` 적용은 이 범위에 포함하지 않으며 따로 요청받았을 때만 한다.

## 업데이트와 복구

- **MUST** 실사용 업데이트는 패키지 검증·서명된 manifest·기존 updater 경로를 사용한다.
  - why: 설치를 직접 덮어쓰면 검증 실패 때 이전 서비스로 복구할 수 없다.
  - ✅ package → signed manifest → `grove update apply`. `evidence: scripts/deploy_local.py`.
- **MUST** 실행 중 작업으로 적용이 `deferred`되면 성공 배포로 보고하지 않는다.
  - why: 패키지 준비와 실제 전환은 다르다.
  - ✅ readiness·적용 상태와 운영 release를 확인한다. `evidence: src/update.rs:754`, `evidence: scripts/deploy_local.py:165`.
- **MUST** 실행 중 작업이 있으면 설치된 `serve` 데몬의 자손인지와 실행 중 턴의 일치를 함께 확인한다. Grove 셸은 데몬 직속 셸의 실행 표식과 PID를 `tasks`에 대조한 뒤 `tool_calls`로 턴을 찾고, 외부 Codex/Claude CLI는 native 대화 ID와 `cli_sessions`로 턴을 찾는다. 프로세스 이름·개수만으로 판단하지 않고 보조 `continuation-mcp`는 데몬 수에 넣지 않는다.
  - 호출 턴은 빌드 전에 식별한다. 빌드 뒤 그 턴이 아직 실행 중이면 그 턴과 호출 셸 작업만, 빌드 중 턴이 완료됐으면 호출 셸 작업만 남았을 때 인계한다. 빌드 중 호출 턴이 취소·실패·중단되면 적용하지 않는다. 그래서 Grove 셸 background로 실행하고 턴을 끝내도 보류되지 않는다.
  - 현재 턴과 그 턴에서 배포를 호출한 셸 작업(해당하는 경우)만 실행 중이면 추가 강제 종료 승인 없이 `scripts/deploy_local.py`의 독립 systemd user unit에 검증된 패키지를 인계한다. 현재 응답이 저장되어 턴이 `completed`가 되고, 전체 readiness가 유휴 상태인 것을 확인한 뒤 기존 서명·updater·CLI·Pages 경로로 이어간다. 인계 뒤 소스를 다시 빌드하거나 `--force`로 자기 턴을 제외하지 않는다.
  - 다른 작업이 있거나 현재 세션을 확실히 식별할 수 없으면 기존 보류를 유지한다. native 대화 매핑이 아직 없는 첫 호출도 추측하지 않는다. 대화 취소·실패·중단, 30분 내 유휴 상태 미도달, 대기 중 운영 release 변경·패키지 hash 불일치는 성공으로 처리하지 않는다.
  - 인계는 배포 완료가 아니다. `python3 scripts/deploy_local.py --status`의 `deployment_jobs`와 해당 디렉터리의 `state.json`·`deployment.log`로 실제 서버 전환·공개 웹 자산 확인 결과를 보고한다.
  - Grove 턴에서 배포는 포그라운드나 Grove 셸(`background`+`follow_up`)로만 실행한다. Claude Code CLI 내장 백그라운드는 Grove가 `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`로 끈다. 턴이 끝나면 추적·보고되지 않기 때문이다.
  - ✅ `deployment_caller`·`handoff_state`·`queue_deployment`·`resume_deployment`, `scripts/test_deploy_cli.py`.
- **MUST** 실패 복구에서 새 DB 쓰기를 과거 snapshot으로 덮어쓰지 않는다.
  - why: 이전 release 복구가 데이터 유실을 일으켜서는 안 된다.
  - ✅ `Recovery` 판정과 `recovery_never_overwrites_new_writes` 시험. `evidence: src/update.rs:884`, `evidence: src/update.rs:1170`.

| 목적 | 명령 |
|---|---|
| 패키지 준비·자체 실행 검증 | `python3 scripts/build.py package --targets linux-x64` |
| 실사용 상태만 조회 | `python3 scripts/deploy_local.py --status` |
| 승인된 배포(패키지 → 로컬 서버·CLI → 공개 Pages) | `python3 scripts/deploy_local.py` |
| 로컬 반영만(공개 Pages 미반영) | `python3 scripts/deploy_local.py --skip-pages` |

고정 포트·unit·경로는 `scripts/deploy_local.py`를 정본으로 삼는다.

## Linux Debian/Ubuntu 패키징

- **MUST** `.tar.gz` 배포와 자체 updater는 유지하고 `package --deb`로 `.deb`를 추가 생성한다. 패키징·빌드 준비 요청만으로 실사용 설치·서비스 변경·Pages 배포를 수행하지 않는다.
- **MUST** `.deb`의 `/usr/bin/grove`, `/usr/lib/grove`와 배포된 사용자 unit은 apt/dpkg만 관리한다. 자체 updater는 별도 사용자 설치 경로에서만 쓰며 `/usr`를 `--install` 대상으로 사용하지 않는다.
- **MUST** `.deb`는 root 서버·시스템 서비스·계정·linger를 만들거나 사용자 서비스를 자동 시작·중단·재시작하지 않는다. 공용 `grove.service` 템플릿으로 사용자 unit을 제공하고 사용자가 명시적으로 선택한다. 기존 사용자 unit·CLI·데이터를 덮어쓰거나 자동 이전하지 않는다.
- **MUST** 사용자 데이터는 기존 `GROVE_DATA_DIR`/XDG 기본 경로에 두며 remove·purge에서도 DB·토큰·프로젝트를 보존한다. maintainer script로 데이터 migration·네트워크 다운로드를 하지 않는다.
- **MUST** ELF runtime 의존성은 대상 머신의 `dpkg-shlibdeps`로 계산하고 누락 정보를 무시하거나 최소 glibc 버전을 추측하지 않는다. x64는 amd64, ARM64는 arm64로 각각 해당 아키텍처 Linux에서 native 빌드한다. `.tar.gz`의 cross 빌드와 달리 `.deb` cross 빌드는 현재 지원하지 않는다.
- **MUST** 패키징 호스트에는 기존 Rust·Node 빌드 환경과 `dpkg`, `dpkg-dev`, `binutils`가 필요하다. 의존성을 자동 설치하거나 업그레이드하지 않는다. 생성 호스트보다 오래된 배포판 호환성은 `Depends`로 제한하며 별도 검증 없이 주장하지 않는다.
- **MUST** Cargo prerelease는 Debian `~`로 변환하고 packaging revision을 붙인다(예: `0.1.0-beta.1` → `0.1.0~beta.1-1`). 같은 upstream의 패키징 변경은 `--deb-revision`을 올린다.
- **MUST** `.deb` metadata·파일 권한·root 소유권·추출 payload를 확인하고 격리된 데이터로 추출된 CLI·웹·health를 검사한다. 이 검사는 실제 apt 설치·업그레이드·제거 검증을 대신하지 않는다.
- **MUST** 빌드 중 입력 소스 해시가 바뀌면 성공 receipt를 발행하지 않는다. 다른 작업이 편집 중인 checkout은 고유한 소스 복사본에서 패키징하며, 산출물의 source hash는 해당 복사본을 기준으로 한다.
- **MUST** apt 업그레이드·제거 전에는 실행 중 작업을 마치고 사용 중인 프로세스를 명시적으로 멈춘다. 업그레이드 전 데이터 백업과 schema 호환성을 확인하며, schema 변경 후 `apt` downgrade를 안전한 rollback으로 간주하지 않는다. SHA256SUMS는 무결성 확인일 뿐 배포자 인증이 아니며 APT 저장소·서명 배포는 별도 범위다.

| 목적 | 명령 |
|---|---|
| 현재 Linux의 `.tar.gz`와 `.deb` 준비 | `python3 scripts/build.py package --deb` |
| x64 패키지 준비(amd64 Linux에서) | `python3 scripts/build.py package --targets linux-x64 --deb` |
| ARM64 패키지 준비(arm64 Linux에서) | `python3 scripts/build.py package --targets linux-arm64 --deb` |
| 실행 없는 빌드 계획 | `python3 scripts/build.py package --deb --dry-run` |
| 패키징 회귀 검사 | `python3 -m unittest scripts.test_debian scripts.test_build` |

산출물은 `dist/release/grove-<version>-<target>/`에 압축본·`.deb`·manifest·SBOM·SHA256SUMS로 모은다.
설치·사용자 서비스 선택·업데이트·제거 절차는 패키지의 `assets/debian/README.Debian`을 따른다.

## Rust 빌드 캐시

일반 개발·테스트는 현재 checkout에서 실행한다. 테스트는 줄 번호 디버그 정보만 남기고 증분 컴파일을 끈다. 릴리즈는 푸시 잠금 아래 `dist/github-releases/source`에 매번 해당 커밋을 새로 추출한다. Cargo의 소스 경로와 remap 플래그가 일정해 이전 릴리즈의 의존성을 재사용한다. 최종 바이너리는 현재 소스의 `target`에서 가져온다. 호스트가 외부 중간 캐시를 지정하지 않은 경우 `dist/github-releases/cargo-build`가 릴리즈 전용 캐시다. 외부 중간 캐시를 쓰면 그 경로에 `.prune-last`를 두어 호스트 유휴 정리가 릴리즈 캐시를 가장 나중에 회수하게 한다. 서명·검증은 만든 패키지의 release 실행 파일로 하며, 이미 게시된 릴리즈를 내려받아 재개할 때만 현재 checkout의 debug 실행 파일로 먼저 검증한다. 통합 시험을 실행 파일 하나로 묶어 시험 컴파일의 링크를 한 번으로 줄인다.

일회성 cold build는 `CARGO_TARGET_DIR`와 `CARGO_BUILD_BUILD_DIR`를 함께 지정한다. 관리 호스트의 기본 캐시에는 전역 유휴 정리 기준(48 GiB 초과 시 32 GiB 목표)이 적용된다. `cargo metadata --offline --no-deps --format-version 1`로 최종·중간 경로를 확인할 수 있다.
