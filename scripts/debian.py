"""기존 Linux 압축 배포본을 apt 소유의 .deb로 포장한다. 설치·서비스 조작은 하지 않는다."""

import hashlib
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import tempfile


ROOT = Path(__file__).resolve().parent.parent
ARCHITECTURES = {"linux-x64": "amd64", "linux-arm64": "arm64"}
INPUTS = ["scripts/debian.py", "scripts/build.py", "assets/debian",
          "assets/systemd-user/grove.service.in"]


def validate(targets, revision):
    if not re.fullmatch(r"[0-9][A-Za-z0-9+.~]*", revision):
        raise SystemExit("--deb-revision은 숫자로 시작하는 Debian revision이어야 합니다")
    if any(target not in ARCHITECTURES for target in targets):
        raise SystemExit("--deb는 linux-x64 또는 linux-arm64만 지원합니다")
    architecture = subprocess.check_output(["dpkg", "--print-architecture"], text=True).strip()
    if any(ARCHITECTURES[target] != architecture for target in targets):
        raise SystemExit(f".deb는 대상 아키텍처에서 native 빌드하세요 (현재: {architecture})")


def version(upstream, revision):
    # Cargo의 prerelease는 정식 버전보다 먼저 정렬되어야 한다.
    return f"{upstream.replace('-', '~', 1)}-{revision}"


def digest(path, algorithm="sha256"):
    h = hashlib.new(algorithm)
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def contents(root):
    result = {}
    for path in sorted(root.rglob("*")):
        relative = path.relative_to(root).as_posix()
        if path.is_symlink():
            result[relative] = ("link", os.readlink(path))
        elif path.is_file():
            result[relative] = ("file", path.stat().st_mode & 0o777, digest(path))
    return result


def package(archive, output_dir, target, upstream, revision):
    """dpkg metadata에서 ELF 의존성을 계산하고 추출 결과까지 대조한다."""
    validate([target], revision)
    archive, output_dir = Path(archive), Path(output_dir)
    deb_version = version(upstream, revision)
    destination = output_dir / f"grove_{deb_version}_{ARCHITECTURES[target]}.deb"
    with tempfile.TemporaryDirectory(prefix="grove-deb-", dir=output_dir) as temporary:
        work = Path(temporary)
        source = work / "source"
        with tarfile.open(archive) as bundle:
            bundle.extractall(source, filter="data")
        top, = source.iterdir()
        root = work / "root"
        lib = root / "usr/lib/grove"
        lib.parent.mkdir(parents=True)
        shutil.copytree(top, lib)
        (lib / "grove").chmod(0o755)
        command = root / "usr/bin/grove"
        command.parent.mkdir(parents=True)
        command.symlink_to("../lib/grove/grove")
        doc = root / "usr/share/doc/grove"
        doc.mkdir(parents=True)
        shutil.copyfile(ROOT / "assets/debian/README.Debian", doc / "README.Debian")
        (doc / "copyright").write_text(
            "Grove\nLicense: Apache-2.0\n"
            "The Apache License 2.0 is available in /usr/share/common-licenses/Apache-2.0.\n\n"
            + (lib / "licenses/THIRD_PARTY_NOTICES.txt").read_text())
        unit = root / "usr/lib/systemd/user/grove.service"
        unit.parent.mkdir(parents=True)
        unit.write_text((ROOT / "assets/systemd-user/grove.service.in").read_text()
                        .replace("# Managed by scripts/user_service.py; do not edit.",
                                 "# Package-owned; customize with systemctl --user edit grove.service.")
                        .replace("@EXEC_START@", "/usr/bin/grove serve"))
        # dpkg-shlibdeps는 source control과 대상 아키텍처의 shlibs/symbols DB를 사용한다.
        source_control = work / "debian/control"
        source_control.parent.mkdir()
        source_control.write_text(
            "Source: grove\nSection: devel\nPriority: optional\n"
            "Maintainer: Grove contributors <grove@localhost>\n\n"
            "Package: grove\nArchitecture: any\nDescription: Grove agent server\n")
        dependencies = subprocess.check_output(
            ["dpkg-shlibdeps", "-O", f"-e{lib / 'grove'}"], cwd=work, text=True).strip()
        dependencies = next(line.removeprefix("shlibs:Depends=")
                            for line in dependencies.splitlines() if line.startswith("shlibs:Depends="))
        metadata = root / "DEBIAN"
        metadata.mkdir()
        size = (sum(path.stat().st_size for path in root.rglob("*") if path.is_file()) + 1023) // 1024
        (metadata / "control").write_text(
            f"Package: grove\nVersion: {deb_version}\nArchitecture: {ARCHITECTURES[target]}\n"
            "Maintainer: Grove contributors <grove@localhost>\nSection: devel\nPriority: optional\n"
            f"Depends: {dependencies}\nRecommends: ca-certificates\nInstalled-Size: {size}\n"
            "Description: Grove agent server and web app\n"
            " Single Rust server with a shared web app. Runs as the invoking user.\n")
        # 빌드 사용자의 umask와 무관하게 root 소유 공유 프로그램으로 배포한다.
        root.chmod(0o755)
        for path in root.rglob("*"):
            if not path.is_symlink():
                path.chmod(0o755 if path.is_dir() or path == lib / "grove" else 0o644)
        payload = {key: value for key, value in contents(root).items() if not key.startswith("DEBIAN/")}
        (metadata / "md5sums").write_text("".join(
            f"{digest(root / key, 'md5')}  {key}\n"
            for key, value in payload.items() if value[0] == "file"))
        (metadata / "md5sums").chmod(0o644)
        candidate = work / destination.name
        subprocess.run(["dpkg-deb", "--root-owner-group", "--build", str(root), str(candidate)], check=True)
        extracted = work / "extracted"
        subprocess.run(["dpkg-deb", "--extract", str(candidate), str(extracted)], check=True)
        if contents(extracted) != payload:
            raise SystemExit(".deb 추출 결과가 원본 payload와 다릅니다")
        os.replace(candidate, destination)
    return {"file": destination.name, "version": deb_version, "architecture": ARCHITECTURES[target],
            "depends": dependencies, "sha256": digest(destination), "size": destination.stat().st_size}
