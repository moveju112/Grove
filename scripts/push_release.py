#!/usr/bin/env python3
"""승인된 main 푸시: 다음 패치 버전 → GitHub Release → 같은 패키지로 로컬 서버·CLI·Pages 반영."""
import argparse
from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import tomllib

import build
import deploy_local as deploy

ROOT = Path(build.ROOT)
REPO = "moveju112/Grove"
VERSIONS = ("Cargo.toml", "Cargo.lock", "web/package.json", "web/package-lock.json")


def output(*args):
    return subprocess.check_output(args, cwd=ROOT, text=True).strip()


def run(*args, **kwargs):
    subprocess.run(args, cwd=kwargs.pop("cwd", ROOT), check=True, **kwargs)


def next_patch(version):
    if not re.fullmatch(r"(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)", version):
        raise ValueError(f"정식 릴리즈 버전이 필요합니다: {version}")
    major, minor, patch = version.split(".")
    return f"{major}.{minor}.{int(patch) + 1}"


def version_files(root, old, new):
    changed = {}
    for name in VERSIONS:
        path = root / name
        text = path.read_text()
        if name == "Cargo.toml":
            pattern = r'(?m)(^\[package\]\nname = "grove"\nversion = ")'
        elif name == "Cargo.lock":
            pattern = r'(?m)(^name = "grove"\nversion = ")'
        elif name == "web/package.json":
            pattern = r'(?m)(^  "version": ")'
        else:
            pattern = r'(?m)(^\s*"name": "grove-web",\n\s*"version": ")'
        updated, n = re.subn(pattern + re.escape(old) + '"', lambda m: m[1] + new + '"', text)
        if n != (2 if name.endswith("package-lock.json") else 1):
            raise ValueError(f"{name}의 Grove 버전이 {old}와 일치하지 않습니다")
        changed[path] = updated
    return changed


def file_names(version):
    return (f"grove-{version}-linux-x64.tar.gz", f"grove_{version}-1_amd64.deb",
            "manifest.json", "sbom.cdx.json", "SHA256SUMS", "release.json")


def gh(*args):
    return output("gh", "api", f"repos/{REPO}/" + args[0], *args[1:])


def release_for(tag):
    # 404만 새 릴리즈로 취급한다. 네트워크·인증 오류는 쓰기 전에 중단한다.
    result = subprocess.run(["gh", "release", "view", tag, "--repo", REPO, "--json", "apiUrl"],
                            capture_output=True, text=True)
    if result.returncode and result.stderr.strip() == "release not found":
        return None
    result.check_returncode()
    return json.loads(output("gh", "api", json.loads(result.stdout)["apiUrl"]))


