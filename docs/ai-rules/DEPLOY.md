# 빌드·통합·배포

소스 편집 요청을 commit·push·배포·서비스 중단 승인으로 확대하지 않는다.

## 요청 문구와 배포 범위

- **MUST** "컴파일만", "푸시만", "로컬만", "배포 금지" 같은 명시적 제한을 아래 일괄 흐름보다 우선한다. 컴파일만이면 컴파일에서, 푸시만이면 commit·push에서 멈춘다. 로컬 반영만이면 `--skip-pages`로 공개 Pages 배포를 생략하고, 배포 금지이면 로컬 서버·CLI 업데이트와 Pages 배포를 모두 하지 않는다.
- **MUST** 명시적 제한 없이 사용자가 "빌드", "배포", "반영"처럼 말하면 컴파일만 하고 멈추지 않는다. 아래 전체 과정을 한 번에 끝까지 진행한다.
  1. 현재 작업 폴더의 변경(미커밋 포함)으로 검증·컴파일·패키징
  2. 로컬 서버 업데이트와 독립 CLI 설치
  3. Cloudflare Pages production 배포
  - `python3 scripts/deploy_local.py`가 2~3을 수행한다.
- **MUST** 명시적 제한 없이 사용자가 "푸시"라고 말하면 변경을 commit·push하고, 위의 빌드·로컬 반영·Pages 배포까지 모두 진행한다.
- 이 문구들이 곧 해당 범위의 승인이다. 각 단계마다 다시 묻지 않는다. 릴레이 Worker 배포, 강제 push·이력 재작성, 실행 중 작업을 중단하는 `--force` 적용은 이 범위에 포함하지 않으며 따로 요청받았을 때만 한다.

## 업데이트와 복구

- **MUST** 실사용 업데이트는 패키지 검증·서명된 manifest·기존 updater 경로를 사용한다.
  - why: 설치를 직접 덮어쓰면 검증 실패 때 이전 서비스로 복구할 수 없다.
  - ✅ package → signed manifest → `grove update apply`. `evidence: scripts/deploy_local.py`.
- **MUST** 실행 중 작업으로 적용이 `deferred`되면 성공 배포로 보고하지 않는다.
  - why: 패키지 준비와 실제 전환은 다르다.
  - ✅ readiness·적용 상태와 운영 release를 확인한다. `evidence: src/update.rs:754`, `evidence: scripts/deploy_local.py:165`.
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
