"""읽기 전용 통합 후보 수집. 실행: python3 scripts/integration_queue.py --root PATH"""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys


RUNNING = {"running", "initializing"}
STOPPED = {"idle", "closed"}
MAX_RUNNING = 4
BATCH_SIZE = 3
HANDOFF_MARKER = "<!-- grove-handoff:v1"


def canonical(path):
    return str(Path(path).expanduser().resolve())


def read_assignments(text):
    """활성 표만 읽는다. 완료 이력은 재수집하지 않는다."""
    active = False
    found = False
    rows = []
    seen = [set() for _ in range(4)]
    for line in text.splitlines():
        if line.startswith("## "):
            active = line.strip() == "## 준비 완료된 워크스페이스"
            found |= active
        if not active or not line.startswith("|"):
            continue
        cells = [cell.strip().strip("`") for cell in line.strip().strip("|").split("|")]
        if not cells or not re.fullmatch(r"\d+", cells[0]):
            continue
        if len(cells) < 5 or not Path(cells[2]).is_absolute() or not cells[3].startswith("wks_"):
            raise ValueError("활성 workspace 표의 번호·경로·ID 형식 오류")
        values = [int(cells[0]), cells[1], canonical(cells[2]), cells[3]]
        for value, used in zip(values, seen):
            if value in used:
                raise ValueError("활성 workspace 표의 번호·브랜치·경로·ID 중복")
            used.add(value)
        rows.append(dict(zip(("number", "branch", "cwd", "workspace_id"), values)))
    if not found:
        raise ValueError("README의 활성 workspace 절을 찾지 못함")
    return rows


def read_worktrees(text):
    trees = {}
    for block in text.strip("\0").split("\0\0"):
        fields = dict(field.split(" ", 1) if " " in field else (field, "")
                      for field in block.split("\0") if field)
        if "worktree" in fields:
            trees[canonical(fields["worktree"])] = fields
    return trees


def command(args, cwd):
    return subprocess.run(args, cwd=cwd, text=True, capture_output=True,
                          check=True, timeout=30).stdout


def git(root, *args):
    # status도 인덱스를 갱신하지 않도록 선택적 잠금을 끈다.
    return command(["git", "--no-optional-locks", "-C", str(root), *args], root)


def load_agents(root):
    data = json.loads(command(["paseo", "agent", "ls", "--global", "--all", "--json"], root))
    if not isinstance(data, list):
        raise ValueError("Paseo 세션 목록이 배열이 아님")
    for agent in data:
        if not isinstance(agent, dict) or not all(isinstance(agent.get(k), str) and agent[k]
                                                 for k in ("id", "cwd", "status")):
            raise ValueError("Paseo 세션 목록의 id·cwd·status 형식 오류")
    return data


def read_handoff(path):
    """완료 계약은 인계 맨 앞 8 KiB 안에 둔다. 과거 문서는 수동 분류 대상으로 둔다."""
    with path.open("rb") as source:
        text = source.read(8192).decode("utf-8", errors="replace")
    _, marker, tail = text.partition(HANDOFF_MARKER)
    if not marker:
        return {"state": "legacy-review"}
    payload, end, _ = tail.partition("-->")
    if not end:
        raise ValueError("완료 계약이 잘렸음")
    data = json.loads(payload)
    if not isinstance(data, dict) or data.get("state") not in {"ready", "needs-work", "blocked"}:
        raise ValueError("완료 계약 상태 오류")
    for key in ("remaining", "integration_checks"):
        if not isinstance(data.get(key), list) or not all(isinstance(value, str) and value.strip()
                                                        for value in data[key]):
            raise ValueError(f"완료 계약 {key} 형식 오류")
    blockers = data.get("blockers")
    if not isinstance(blockers, list) or not all(
        isinstance(blocker, dict) and all(isinstance(blocker.get(key), str) and blocker[key].strip()
                                        for key in ("reason", "unblock"))
        for blocker in blockers
    ):
        raise ValueError("완료 계약 blocker 형식 오류")
    if data["state"] == "ready" and (data["remaining"] or blockers):
        raise ValueError("미완료·blocker를 ready로 표시할 수 없음")
    if data["state"] == "needs-work" and not data["remaining"]:
        raise ValueError("계속할 작업이 없는 needs-work")
    if data["state"] == "blocked" and (not blockers or data["remaining"]):
        raise ValueError("blocked에는 해제 조건이 필요하며 실행 가능한 작업을 남길 수 없음")
    return data


def is_ancestor(root, tip, head):
    result = subprocess.run(
        ["git", "--no-optional-locks", "-C", str(root), "merge-base", "--is-ancestor", tip, head],
        text=True, capture_output=True, timeout=30,
    )
    if result.returncode not in (0, 1):
        raise subprocess.CalledProcessError(result.returncode, result.args, stderr=result.stderr)
    return result.returncode == 0


