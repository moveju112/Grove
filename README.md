# Grove

Grove는 내 개발 머신에서 실행하는 AI 코딩 작업공간입니다. 데스크톱 브라우저와 모바일 PWA에서 같은 프로젝트의 대화를 이어가고, 에이전트가 바꾼 파일과 Git diff를 확인하거나 터미널을 열 수 있습니다. Rust 서버가 작업을 실행하고 대화와 실행 기록을 SQLite에 저장합니다.

## 릴리즈 파일로 시작하기

[GitHub Releases](https://github.com/moveju112/Grove/releases/latest)에서 Linux x64용 패키지를 받으세요. 같은 릴리즈의 `SHA256SUMS`를 함께 받으면 다운로드한 폴더에서 `sha256sum --ignore-missing -c SHA256SUMS`로 파일을 확인할 수 있습니다.

| 파일 | 설치와 실행 |
| --- | --- |
| `grove-<버전>-linux-x64.tar.gz` | 압축을 푼 폴더에서 `./grove pairing set-password`를 실행한 뒤 `./grove serve`로 시작합니다. |
| `grove_<버전>-1_amd64.deb` | Debian·Ubuntu에서 다운로드한 파일을 `sudo apt install ./파일명.deb`로 설치한 뒤 `/usr/bin/grove pairing set-password`와 `/usr/bin/grove serve`를 차례로 실행합니다. |

Claude Code의 구독 한도를 다른 로컬 앱에서 읽으려면 [사용량 파일 경로와 형식](docs/claude-usage.md)을 참고하세요.

## 소스에서 빌드하기

Linux에서 소스를 빌드하는 예시입니다. Rust 1.93.0, Node.js 24, npm, Git이 필요합니다. Codex나 Claude Code를 사용하려면 Grove를 실행할 사용자 계정에서 해당 CLI를 설치하고 로그인하세요.

저장소 루트에서 서버와 웹앱을 빌드한 뒤, 첫 기기를 등록할 때 쓸 링크 발급 비밀번호를 설정합니다.

```sh
cargo build --locked
npm --prefix web ci
npm --prefix web run build
./target/debug/grove pairing set-password
GROVE_WEB_DIR="$PWD/web/build/client" ./target/debug/grove serve
```

서버의 기본 주소는 `http://127.0.0.1:7740`입니다. 기본 데이터 경로는 Linux에서 `$XDG_DATA_HOME/grove` 또는 `~/.local/share/grove`입니다. 경로를 바꾸려면 서버와 페어링 명령 모두에 같은 `GROVE_DATA_DIR`를 지정하세요.

## 첫 브라우저 연결하기

아래 예시는 압축을 푼 폴더에서 실행합니다. Debian 패키지로 설치했다면 `./grove` 대신 `/usr/bin/grove`를, 소스에서 빌드했다면 저장소 루트에서 `./target/debug/grove`를 사용하세요.

1. 서버를 켜 둔 채 같은 머신의 다른 터미널에서 `./grove pairing create "내 브라우저"`를 실행합니다. 발급 비밀번호를 입력하고 이 링크에 쓸 별도 비밀번호를 정합니다. 두 비밀번호는 각각 10자 이상이어야 합니다.
2. 출력된 링크를 같은 머신의 브라우저에서 열고 링크 비밀번호를 입력해 등록을 요청합니다.
3. 터미널에서 `./grove pairing list`를 실행합니다. 대기 요청의 확인 코드가 브라우저에 표시된 코드와 같으면 아래 명령의 자리표시자를 해당 값으로 바꿔 승인합니다.

```sh
./grove pairing approve <링크-ID> <요청-ID> <확인-코드>
```

승인된 브라우저에서 프로젝트 폴더를 열고 새 대화를 시작하세요. 다른 기기를 연결할 때는 페어링 링크와 링크 비밀번호를 따로 전달하세요. 승인된 기기는 프로젝트 파일에 접근하고 명령을 실행할 수 있습니다.

## 업데이트

공식 압축본·Debian 패키지에서 `grove serve`를 실행하거나 자체 updater로 설치한 데몬을 시작하면 자동 업데이트가 항상 켜집니다. 시작 30초 뒤부터 30분마다 현재 채널의 서명된 릴리즈를 확인합니다. 기본 범위는 같은 메이저 버전의 마이너·패치입니다. 작업 중이면 1분 뒤 다시 시도하고, 유휴 상태에서 데이터를 백업하고 새 버전으로 재시작합니다.

압축본과 Debian 패키지는 사용자별 실행 사본을 갱신합니다. Linux에서 이 사본은 `$XDG_STATE_HOME/grove/daemon-runtimes`(기본 `~/.local/state/grove/daemon-runtimes`)에 있습니다. Debian 패키지 자체는 apt로 관리합니다. 소스 빌드는 직접 다시 빌드해야 합니다. 자동 업데이트 기능이 없는 이전 데몬은 이 기능이 포함된 릴리즈로 한 번 업데이트해야 합니다.

우측 상단의 초록불에서 데몬과 웹의 공식 릴리즈를 확인할 수 있습니다. 웹은 새 릴리즈가 현재 접속 주소에 배포되면 자동으로 갱신됩니다. 작성 중인 입력이 있으면 보류하고, 입력을 마친 뒤 다음 자동 확인에서 적용합니다.

## 개발과 운영

사용자 계정의 기본 rustup 환경으로 아래 검사 스크립트를 실행할 때는 먼저 `export CARGO_HOME="${CARGO_HOME:-$HOME/.cargo}" RUSTUP_HOME="${RUSTUP_HOME:-$HOME/.rustup}"`을 실행합니다.

| 목적 | 명령 또는 문서 |
| --- | --- |
| Rust 페어링 테스트 | `python3 scripts/build.py test --rust pairing` |
| 웹 타입 검사와 페어링 테스트 | `python3 scripts/build.py test --typecheck --vitest app/state/pairing.test.ts` |
| 로컬 개발 머신에서 main 푸시·패치 릴리즈·즉시 반영 | 승인된 변경을 커밋한 뒤 `python3 scripts/push_release.py`. 일반 `git push`에도 연결하려면 이 checkout에서 `python3 scripts/push_release.py --install-hook`을 한 번 실행합니다. |
| 서버·웹앱 구조와 데이터 흐름 | [아키텍처](docs/ai-rules/ARCHITECTURE.md) |
| 배포 패키지 생성과 업데이트 | [빌드·배포 안내](docs/ai-rules/DEPLOY.md) |
| Debian·Ubuntu 설치와 사용자 서비스 | [Debian 패키지 안내](assets/debian/README.Debian) |
