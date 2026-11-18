#!/usr/bin/env python3
"""테스트 전용 stdio peer. 모델·인증·네트워크를 사용하지 않는다."""

import json
import os
from pathlib import Path
import sys


def emit(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)


def notify(method, params):
    emit({"method": method, "params": {"threadId": thread, "turnId": "turn-1", **params}})


thread = None
usage_base = {}
exit_code = 0
live_mode = ""
live_count = 0
partial_steer_line = False
Path("native-pid").write_text(str(os.getpid()))
for line in sys.stdin:
    message = json.loads(line)
    with Path("wire.jsonl").open("a") as record:
        record.write(json.dumps(message, ensure_ascii=False) + "\n")
    method = message.get("method")
    if method == "initialize":
        emit({"id": message["id"], "result": {"userAgent": "fixture"}})
    elif method == "initialized":
        pass
    elif method == "skills/list":
        skills = json.loads(Path("native-skills.json").read_text())
        emit({"id": message["id"], "result": {"data": [{"cwd": os.getcwd(), "skills": skills, "errors": []}]}})
    elif method in ("thread/start", "thread/resume"):
        params = message["params"]
        if params.get("threadId") == "missing-thread":
            emit({"id": message["id"], "error": {"code": -32602, "message": "fixture refusal"}})
            continue
        thread = params.get("threadId", "thread-new")
        usage_base = {"inputTokens": 1000, "cachedInputTokens": 600, "outputTokens": 100,
                      "cacheWriteInputTokens": 20, "reasoningOutputTokens": 30, "totalTokens": 1100} if method == "thread/resume" else {}
        emit({"id": message["id"], "result": {"thread": {"id": thread}}})
        if usage_base:
            notify("thread/tokenUsage/updated", {"turnId": "previous-turn", "tokenUsage": {"total": usage_base}})
    elif method == "turn/start":
        params = message["params"]
        text = params["input"][0]["text"]
        for item in params["input"][1:]:
            if item["type"] == "skill":
                assert Path(item["path"]).is_absolute()
                continue
            assert item["type"] == "localImage"
            path = Path(item["path"])
            assert path.suffix == ".png" and path.is_file() and path.stat().st_size > 0
        if "RPC_FAIL" in text:
            emit({"id": message["id"], "error": {"code": -32602, "message": "fixture refusal"}})
            continue
        if "NO_FINAL" in text:
            break
        notify("turn/started", {"turn": {"id": "turn-1", "status": "inProgress", "items": []}})
        # 응답보다 먼저 온 알림도 잃으면 안 된다.
        notify("item/started", {"item": {"id": "m1", "type": "agentMessage", "text": ""}})
        notify("item/agentMessage/delta", {"itemId": "m1", "delta": "첫"})
        if "LIVE_STEER" in text:
            live_mode = text
            emit({"id": message["id"], "result": {"turn": {"id": "turn-1"}}})
            # 클라이언트가 추가 입력을 보내는 동안, 개행 전 stdout 버퍼도 보존해야 한다.
            fragment = json.dumps({"method": "item/agentMessage/delta", "params": {
                "threadId": thread, "turnId": "turn-1", "itemId": "m1", "delta": " 조각",
            }}, ensure_ascii=False)
            sys.stdout.write(fragment[:-2])
            sys.stdout.flush()
            partial_steer_line = True
            continue
        if "HANG" in text:
            emit({"id": message["id"], "result": {"turn": {"id": "turn-1"}}})
            if "OVERSIZE" in text:
                # 이미지가 포함되는 app-server 프레임의 한도도 같은 회귀 경로로 검사한다.
                size = int(text.split("OVERSIZE:")[1].split()[0])
                sys.stdout.write("x" * size)
                sys.stdout.flush()
            # stdin은 클라이언트가 취소할 때까지 열려 있다. 임의 타이밍 지연 없이 대기한다.
            sys.stdin.read()
            break
        if "INTERACTION" in text:
            emit({"id": "approval", "method": "item/commandExecution/requestApproval",
                  "params": {"threadId": thread, "turnId": "turn-1", "itemId": "command"}})
            reply = json.loads(sys.stdin.readline())
            assert reply["id"] == "approval" and reply["error"]["code"] == -32601
            break
        notify("item/agentMessage/delta", {"itemId": "m1", "delta": " 답"})
        notify("item/completed", {"item": {"id": "m1", "type": "agentMessage", "text": "첫 답"}})
        notify("item/reasoning/summaryTextDelta", {"itemId": "r1", "summaryIndex": 0, "delta": "요약"})
        notify("item/reasoning/textDelta", {"itemId": "r1", "contentIndex": 0, "delta": "원시 추론은 표시 금지"})
        notify("item/completed", {"item": {"id": "r1", "type": "reasoning", "summary": ["요약"]}})
        notify("item/started", {"item": {"id": "c1", "type": "commandExecution",
                                       "command": "fixture command", "status": "inProgress"}})
        notify("item/completed", {"item": {"id": "c1", "type": "commandExecution",
                                         "command": "fixture command", "status": "completed", "exitCode": 0}})
        notify("item/agentMessage/delta", {"itemId": "m2", "delta": "최종"})
        notify("item/agentMessage/delta", {"itemId": "m2", "delta": " 답"})
        notify("item/completed", {"item": {"id": "m2", "type": "agentMessage", "text": "최종 답"}})
        usage = {
            "inputTokens": 100, "cachedInputTokens": 60, "outputTokens": 5,
            "cacheWriteInputTokens": 2, "reasoningOutputTokens": 3, "totalTokens": 105,
        }
        notify("thread/tokenUsage/updated", {"tokenUsage": {"total": {key: value + usage_base.get(key, 0) for key, value in usage.items()}}})
        # 다른 thread/turn의 delta는 현재 대화에 섞이면 안 된다.
        notify("item/agentMessage/delta", {"threadId": "foreign", "itemId": "bad", "delta": "잘못된 대화"})
        notify("item/agentMessage/delta", {"turnId": "foreign", "itemId": "bad", "delta": "잘못된 턴"})
        status = "failed" if "TURN_FAIL" in text else "interrupted" if "INTERRUPTED" in text else "completed"
        notify("turn/completed", {"turn": {"id": "turn-1", "status": status, "items": [
            {"id": "m1", "type": "agentMessage", "text": "첫 답"},
            {"id": "m2", "type": "agentMessage", "text": "최종 답"},
        ]}})
        emit({"id": message["id"], "result": {"turn": {"id": "turn-1", "status": status}}})
        if "EXIT_FAIL" in text:
            exit_code = 7
    elif method == "turn/steer":
        params = message["params"]
        assert params["threadId"] == thread and params["expectedTurnId"] == "turn-1"
        assert params["clientUserMessageId"]
        assert params["input"][0]["type"] == "text"
        for item in params["input"][1:]:
            assert item["type"] == "localImage" and Path(item["path"]).is_file()
        if partial_steer_line:
            sys.stdout.write("}}\n")
            sys.stdout.flush()
            partial_steer_line = False
        live_count += 1
        if "LOST" in live_mode:
            break
        if "REJECT" in live_mode:
            emit({"id": message["id"], "error": {"code": -32602, "message": "private fixture refusal"}})
        else:
            emit({"id": message["id"], "result": {"turnId": "turn-1"}})
        if "HOLD" in live_mode or ("TWO" in live_mode and live_count < 2):
            continue
        notify("turn/completed", {"turn": {"id": "turn-1", "status": "completed", "items": []}})
    else:
        raise AssertionError(f"unexpected method: {method}")

sys.exit(exit_code)
