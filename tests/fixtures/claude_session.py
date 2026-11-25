#!/usr/bin/env python3
"""Claude JSONL 연결 수명 시험. 외부 호출은 하지 않는다."""
import json
import os
from pathlib import Path
import sys

args = sys.argv[1:]
settings = json.loads(args[args.index("--settings") + 1])
assert "forceLoginMethod" not in settings and "apiKeyHelper" not in settings
assert all(key not in os.environ for key, value in settings["env"].items() if value == "")
# CLI 내장 백그라운드는 실행 환경과 --settings 양쪽에서 끈다.
assert os.environ["CLAUDE_CODE_DISABLE_BACKGROUND_TASKS"] == settings["env"]["CLAUDE_CODE_DISABLE_BACKGROUND_TASKS"] == "1"

def record(**entry):
    with Path("wire.jsonl").open("a") as wire:
        print(json.dumps(dict(pid=os.getpid(), **entry)), file=wire)

def emit(**entry):
    print(json.dumps(entry), flush=True)

if args[-3:] == ["auth", "status", "--json"]:
    auth = Path("auth-method").read_text() if Path("auth-method").exists() else "claude.ai"
    emit(loggedIn=auth != "none", authMethod=auth, apiProvider="firstParty",
         subscriptionType="max" if auth == "claude.ai" else None)
    sys.exit(1 if auth == "none" else 0)

resumed = "--resume" in args
session = args[args.index("--resume" if resumed else "--session-id") + 1]
record(event="spawn", session=session, resumed=resumed)
link = None
api_total = 0
for line in sys.stdin:
    data = json.loads(line)
    if data["type"] == "control_request":
        control = data["request"]
        if control["subtype"] == "mcp_set_servers":
            server = control["servers"].get("grove_continuations")
            link = server["args"][1] if server else None
            record(event="mcp", link=link)
        else:
            assert control["subtype"] == "initialize"
        emit(type="control_response", response={"request_id": data["request_id"], "subtype": "success", "response": {"errors": {}}})
        continue
    assert data["type"] == "user" and data["session_id"] == session
    text = data["message"]["content"][0]["text"]
    record(event="user", text=text, link=link)
    if text.endswith("hold"):
        emit(type="assistant", message={"content": [{"type": "text", "text": "started"}]})
        import time
        time.sleep(60)
    if text in ("steer-tool", "steer-after"):
        # 실행 중 합치기: CLI는 다음 경계에서 같은 uuid로 replay한다.
        emit(type="assistant", message={"content": [{"type": "text", "text": "started"}]})
        steer = json.loads(next(sys.stdin))
        assert steer["type"] == "user" and steer["session_id"] == session and steer["uuid"]
        record(event="steer", text=steer["message"]["content"][0]["text"], uuid=steer["uuid"])
        if text == "steer-after":
            api_total += 20
            emit(type="result", subtype="success", session_id=session, result="started", duration_ms=1000, duration_api_ms=api_total,
                 usage={"output_tokens": 2})
            emit(type="system", subtype="init", session_id=session)
        emit(type="user", isReplay=True, uuid=steer["uuid"], message=steer["message"], session_id=session)
        emit(type="assistant", message={"content": [{"type": "text", "text": "merged"}]})
        text = "merged"
    api_total += 10
    timing = {"duration_ms": 999}
    if not text.endswith("untimed"):
        timing["duration_api_ms"] = api_total
    emit(type="result", subtype="success", session_id=session, result=text, usage={"output_tokens": 1}, **timing)
    if text == "usage-after-result":
        import time
        time.sleep(0.08)
        emit(type="rate_limit_event", rate_limit_info={"rateLimitType": "seven_day", "utilization": 0.25})
