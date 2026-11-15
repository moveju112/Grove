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
