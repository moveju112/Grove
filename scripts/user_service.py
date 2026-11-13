#!/usr/bin/env python3
"""Linux 사용자 서비스 관리. 기본은 계획이며 --apply에서만 실행한다."""

import argparse
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile


TEMPLATE = Path(__file__).resolve().parent.parent / "assets/systemd-user/grove.service.in"
UNIT_NAME = re.compile(r"grove(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?\.service\Z")
RELEASE_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}\Z")
SHA256 = re.compile(r"[0-9a-f]{64}\Z")


class ServiceError(Exception):
    """사용자 조치가 필요한 검증·명령 실패."""


def absolute_path(value):
    text = os.fspath(value)
    path = Path(text)
    if (not path.is_absolute() or ".." in path.parts
            or any(ord(c) < 32 or ord(c) == 127 for c in text)):
        raise ServiceError("경로는 제어 문자와 .. 없는 절대 경로여야 합니다")
    return path


def safe_path(path, kind=None, missing=False):
    """다른 사용자나 symlink가 교체할 수 있는 경로는 관리하지 않는다."""
    path = absolute_path(path)
    for part in [*reversed(path.parents), path]:
        try:
            info = part.lstat()
        except FileNotFoundError:
            if missing:
                continue
            raise ServiceError(f"필수 경로가 없습니다: {part}") from None
        if stat.S_ISLNK(info.st_mode):
            raise ServiceError(f"symlink 경로는 허용하지 않습니다: {part}")
        sticky_root = (stat.S_ISDIR(info.st_mode) and info.st_uid == 0
                       and info.st_mode & stat.S_ISVTX)
        if info.st_uid not in (0, os.geteuid()) or (info.st_mode & 0o022 and not sticky_root):
            raise ServiceError(f"안전하지 않은 경로 소유권/권한: {part}")
        if part != path and not stat.S_ISDIR(info.st_mode):
            raise ServiceError(f"상위 경로가 디렉터리가 아닙니다: {part}")
    if path.exists():
        info = path.stat()
        if info.st_uid != os.geteuid():
            raise ServiceError(f"대상은 현재 사용자 소유여야 합니다: {path}")
        if kind == "file" and not stat.S_ISREG(info.st_mode):
            raise ServiceError(f"일반 파일이 아닙니다: {path}")
        if kind == "dir" and not stat.S_ISDIR(info.st_mode):
            raise ServiceError(f"디렉터리가 아닙니다: {path}")
    return path


def read_json(path):
    safe_path(path, "file")
    try:
        result = json.loads(path.read_text())
    except (ValueError, UnicodeError):
        raise ServiceError(f"JSON 형식 오류: {path}") from None
    if not isinstance(result, dict):
        raise ServiceError(f"JSON 객체가 필요합니다: {path}")
    return result


def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def installed_server(config, unit, binary=None, sha256=None):
    """기존 updater가 설치한 release를 재사용한다. 설치·갱신은 수행하지 않는다."""
    cfg = read_json(config)
    if cfg.get("service") != f"systemd-user:{unit}":
        raise ServiceError("install.json service가 명시한 systemd-user 대상과 다릅니다")
    data = cfg.get("data_dir")
    listen = cfg.get("listen")
    if not isinstance(data, str) or not isinstance(listen, str):
        raise ServiceError("install.json에 data_dir와 listen 문자열이 필요합니다")
    data = safe_path(data, "dir", missing=True)
    try:
        host, port = listen.rsplit(":", 1)
        bracketed = host.startswith("[") and host.endswith("]")
        address = ipaddress.ip_address(host[1:-1] if bracketed else host)
        if not port.isascii() or not port.isdigit() or not 1 <= int(port) <= 65535:
            raise ValueError()
        # Rust SocketAddr와 동일하게 IPv6에는 대괄호가 필요하다.
        if (address.version == 6) != bracketed:
            raise ValueError()
    except ValueError:
        raise ServiceError("listen은 IP:포트 또는 [IPv6]:포트여야 합니다") from None
    pointer = safe_path(config.parent / "current", "file").read_text().strip()
    if not RELEASE_ID.fullmatch(pointer) or ".." in pointer:
        raise ServiceError("current release ID가 올바르지 않습니다")
    release = safe_path(config.parent / "releases" / pointer, "dir")
    manifest = read_json(release / "manifest.json")
    files = manifest.get("files")
    if not isinstance(files, list) or any(not isinstance(f, dict) for f in files):
        raise ServiceError("release manifest files 형식 오류")
    entries = [f for f in files if f.get("path") == "grove"]
    expected = entries[0].get("sha256") if len(entries) == 1 else None
    if not isinstance(expected, str) or not SHA256.fullmatch(expected):
        raise ServiceError("manifest에 유일한 grove SHA-256이 필요합니다")
    server = safe_path(release / "grove", "file")
    if not os.access(server, os.X_OK):
        raise ServiceError("grove 바이너리에 실행 권한이 없습니다")
    actual = digest(server)
    if actual != expected:
        raise ServiceError("설치 바이너리와 manifest의 SHA-256이 다릅니다")
    if binary is not None:
        if absolute_path(binary) != server:
            raise ServiceError("명시한 바이너리가 current release의 grove가 아닙니다")
        if not isinstance(sha256, str) or not SHA256.fullmatch(sha256) or sha256 != actual:
            raise ServiceError("명시한 검증 SHA-256이 바이너리와 다릅니다")
    web = safe_path(release / "web", "dir")
    return [str(server), "serve", "--listen", listen, "--data-dir", str(data)], web


