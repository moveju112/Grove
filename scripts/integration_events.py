"""통합 이벤트 JSONL. 원문/경로 대신 허용된 식별자·상태·시간만 기록한다."""
import argparse
from datetime import datetime, timezone
import fcntl
import json
import math
import os
from pathlib import Path
import re
import stat
import time
import uuid


EVENTS = {
    "assigned", "start-requested", "started", "completion-observed",
    "intake-started", "merge-started", "merge-finished", "fix-requested",
    "cleanup-finished", "prepared", "deferred", "queue-observed",
    "workspace-observed", "validation-phase",
}
STATUSES = {
    "prepared", "running", "candidate", "integrated-candidate", "legacy-review",
    "needs-continuation", "blocked", "invalid-handoff", "excluded", "invalid-path",
    "workspace-mismatch", "needs-attention", "dirty", "orphaned-result",
    "needs-handoff", "preparing", "waiting-lock", "passed", "failed",
    "timed-out", "interrupted", "error",
}
REASONS = {"capacity", "backlog", "shared-lock", "dependency", "approval",
           "conflict", "test-failure", "environment", "unknown"}
NUMBERS = {"work", "running", "backlog", "max_running", "start_slots", "returncode"}


def validate(fields):
    for key, value in fields.items():
        if key in NUMBERS:
            valid = type(value) is int and (key == "returncode" or value >= 0)
        elif key in {"commit", "before_commit"}:
            valid = isinstance(value, str) and re.fullmatch(r"[0-9a-f]{40,64}", value)
        elif key == "job":
            valid = isinstance(value, str) and re.fullmatch(r"validation-[a-z0-9_-]{1,40}", value)
        elif key in {"status", "previous_status"}:
            valid = isinstance(value, str) and value in STATUSES
        elif key == "reason":
            valid = isinstance(value, str) and value in REASONS
        elif key == "duration_seconds":
            valid = type(value) in (int, float) and math.isfinite(value) and value >= 0
        else:
            valid = False
        if not valid:
            raise ValueError("허용하지 않은 이벤트 필드 또는 값")


def emit(path, event, **fields):
    if event not in EVENTS:
        raise ValueError("허용하지 않은 이벤트")
    validate(fields)
    record = dict(schema=1, event_id=str(uuid.uuid4()),
                  observed_at=datetime.now(timezone.utc).isoformat(),
                  monotonic_ns=time.monotonic_ns(), event=event, **fields)
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "a") as target:
        if not stat.S_ISREG(os.fstat(target.fileno()).st_mode):
            raise ValueError("이벤트 저장소는 일반 파일이어야 함")
        fcntl.flock(target, fcntl.LOCK_EX)
        os.fchmod(target.fileno(), 0o600)
        target.write(json.dumps(record, ensure_ascii=False, allow_nan=False) + "\n")
        target.flush()
        os.fsync(target.fileno())
    return record


def observe(path, snapshot):
    """주기 관측은 실제 시작/완료 시각이 아니다. 과거 이벤트를 합성하지 않는다."""
    emit(path, "queue-observed", commit=snapshot["head"],
         running=snapshot["running_sessions"], backlog=snapshot["backlog"],
         max_running=snapshot["max_running"], start_slots=snapshot["start_slots"])
    for item in snapshot["queue"]:
        fields = dict(work=item["number"], status=item["state"])
        if item.get("tip"):
            fields["commit"] = item["tip"]
        emit(path, "workspace-observed", **fields)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--events", required=True)
    parser.add_argument("--event", choices=sorted(EVENTS), required=True)
    parser.add_argument("--work", type=int, required=True)
    parser.add_argument("--job")
    parser.add_argument("--commit")
    parser.add_argument("--before-commit")
    parser.add_argument("--reason", choices=sorted(REASONS))
    options = vars(parser.parse_args())
    path = options.pop("events")
    event = options.pop("event")
    try:
        emit(path, event, **{key: value for key, value in options.items() if value is not None})
    except (OSError, ValueError):
        parser.exit(1, "이벤트 기록 실패: 저장소 권한과 허용 필드를 확인해야 함\n")


if __name__ == "__main__":
    main()
