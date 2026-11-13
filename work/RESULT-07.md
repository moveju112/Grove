# b01 / 07 — Linux 사용자 서비스 설치 도구

## 식별·상태

- worktree: `<세션 worktree 루트>/b01-07-linux-service`
- branch: `parallel/b01-linux-service`
- 공통 기준 SHA: `c186b31ab62734c9f91803cf7848b639ad9871fb`
- 실제 Git top-level·branch가 ENTRY 표의 07과 일치했고 시작 시 clean이었다.
- merge-base와 시작 HEAD 모두 공통 기준 SHA였다.
- 상태: 소유 범위 구현 종료, 제품 진입점 연결 및 실제 systemd 검증은 통합 대기.
- 독립 구현 blocker 없음. 세션 목록 조회는 런타임의 `cross-session control is unavailable in this runtime` 제한으로 불가능했다. 다른 세션에 메시지·슬롯·승인을 요청하지 않았다.

## 소유 변경

- `scripts/user_service.py`
- `scripts/test_user_service.py`
- `assets/systemd-user/grove.service.in`
- `assets/systemd-user/README.md`
- `work/RESULT-07.md`

`TODO.md`, 공통 Rust/웹/빌드 파일, dependency/lockfile은 변경하지 않았다.
원본 프로젝트 편집, push, merge, 배포, 실제 서비스 조작은 하지 않았다.

## 제공 동작·계약

CLI:

```sh
python3 scripts/user_service.py register \
  --config /absolute/install/install.json --unit grove.service \
  --binary /absolute/install/releases/RELEASE_ID/grove --sha256 VERIFIED_SHA256
```

- `register`, `unregister`, `start`, `stop`, `status`, `logs`는 기본 계획 출력이며 `--apply`가 있어야 명령을 실행한다.
- register는 기존 updater가 설치한 current release와 명시 binary/hash를 대조하고 unit 등록·enable만 한다. 시작은 별도 start 작업이다.
- `--config`는 절대 경로의 `install.json`이고 `service` 값은 정확히 `systemd-user:<unit>`이어야 한다. process 방식이나 다른 unit은 자동 전환하지 않는다.
- unit 이름은 `grove.service` 또는 `grove-소문자숫자[-소문자숫자].service` 형식으로 제한한다. 절대 경로, 소유권, 쓰기 권한, symlink, release ID, SHA-256, IP listen 주소를 검증한다.
- 서명 검증·패키지 설치를 복제하지 않는다. 입력 SHA-256은 호출자가 신뢰하는 기존 검증 과정에서 얻어야 하며 hash만으로 출처를 인증하지 않는다.
- 등록 파일은 완성 후 배타적 게시하며, 잠금으로 이 도구의 동시 수정을 막는다. 동일 입력 재실행은 기존 소유 파일을 재사용한다.
- 기존 unit 내용이 생성 결과와 다르거나 같은 이름의 로드된 unit이 다른 경로에 있으면 거부한다. daemon-reload 뒤에도 정확한 대상 FragmentPath로 로드되었는지 확인한 다음 enable한다.
- unregister는 소유 unit만 disable/stop하고 unit 파일을 지운다. disable 실패 시 파일을 보존하며, 파일 삭제 후 reload 실패도 재실행으로 수렴한다.
- data_dir·대화·설정·자격증명·release·바이너리는 삭제하지 않는다. 사용자 drop-in도 수정하지 않는다.
- status는 systemd 실행 상태와 enable 상태를 출력한다. 서버 health·인증·웹 준비 성공을 뜻하지 않는다.
- logs는 사용자 journal 마지막 100줄을 조회한다. 보관 정책은 systemd/journald가 소유한다.
- linger는 확인·활성화 명령을 안내할 뿐 `loginctl`을 호출하지 않는다.
- systemd 미지원, 사용자 bus 실패, 명령 실패·timeout을 성공으로 숨기지 않는다. Linux 일반 사용자 실행만 지원하고 root는 거부한다.

Python 진입점:

- `UserService(config, unit, unit_dir, runner=run_command)`: runner는 argv 목록을 받고 `subprocess.CompletedProcess` 호환 결과를 반환한다.
- `UserService.plan(action, binary=None, sha256=None)`: 검증 후 계획 dict를 반환한다. 명령·파일 쓰기 없음.
- `UserService.execute(action, binary=None, sha256=None)`: 명시 적용 후 결과 dict를 반환한다. `applied`, `commands`, `output`, `note` 등을 포함한다.
- `installed_server(config, unit, binary=None, sha256=None)`: 기존 current release의 바이너리/manifest hash를 대조하고 `(serve argv, web 경로)`를 반환한다.
- `launch(config, unit)`: foreground 서버로 `os.execve`한다. CLI에서는 내부 `run --apply`로만 호출한다.
- 검증·하위 명령 실패는 `ServiceError`, 파일/잠금 실패는 `OSError`이며 CLI는 오류 시 1을 반환한다. 하위 명령의 실패 출력은 오류 메시지에 복제하지 않는다.