def collect(root, agents):
    root = Path(root).resolve()
    if canonical(git(root, "rev-parse", "--show-toplevel").strip()) != str(root):
        raise ValueError("--root에는 Git top-level 경로가 필요함")
    head = git(root, "rev-parse", "HEAD").strip()
    assignments = read_assignments((root / "work/README.md").read_text())
    trees = read_worktrees(git(root, "worktree", "list", "--porcelain", "-z"))
    by_cwd = {}
    for agent in agents:
        by_cwd.setdefault(canonical(agent["cwd"]), []).append(agent)

    # 표에서 누락된 기존 기능 세션도 실행 한도에 포함한다.
    feature_paths = {path for path, tree in trees.items()
                     if tree.get("branch", "").startswith("refs/heads/parallel/")}
    feature_paths.update(row["cwd"] for row in assignments)
    running = sum(agent["status"] in RUNNING
                  for path in feature_paths for agent in by_cwd.get(path, []))
    uncertain = any(agent["status"] not in RUNNING | STOPPED | {"error"}
                    for path in feature_paths for agent in by_cwd.get(path, []))
    queue = []
    for row in assignments:
        item = dict(row)
        sessions = by_cwd.get(row["cwd"], [])
        item["sessions"] = [{"id": agent["id"], "status": agent["status"]} for agent in sessions]
        tree = trees.get(row["cwd"])
        item["tip"] = tree.get("HEAD") if tree else None
        result_path = f"work/RESULT-{row['number']:02}.md"
        item["result"] = result_path
        if row["number"] == 6:
            state = "excluded"
        elif row["cwd"] in (str(root), str(Path.home()), os.path.sep):
            state = "invalid-path"
        elif not tree or tree.get("branch") != f"refs/heads/{row['branch']}":
            state = "workspace-mismatch"
        elif any(agent["status"] in RUNNING for agent in sessions):
            # 실행 중인 worktree의 diff·인계·검사 로그를 다시 읽지 않는다.
            state = "running"
        elif any(agent["status"] not in STOPPED for agent in sessions):
            state = "needs-attention"
        elif git(row["cwd"], "status", "--porcelain", "-z", "--untracked-files=normal"):
            state = "dirty"
        elif not sessions:
            state = "orphaned-result" if (Path(row["cwd"]) / result_path).exists() else "prepared"
        elif not (entry := git(root, "ls-tree", tree["HEAD"], "--", result_path)):
            state = "needs-handoff"
        else:
            try:
                if not entry.startswith(("100644 ", "100755 ")):
                    raise ValueError("RESULT는 일반 파일이어야 함")
                handoff = read_handoff(Path(row["cwd"]) / result_path)
                item["handoff_state"] = handoff["state"]
                item["integrated"] = is_ancestor(root, tree["HEAD"], head)
                state = {
                    "legacy-review": "legacy-review",
                    "needs-work": "needs-continuation",
                    "blocked": "blocked",
                    "ready": "integrated-candidate" if item["integrated"] else "candidate",
                }[handoff["state"]]
            except ValueError:
                state = "invalid-handoff"
        item["state"] = state
        queue.append(item)

    candidates = [item["number"] for item in queue if item["state"] == "candidate"]
    integrated = [item["number"] for item in queue if item["state"] == "integrated-candidate"]
    legacy = [item["number"] for item in queue if item["state"] == "legacy-review"]
    backlog = len(candidates) + len(integrated) + len(legacy)
    slots = 0 if uncertain else max(0, MAX_RUNNING - running)
    return {
        "head": head,
        "running_sessions": running,
        "max_running": MAX_RUNNING,
        "backlog": backlog,
        "start_slots": 0 if backlog >= BATCH_SIZE else slots,
        "continuation_slots": slots,
        "candidates": candidates,
        "integrated_candidates": integrated,
        "legacy_review": legacy,
        "needs_continuation": [item["number"] for item in queue if item["state"] == "needs-continuation"],
        "blocked": [item["number"] for item in queue if item["state"] == "blocked"],
        "queue": queue,
        "advisory": "후보는 완료·검증·삭제 승인이 아님. 변경 직전 상태·권한·RESULT·기준 SHA를 재확인할 것.",
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args(argv)
    try:
        snapshot = collect(args.root, load_agents(args.root))
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        # 원시 서비스 응답에는 인증 정보가 섞일 수 있으므로 그대로 출력하지 않는다.
        detail = f"exit {error.returncode}" if isinstance(error, subprocess.CalledProcessError) else str(error)
        print(f"통합 큐 수집 실패 ({type(error).__name__}): {detail}", file=sys.stderr)
        return 1
    print(json.dumps(snapshot, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
