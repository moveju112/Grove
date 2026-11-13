# Linux 사용자 서비스

기존 `grove install`이 검증·설치한 서버를 일반 사용자 `systemd --user`에 등록한다.
별도 updater, 다운로드, 바이너리 재빌드, root 설치는 하지 않는다.
브라우저/PWA는 서버를 소유하지 않으며 창을 닫아도 서비스 수명은 바뀌지 않는다.
직접 실행한 서버나 원격 서버는 이 도구가 중지하거나 서비스로 인수하지 않는다.

## 입력과 실행

기존 installer에 `--service systemd-user:grove.service`를 지정해 설치한
절대 경로의 `install.json`을 사용한다. `process` 설치의 설정을 이 도구가
자동 변경하지 않는다. 실행 중인 직접 서버의 전환은 소유자가 별도로 완료해야 한다.
검증한 current release의 바이너리 절대 경로와, 신뢰하는 검증 과정에서 얻은
SHA-256을 명시한다. 임의 파일의 hash를 계산한 것만으로 서명 검증을 대신할 수 없다.

```sh
python3 scripts/user_service.py register \
  --config /absolute/install/install.json --unit grove.service \
  --binary /absolute/install/releases/RELEASE_ID/grove --sha256 VERIFIED_SHA256
```

모든 관리 동작은 기본적으로 계획만 출력한다. 같은 입력에 `--apply`를 붙이면 적용한다.
등록은 unit을 쓰고 enable하지만 서버를 시작하지 않는다.

```sh
python3 scripts/user_service.py start --config /absolute/install/install.json --unit grove.service --apply
python3 scripts/user_service.py status --config /absolute/install/install.json --unit grove.service --apply
python3 scripts/user_service.py logs --config /absolute/install/install.json --unit grove.service --apply
python3 scripts/user_service.py stop --config /absolute/install/install.json --unit grove.service --apply
python3 scripts/user_service.py unregister --config /absolute/install/install.json --unit grove.service --apply
python3 scripts/user_service.py linger --config /absolute/install/install.json --unit grove.service
```

status는 systemd의 실행·enable 상태일 뿐 health·인증·웹 준비 성공이 아니다.
로그는 사용자 journal의 마지막 100줄이며 journal 보관은 OS 정책을 따른다.
로그아웃 후 계속 실행하려면 OS 정책에 따라 linger가 필요하다.
linger 명령은 확인·활성화 방법만 안내하고 `loginctl`을 호출하지 않는다.
systemd 사용자 manager, journalctl이 없거나 사용자 bus 연결에 실패하면 오류를 반환한다.
Windows와 root는 지원하지 않으며 systemd 없는 환경은 직접 foreground 실행을 사용한다.

## 수명·업데이트·복구

unit은 현재 Python 실행 파일과 이 checkout의 `scripts/user_service.py` 절대 경로를 사용한다.
이 스크립트와 `assets/systemd-user/grove.service.in`은 서비스를 사용하는 동안 유지해야 한다.
다른 설치 경로로 옮기기 전에는 기존 도구로 해제해야 하며 자동 이동·배포는 제공하지 않는다.
`run --apply`는 systemd용 내부 foreground 진입점이며 즉시 서버로 `exec`한다.

매 시작마다 기존 `current` 포인터에서 release를 선택하고 manifest의 grove hash를 확인한다.
`serve --listen … --data-dir …`와 해당 release의 `GROVE_WEB_DIR`을 사용한다.
따라서 기존 updater의 stop → current 교체 → start 및 rollback 흐름을 그대로 따른다.
서명·패키지·migration·snapshot·readiness는 계속 기존 updater의 책임이다.
이미 실행 중인 직접 서버를 죽이지 않으며 포트·데이터 잠금 충돌은 서버 시작 오류로 남는다.
CLI가 unit 시작에 성공해도 실제 서비스 준비 여부는 별도로 확인해야 한다.

등록·해제 중 명령이 실패하면 실패를 그대로 보고하고 재실행 가능한 상태를 남긴다.
다시 같은 명령을 실행하면 완료된 파일 단계를 재사용한다.
해제는 관리 중인 unit만 disable/stop하고 파일을 지운 뒤 daemon-reload한다.
설정·대화·자격증명·release·바이너리는 삭제하지 않는다.
다른 내용의 기존 unit, symlink/mask, 다른 경로에서 로드된 동명 unit은 거부한다.
수정한 unit은 자동으로 “복구”하거나 덮어쓰지 않으므로 소유자가 충돌을 해결해야 한다.
서비스별 drop-in과 사용자 manager 환경은 운영자가 관리하며 이 도구는 제거하지 않는다.

기본 unit 디렉터리는 `$XDG_CONFIG_HOME/systemd/user` 또는 `~/.config/systemd/user`다.
`--unit-dir`은 임시 시험 또는 실제 systemd 검색 경로에만 사용해야 한다.
모든 입력 경로는 절대 경로이고 현재 사용자 소유 대상이어야 하며 symlink·타인 쓰기 권한을 거부한다.