## 기존 설치·업데이트와 연결

확인한 근거는 `src/update.rs`의 `InstallCfg`, `install`, `start_service`, `stop_service`, `readiness`와 `migration/RULEBOOK.md` §16이다.
기존 updater의 `systemd-user:<unit>` start/stop 계약을 그대로 사용한다.

생성 unit은 현재 Python과 이 checkout의 helper 절대 경로를 가리킨다.
내부 run은 시작마다 기존 `current` 포인터를 읽고 선택된 release를 hash 검증한 뒤
`grove serve --listen … --data-dir …`로 exec하며 해당 release의 `GROVE_WEB_DIR`을 설정한다.
새 updater나 포인터 교체·migration·snapshot·rollback 구현은 추가하지 않았다.
기존 updater가 current를 전환하고 systemctl start하면 다음 release를 선택하며 rollback도 같은 방식이다.

직접 실행한 서버를 탐지해 kill하거나 인수하지 않는다.
동일 포트·데이터 잠금 충돌은 서버 시작 실패로 남기며, systemctl 성공과 실제 서버 준비를 구분한다.

통합 담당의 남은 연결:

1. 제품 설치/도움말 진입점에서 이 도구를 노출하고 `--service systemd-user:<unit>`로 설치한 뒤 register 계획·적용·start를 분리해 안내한다.
2. 배포할 경우 helper와 template의 안정된 수명/절대 경로를 정한다. 현재는 checkout을 유지해야 하며 자동 복사·배포를 제공하지 않는다.
3. 실제 일반 사용자 systemd 환경에서 enable·start·status·journal·stop·disable 및 로그아웃/재로그인·linger 정책을 검증한다.
4. 기존 updater와 함께 stop → pointer 전환 → start, readiness 실패 및 rollback을 실제 검증한다.
5. 준비 상태·인증·웹/브라우저 흐름을 별도로 확인한 뒤 TODO 충족 여부를 판단한다.

## 실행한 검증

명령:

```sh
python3 -m unittest scripts/test_user_service.py
```

최종 입력은 이 커밋의 helper/template/시험이며 결과는 **30 tests, OK**, exit 0이었다.
중간 동일 명령의 23개·28개 시험도 통과했으며 최종 30개 결과가 이를 대체한다.

임시 설치/데이터/units 디렉터리와 주입 runner만 사용했다.
실제 서버 바이너리, systemctl, journalctl, loginctl을 실행하지 않았다.
검증 범위:

- 기본 계획의 무명령·무쓰기, 명시 start/stop/status/logs
- 반복 등록/해제, 등록의 비시작, 부분 실패 재실행
- 원자적 파일 게시 실패 및 disable/reload/enable 실패 복구
- 다른 내용·다른 로드 경로·잘못된 검색 경로의 unit 보호
- symlink·타인 쓰기 권한·경로/이름/hash/listen/config 오류
- user bus/명령 부재·timeout·비정상 exit의 오류 처리
- 데이터·설정·자격증명·release 보존
- current 변경/rollback에 따른 launcher argv·web 경로 선택
- 특수 경로의 systemd 인수 escape와 셸 미사용
- root/비Linux 실행 거부, linger 무호출 안내

미실행:

- 실제 systemd·linger·사용자 journal 및 로그아웃 이후 실행: 번호 문서에서 현재 호스트 조작 금지.
- 실제 바이너리/기존 updater 통합·health·인증·웹·E2E: 독립 단계의 자원/부작용 제한에 따라 통합 담당에 남김.
- Rust 컴파일·웹 빌드/typecheck·release·패키징: 소유 범위 밖이고 공통 계약에 따라 통합 단계로 남김.

## TODO별 판단

| ID | 제공 근거 | 남은 요구 |
|---|---|---|
| PC-002 | 브라우저/PWA와 서비스 수명·소유권 분리를 README와 CLI 동작에 명시 | 제품 사용자 진입점 연결 및 실제 브라우저 종료 후 유지 검증 |
| PC-004 | process/다른 서비스 거부, 원격·직접 실행 서버를 인수/중지하지 않음, 명시 대상만 조작 | 전체 로컬/원격 연결 UI 및 제품 설치 흐름의 책임 구분 검증 |
| PC-013 | systemd user 등록·해제·상태·로그·linger 안내 구현, 주입 runner 회귀 30개 통과 | 실제 systemd/로그아웃 이후 실행 및 배포 경로 검증 |
| PC-019 | 해제 반복·부분 실패 시험에서 대화 fixture·자격증명 fixture·설정·바이너리 보존 확인 | 전체 제품 제거 흐름과 실제 서비스 해제에서 보존 검증 |

전체 TODO 완료로 판단하지 않았으며 `TODO.md` 체크는 변경하지 않았다.
위 미연결·플랫폼 미검증 조건을 완료 후보로 숨기지 않고 통합 담당에 넘긴다.