@contextmanager
def release_source(parent):
    # publish()는 git 공통 작업을 직렬화한다. 고정된 실제 경로는 Cargo와 RUSTFLAGS 모두의 키다.
    source = parent / "source"
    marker = source / ".grove-release-scratch"
    # 빌드 자식에게도 이 잠금을 전달한다. 호출 프로세스가 먼저 끝나도 작업 중인 소스를 회수하지 않는다.
    with (parent / "source.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if source.exists():
            if source.is_symlink() or not source.is_dir() or not marker.is_file() or marker.is_symlink() or marker.read_text() != "grove-release-v1\n":
                raise ValueError(f"릴리즈 작업 경로가 다른 파일과 충돌합니다: {source}")
            shutil.rmtree(source)
        source.mkdir(mode=0o700)
        try:
            marker.write_text("grove-release-v1\n")
            yield source, lock.fileno()
        finally:
            shutil.rmtree(source)


def release_build_env(source, parent):
    env = build.env()
    # 최종 실행 파일은 이번 소스 전용이다. 사용자 Cargo 설정이 이미 외부 중간 캐시를 지정하면 재사용한다.
    env["CARGO_TARGET_DIR"] = str(source / "target")
    meta = json.loads(subprocess.check_output(["cargo", "metadata", "--no-deps", "--format-version", "1"],
                                               cwd=source, env=env))
    if Path(meta["build_directory"]).resolve().is_relative_to(source.resolve()):
        env["CARGO_BUILD_BUILD_DIR"] = str(parent / "cargo-build")
    return env


def rust_test_command(env):
    # nextest는 시험 파일 사이까지 병렬로 돌린다. 직렬화가 필요한 시험은 .config/nextest.toml의 test-group에 둔다.
    probe = subprocess.run(["cargo", "nextest", "--version"], env=env, capture_output=True)
    if probe.returncode == 0:
        return ("cargo", "nextest", "run", "--locked", "--no-fail-fast")
    print("cargo-nextest가 없어 cargo test로 검사합니다(느림). 설치: cargo install cargo-nextest --locked", file=sys.stderr)
    return ("cargo", "test", "--locked", "--no-fail-fast")


def fresh_member(member, directory):
    # 과거 커밋의 타임스탬프로 파일을 복원하면 Cargo가 이전 바이너리를 그대로 쓸 수 있다.
    safe = tarfile.data_filter(member, directory)
    return safe.replace(mtime=None) if safe is not None else None


def checkout_verifier():
    # 내려받은 패키지는 그 안의 실행 파일로 자기 서명을 확인하지 않는다. 현재 checkout으로 만든 검증기를 쓴다.
    env = build.env()
    run("cargo", "build", "--locked", "--bin", "grove", env=env)
    metadata = json.loads(subprocess.check_output(["cargo", "metadata", "--no-deps", "--format-version", "1"], cwd=ROOT, env=env))
    return Path(metadata["target_directory"]) / "debug/grove"


@contextmanager
def package_verifier(pkg, version):
    # 직접 만들었거나 서명을 확인한 패키지는 그 release 실행 파일로 서명·검증한다. 별도 debug 빌드(약 70초)를 기다리지 않는다.
    with tempfile.TemporaryDirectory() as tmp, tarfile.open(pkg / file_names(version)[0]) as tar:
        member = tar.getmember(f"grove-{version}-{deploy.TARGET}/grove")
        if not member.isfile():
            raise ValueError("패키지에 grove 실행 파일이 없습니다")
        binary = Path(tmp, "grove")
        with tar.extractfile(member) as source, binary.open("xb") as target:
            shutil.copyfileobj(source, target)
        binary.chmod(0o700)
        yield binary


def prepare_package(commit, version, parent):
    dest = parent / commit
    checked = "rust-tests-passed"
    if (dest / checked).is_file() and (dest / checked).read_text() == commit:
        return dest
    with release_source(parent) as (source, lock_fd):
        with tempfile.TemporaryFile() as archive:
            run("git", "archive", commit, stdout=archive)
            archive.seek(0)
            with tarfile.open(fileobj=archive) as tar:
                tar.extractall(source, filter=fresh_member)
        version_files(source, version, version)
        if (ROOT / ".dev").exists():
            (source / ".dev").symlink_to(ROOT / ".dev", target_is_directory=True)
        env = release_build_env(source, parent)
        env.pop("GROVE_UPDATE_BINDINGS", None)  # 계약 파일을 다시 쓰지 않고 커밋과 대조한다.
        for directory in ("web", "relay"):
            run("npm", "ci", "--no-audit", "--no-fund", cwd=source / directory, pass_fds=(lock_fd,))
        with build.rust_test_tmp() as tmp_env:
            run(*rust_test_command(env), cwd=source, env={**env, **tmp_env}, pass_fds=(lock_fd,))
        if dest.is_dir():
            # 이전 절차로 준비한 패키지는 해당 커밋의 검사를 통과한 뒤에만 재사용한다.
            (dest / checked).write_text(commit)
            return dest
        run(sys.executable, "scripts/build.py", "package", "--targets", deploy.TARGET, "--deb", cwd=source, env=env, pass_fds=(lock_fd,))
        pkg = source / "dist/release" / f"grove-{version}-{deploy.TARGET}"
        receipt = json.loads((pkg / "receipt.json").read_text())
        manifest = json.loads((pkg / "manifest.json").read_text())
        if not all(v["executed"] and v["web_status"] == 200 for v in (receipt["verify"], receipt["deb"]["verify"])):
            raise ValueError("두 패키지의 실행 검증이 필요합니다")
        assets = {}
        for platform, filename in zip((deploy.TARGET, "debian-amd64"), file_names(version)[:2]):
            asset = pkg / filename
            assets[platform] = {"url": f"https://github.com/{REPO}/releases/download/v{version}/{filename}",
                                "size": asset.stat().st_size, "sha256": build.sha256(asset)}
        unsigned = source / "unsigned.json"
        unsigned.write_text(json.dumps({"product": "grove", "channel": "stable", "version": version,
                                       "protocol": manifest["protocol"], "schema": manifest["schema"],
                                       "issued_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "artifacts": assets}))
        with package_verifier(pkg, version) as verifier:
            run(verifier, "release", "sign", "--key", deploy.KEY, unsigned, pkg / "release.json", stdout=subprocess.DEVNULL)
            verify_package(pkg, version, verifier)
        (pkg / checked).write_text(commit)
        pkg.rename(dest)
    return dest


def verify_package(pkg, version, verifier):
    signed = json.loads(output(verifier, "release", "verify", pkg / "release.json"))
    names = file_names(version)
    if signed["version"] != version or signed["channel"] != "stable":
        raise ValueError("서명 manifest의 버전·채널 불일치")
    for platform, name in zip((deploy.TARGET, "debian-amd64"), names[:2]):
        expected = signed["artifacts"][platform]
        if (expected["url"] != f"https://github.com/{REPO}/releases/download/v{version}/{name}"
                or expected["sha256"] != build.sha256(pkg / name) or expected["size"] != (pkg / name).stat().st_size):
            raise ValueError(f"{name}: 서명한 패키지와 다릅니다")
    # 외부 manifest도 서명된 압축본에 들어 있는 원본과 같아야 Pages 검증에 사용할 수 있다.
    with tarfile.open(pkg / names[0]) as tar:
        inner = tar.extractfile(f"grove-{version}-{deploy.TARGET}/manifest.json").read()
    if inner != (pkg / "manifest.json").read_bytes():
        raise ValueError("패키지 내부 manifest 불일치")
    expected_sums = {f"{build.sha256(pkg / n)}  {n}" for n in names[:4]}
    if set((pkg / "SHA256SUMS").read_text().splitlines()) != expected_sums:
        raise ValueError("릴리즈 SHA256SUMS 불일치")
    return signed


def sync_assets(tag, pkg, version, release):
    names = file_names(version)
    assets = {asset["name"]: asset for asset in release["assets"]}
    for name in names:
        if name not in assets:
            if not release["draft"]:
                raise ValueError(f"게시된 {tag}에 {name}이 없습니다")
            run("gh", "release", "upload", tag, pkg / name, "--repo", REPO)
        elif assets[name]["digest"] != "sha256:" + build.sha256(pkg / name):
            raise ValueError(f"{tag}의 기존 {name} 해시가 달라 덮어쓸 수 없습니다")
    remote = json.loads(gh(f"releases/{release['id']}"))
    hashes = {a["name"]: a["digest"] for a in remote["assets"] if a["state"] == "uploaded"}
    if any(hashes.get(n) != "sha256:" + build.sha256(pkg / n) for n in names):
        raise ValueError("업로드된 릴리즈 파일 검증 실패")
    if remote["draft"]:
        current = json.loads(gh("releases/latest"))["tag_name"]
        if "v" + next_patch(current.removeprefix("v")) != tag:
            raise ValueError(f"최신 릴리즈가 {current}이므로 {tag}를 latest로 게시할 수 없습니다")
        run("gh", "release", "edit", tag, "--repo", REPO, "--draft=false", "--latest")


def publish(plan_only=False):
    if output("git", "branch", "--show-current") != "main":
        raise ValueError("main 브랜치에서 실행하세요")
    origin = output("git", "remote", "get-url", "--push", "origin").removesuffix(".git")
    if origin not in (f"https://github.com/{REPO}", f"git@github.com:{REPO}", f"ssh://git@github.com/{REPO}"):
        raise ValueError("origin push 대상이 Grove 공식 저장소와 다릅니다")
    latest = json.loads(gh("releases/latest"))["tag_name"]
    old = latest.removeprefix("v")
    next_version = next_patch(old)
    head = output("git", "rev-parse", "HEAD")
    published = json.loads(gh(f"commits/{latest}"))["sha"]
    source_version = tomllib.loads(output("git", "show", "HEAD:Cargo.toml"))["package"]["version"]
    version = old if head == published else next_version
    if source_version not in (old, version):
        raise ValueError(f"최신 릴리즈 {latest}와 현재 소스 버전 {source_version}을 확인하세요")
    if plan_only:
        if head == published and output("git", "status", "--porcelain", "--untracked-files=no"):
            print(f"개발 변경 커밋 후 v{next_version} · 푸시·릴리즈·로컬 반영")
        else:
            print(f"{head[:12]} · v{version} · {'기존 릴리즈 반영' if head == published else '푸시·릴리즈·로컬 반영'}")
        return
    run("git", "merge-base", "--is-ancestor", published, head)
    caller = deploy.deployment_caller() if Path(deploy.INSTALL, "current").exists() else None
    if source_version != version:
        if output("git", "status", "--porcelain", "--", *VERSIONS):
            raise ValueError("버전 파일의 개발 변경을 먼저 커밋하세요")
        for path, text in version_files(ROOT, old, version).items():
            path.write_text(text)
        run("git", "commit", "--only", "-m", f"Grove {version} 릴리즈 준비", "--", *VERSIONS)
        head = output("git", "rev-parse", "HEAD")
    tag = "v" + version
    release = release_for(tag)
    parent = ROOT / "dist/github-releases"
    parent.mkdir(parents=True, exist_ok=True)
    if release and not release["draft"]:
        if json.loads(gh(f"commits/{tag}"))["sha"] != head:
            raise ValueError(f"{tag}가 다른 커밋을 가리킵니다")
        pkg = parent / head
        if not pkg.exists():
            with tempfile.TemporaryDirectory(dir=parent) as tmp:
                fetched = Path(tmp, "assets")
                run("gh", "release", "download", tag, "--repo", REPO, "--dir", fetched, *download_patterns(version))
                verify_package(fetched, version, checkout_verifier())
                fetched.rename(pkg)
    else:
        pkg = prepare_package(head, version, parent)
        # 다른 호스트가 선점한 커밋·태그는 강제로 덮어쓰지 않는다.
        run("git", "push", "--atomic", "origin", f"{head}:refs/heads/main", f"{head}:refs/tags/{tag}",
            env={**os.environ, "GROVE_RELEASE_PUSH_INTERNAL": "1"})
        if release is None:
            run("gh", "release", "create", tag, "--repo", REPO, "--verify-tag", "--draft", "--title", f"Grove {tag}",
                "--notes", f"Linux x64 압축본과 Debian·Ubuntu amd64 패키지. [설치 안내](https://github.com/{REPO}/blob/{tag}/README.md)")
            release = release_for(tag)
    with package_verifier(pkg, version) as verifier:
        signed = verify_package(pkg, version, verifier)
    sync_assets(tag, pkg, version, release)
    if json.loads(gh("releases/latest"))["tag_name"] != tag:
        raise ValueError("최신 공개 릴리즈가 바뀌어 로컬 반영을 중단합니다")
    archive = pkg / file_names(version)[0]
    asset = signed["artifacts"][deploy.TARGET]
    receipt = {"archive_sha256": asset["sha256"], "size": asset["size"]}
    manifest = json.loads((pkg / "manifest.json").read_text())
    deploy.apply_package(str(archive), receipt, dict(manifest, commit=head, published_tag=tag), caller, wait_if_busy=True)


def install_hook():
    # 한 checkout의 기존 hooks 디렉터리에 이 훅만 연결한다. 기존 훅은 덮어쓰지 않는다.
    configured = subprocess.run(["git", "config", "--get", "core.hooksPath"], cwd=ROOT, capture_output=True)
    if configured.returncode == 0:
        raise ValueError("기존 core.hooksPath를 유지합니다. pre-push와 reference-transaction 훅에 scripts/git_release_pre_push.sh와 scripts/git_release_hook.sh를 각각 연결하세요")
    hooks = Path(output("git", "rev-parse", "--absolute-git-dir")) / "hooks"
    hooks.mkdir(exist_ok=True)
    new_hooks = {}
    for name, script in (("pre-push", "git_release_pre_push.sh"), ("reference-transaction", "git_release_hook.sh")):
        hook = hooks / name
        content = (ROOT / "scripts" / script).read_bytes()
        if hook.is_symlink() or (hook.exists() and (not hook.is_file() or hook.read_bytes() != content)):
            raise ValueError(f"기존 {name} 훅과 충돌합니다. 변경하지 않았습니다")
        if not hook.exists():
            new_hooks[hook] = content
    for hook, content in new_hooks.items():
        with hook.open("xb") as stream:
            stream.write(content)
        hook.chmod(0o755)


def download_patterns(version):
    return [arg for name in file_names(version) for arg in ("--pattern", name)]


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plan", action="store_true", help="버전과 동작만 조회")
    parser.add_argument("--install-hook", action="store_true", help="이 checkout의 일반 git push에도 릴리즈 흐름 연결")
    args = parser.parse_args()
    if args.install_hook:
        install_hook()
    elif args.plan:
        publish(True)
    else:
        # 같은 호스트의 버전 변경과 업로드·적용을 직렬화한다.
        with open(output("git", "rev-parse", "--absolute-git-dir") + "/grove-push.lock", "a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            publish()