def systemd_arg(value):
    # systemd ExecStart 문법이며 셸 명령이 아니다. specifier와 환경 확장을 막는다.
    return '"' + str(value).replace("\\", "\\\\").replace('"', '\\"').replace(
        "%", "%%").replace("$", "$$") + '"'


def run_command(argv):
    return subprocess.run(argv, capture_output=True, text=True, timeout=90, check=False)


def require_user():
    if sys.platform != "linux" or os.geteuid() == 0:
        raise ServiceError("Linux 일반 사용자의 systemd --user만 지원합니다(root 제외)")


class UserService:
    def __init__(self, config, unit, unit_dir, runner=run_command):
        if not UNIT_NAME.fullmatch(unit) or len(unit) > 100:
            raise ServiceError("서비스 이름은 grove[-소문자숫자].service 형식이어야 합니다")
        self.config = absolute_path(config)
        if self.config.name != "install.json":
            raise ServiceError("기존 updater의 install.json 경로를 지정해야 합니다")
        self.unit = unit
        self.unit_dir = absolute_path(unit_dir)
        self.target = self.unit_dir / unit
        self.runner = runner

    def unit_text(self):
        argv = [str(Path(sys.executable).resolve()), str(Path(__file__).resolve()),
                "run", "--apply", "--config", str(self.config), "--unit", self.unit]
        return TEMPLATE.read_text().replace("@EXEC_START@", " ".join(map(systemd_arg, argv)))

    def check_local_owner(self):
        safe_path(self.unit_dir, "dir", missing=True)
        safe_path(self.config, "file", missing=True)
        safe_path(self.target, "file", missing=True)
        if self.target.exists() and self.target.read_text() != self.unit_text():
            raise ServiceError("기존 unit은 이 대상의 관리 파일이 아닙니다. 덮어쓰지 않습니다")

    def command(self, argv, allow_missing=False):
        try:
            result = self.runner(argv)
        except FileNotFoundError:
            raise ServiceError(f"{argv[0]} 미지원: Linux systemd 사용자 세션이 필요합니다") from None
        except subprocess.TimeoutExpired:
            raise ServiceError(f"{argv[0]} 시간 초과: 부분 적용 상태를 확인하고 재실행하세요") from None
        missing_unit = (allow_missing and result.returncode == 1
                        and "LoadState=not-found" in result.stdout.splitlines())
        if result.returncode and not missing_unit:
            # 명령 출력에는 서비스 로그·개인정보가 섞일 수 있으므로 오류에 복제하지 않는다.
            raise ServiceError(f"{argv[0]} 실패(exit {result.returncode}): "
                               "systemd 사용자 세션과 부분 적용 상태를 확인하세요")
        return result.stdout

    def check_manager(self, require_loaded=False):
        output = self.command(["systemctl", "--user", "show", self.unit,
                               "--property=LoadState,FragmentPath"], allow_missing=True)
        props = dict(line.split("=", 1) for line in output.splitlines() if "=" in line)
        fragment = props.get("FragmentPath", "")
        if fragment and fragment != str(self.target):
            raise ServiceError("같은 이름의 다른 unit이 로드되어 있습니다. 변경하지 않습니다")
        if props.get("LoadState") not in ("loaded", "not-found"):
            raise ServiceError("systemd unit 상태를 확인할 수 없습니다")
        if props["LoadState"] == "loaded" and not fragment:
            raise ServiceError("로드된 unit의 소유 경로를 확인할 수 없습니다")
        if require_loaded and props["LoadState"] != "loaded":
            raise ServiceError("systemd가 등록 unit을 찾지 못했습니다. unit 검색 경로를 확인하세요")

    def plan(self, action, binary=None, sha256=None):
        self.check_local_owner()
        if action == "register":
            if binary is None or sha256 is None:
                raise ServiceError("등록에는 --binary와 --sha256이 필요합니다")
            installed_server(self.config, self.unit, binary, sha256)
        if action in ("start", "stop", "status", "logs") and not self.target.exists():
            raise ServiceError("관리 중인 unit이 없습니다")
        if action == "start":
            installed_server(self.config, self.unit)
        commands = {
            "register": [["systemctl", "--user", "daemon-reload"],
                         ["systemctl", "--user", "enable", self.unit]],
            "unregister": ([["systemctl", "--user", "disable", "--now", self.unit]]
                           if self.target.exists() else []) + [
                               ["systemctl", "--user", "daemon-reload"]],
            "start": [["systemctl", "--user", "start", self.unit]],
            "stop": [["systemctl", "--user", "stop", self.unit]],
            "status": [["systemctl", "--user", "show", self.unit,
                        "--property=ActiveState,SubState,UnitFileState,FragmentPath"]],
            "logs": [["journalctl", "--user", "--unit", self.unit,
                      "--no-pager", "--lines=100"]],
        }
        return {"action": action, "unit_file": str(self.target),
                "commands": commands[action], "applied": False,
                "unit_content": self.unit_text() if action == "register" else None,
                "preserves": ["data_dir", "install.json", "credentials", "releases"],
                "note": "등록은 시작하지 않습니다. start는 별도 명시 작업입니다."}

    def execute(self, action, binary=None, sha256=None):
        require_user()
        import fcntl

        self.check_local_owner()
        # 미지원 환경에서는 로컬 파일도 만들기 전에 실패한다.
        require_loaded = action in ("start", "stop", "status", "logs")
        self.check_manager(require_loaded)
        self.unit_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        lock = self.unit_dir / ".grove-user-service.lock"
        safe_path(lock, "file", missing=True)
        fd = os.open(lock, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "r+") as stream:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
            plan = self.plan(action, binary, sha256)
            self.check_manager(require_loaded)
            if action == "register" and not self.target.exists():
                # 완성된 파일만 배타적으로 게시해 중단 후 부분 파일을 남기지 않는다.
                with tempfile.NamedTemporaryFile(mode="w", dir=self.unit_dir,
                                                 prefix=".grove-unit-", delete=False) as unit_file:
                    temporary = Path(unit_file.name)
                    try:
                        unit_file.write(self.unit_text())
                        unit_file.flush()
                        os.fsync(unit_file.fileno())
                        os.link(temporary, self.target)
                    finally:
                        temporary.unlink()
            outputs = []
            for argv in plan["commands"]:
                # disable 성공 뒤에만 파일을 제거한다. 실패하면 재실행할 소유 증거를 보존한다.
                if action == "unregister" and argv[-1] == "daemon-reload" and self.target.exists():
                    self.check_local_owner()
                    self.target.unlink()
                outputs.append(self.command(argv))
                if action == "register" and argv[-1] == "daemon-reload":
                    # 잘못된 --unit-dir 또는 더 높은 우선순위의 동명 unit을 enable하지 않는다.
                    self.check_manager(require_loaded=True)
            plan["applied"] = True
            plan["output"] = "".join(outputs)
            plan["note"] = ("systemd 작업 완료. 서버 health·인증·웹 준비 확인은 별도입니다.")
            return plan


