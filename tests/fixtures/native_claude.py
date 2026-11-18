#!/usr/bin/env python3
"""네이티브 명령 경계 시험. 모델·hook·MCP를 실행하지 않는다."""
import json
from pathlib import Path
import sys

args = sys.argv[1:]
if "--input-format" in args:
    request = json.loads(sys.stdin.readline())
    if request["type"] == "control_request":
        assert "--strict-mcp-config" in args
        assert "--no-session-persistence" in args
        assert "--setting-sources" not in args
        assert json.loads(args[args.index("--settings") + 1])["disableAllHooks"] is True
        print(json.dumps({"type": "control_response", "response": {
            "request_id": request["request_id"], "subtype": "success",
            "response": {"commands": json.loads(Path("native-commands.json").read_text())},
        }}), flush=True)
        sys.exit(0)
    text = request["message"]["content"][0]["text"]
else:
    text = sys.stdin.read()

context = ""
if "--append-system-prompt-file" in args:
    context = Path(args[args.index("--append-system-prompt-file") + 1]).read_text()
with Path("claude-wire.jsonl").open("a") as stream:
    stream.write(json.dumps({"args": args, "text": text, "context": context}) + "\n")
print(json.dumps({"type": "assistant", "message": {"content": [{"type": "text", "text": "native fixture"}]}}), flush=True)
print(json.dumps({"type": "result", "subtype": "success", "session_id": "native-fixture",
                  "result": "native fixture", "usage": {"input_tokens": 10, "output_tokens": 2}}), flush=True)