def launch(config, unit):
    require_user()
    argv, web = installed_server(absolute_path(config), unit)
    env = dict(os.environ, GROVE_WEB_DIR=str(web))
    # 셸·새 daemon·PID 추적 없이 foreground 서버를 systemd의 주 프로세스로 교체한다.
    os.execve(argv[0], argv, env)


def default_unit_dir():
    base = os.environ.get("XDG_CONFIG_HOME", str(Path.home() / ".config"))
    return absolute_path(base) / "systemd/user"


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["register", "unregister", "start", "stop",
                                            "status", "logs", "linger", "run"])
    parser.add_argument("--config", required=True, help="기존 updater의 install.json 절대 경로")
    parser.add_argument("--unit", required=True, help="grove[-이름].service")
    parser.add_argument("--unit-dir", type=Path, default=None)
    parser.add_argument("--binary", type=Path)
    parser.add_argument("--sha256")
    parser.add_argument("--apply", action="store_true", help="출력만 하지 않고 명시 적용")
    args = parser.parse_args(argv)
    try:
        service = UserService(args.config, args.unit, args.unit_dir or default_unit_dir())
        if args.action == "run":
            if not args.apply:
                raise ServiceError("run은 내부 실행 진입점이며 --apply가 필요합니다")
            launch(service.config, service.unit)
            return 0
        if args.action == "linger":
            print("로그아웃 후 실행에는 linger가 필요할 수 있습니다. "
                  "`loginctl show-user \"$USER\" -p Linger`로 확인하고, "
                  "정책을 확인한 뒤 `loginctl enable-linger \"$USER\"`를 직접 실행하세요. "
                  "이 도구는 linger를 조회하거나 변경하지 않습니다.")
            return 0
        result = (service.execute if args.apply else service.plan)(
            args.action, args.binary, args.sha256)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except (ServiceError, OSError, UnicodeError) as exc:
        # OS 예외에 실제 파일 내용이나 하위 명령 출력은 포함하지 않는다.
        print(f"오류: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
