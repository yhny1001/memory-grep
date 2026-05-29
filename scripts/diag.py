#!/usr/bin/env python3
"""
TauriTavern Agent Run Diagnostics

读取 TT 本地最新（或指定）的 agent run 目录，输出：
- 我的 memory-grep 插件实际注入到 system[0] 的策略（前 600 字）
- 检测 chat-mode vs agent-mode policy marker（验证 detection 是否正确）
- 工具调用统计 + 每个 chat.search / chat.read_messages 的 args 与结果摘要
- 失败的工具调用 + 错误原因
- model rounds 数 + 总耗时

用法:
    python3 diag.py                # 最新 chat 的最新 run
    python3 diag.py --runs 3       # 最近 3 个 run
    python3 diag.py --chat <id>    # 指定 chat
    python3 diag.py --run <run_id> # 指定 run（绝对 ID）
    python3 diag.py --full-system  # 完整 dump system[0] 内容
"""

import argparse
import json
import os
import sys
from collections import Counter
from datetime import datetime
from pathlib import Path

DATA_ROOT = Path.home() / "Library/Application Support/com.tauritavern.client/data"
WS_ROOT = DATA_ROOT / "_tauritavern/agent-workspaces/chats"

CHAT_POLICY_MARKER = "【记忆约束 / Memory Constraints】"
AGENT_POLICY_MARKER = "【记忆约束 / Memory Constraints — Agent Mode】"


def latest_dir(p: Path):
    items = [d for d in p.iterdir() if d.is_dir()]
    if not items:
        return None
    return max(items, key=lambda d: d.stat().st_mtime)


def fmt_time(ts):
    if not ts:
        return "?"
    try:
        return datetime.fromtimestamp(ts).strftime("%H:%M:%S")
    except Exception:
        return str(ts)


def first_text(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for p in content:
            if isinstance(p, str):
                parts.append(p)
            elif isinstance(p, dict):
                parts.append(p.get("text") or p.get("content") or "")
        return "\n".join(s for s in parts if s)
    return str(content or "")


def analyze_run(run_dir: Path, full_system=False):
    print("=" * 70)
    print(f"RUN: {run_dir.name}")
    print(f"     chat: {run_dir.parent.parent.name}")
    print(f"     mtime: {datetime.fromtimestamp(run_dir.stat().st_mtime)}")
    print("=" * 70)

    # ---- A. plugin policy injection check ----
    snap_path = run_dir / "input/prompt_snapshot.json"
    if snap_path.exists():
        snap = json.load(snap_path.open())
        msgs = snap.get("chatCompletionPayload", {}).get("messages", [])
        print(f"\n[A] prompt_snapshot.messages: {len(msgs)} msgs")
        if msgs:
            sys0 = msgs[0]
            txt0 = first_text(sys0.get("content"))
            role0 = sys0.get("role")
            head = txt0[:600].replace("\n", "\n    ")
            print(f"    [0] role={role0} len={len(txt0)}")
            if full_system:
                print("    --- FULL SYSTEM[0] ---")
                print(txt0)
                print("    --- END ---")
            else:
                print(f"    HEAD:\n    {head}")

            # marker detection
            has_chat = CHAT_POLICY_MARKER in txt0
            has_agent = AGENT_POLICY_MARKER in txt0
            mode = "?"
            if has_agent:
                mode = "AGENT (good for agent runs)"
            elif has_chat:
                mode = "CHAT (BAD if this was an agent run — plugin failed to detect)"
            else:
                mode = "NEITHER (plugin disabled or not loaded)"
            print(f"    -> plugin policy mode: {mode}")

            # role-by-role inventory
            roles = Counter(m.get("role") for m in msgs)
            print(f"    role counts: {dict(roles)}")
    else:
        print(f"\n[A] no prompt_snapshot.json")

    # ---- B. tool calls ----
    ta = run_dir / "tool-args"
    tr = run_dir / "tool-results"
    if ta.exists():
        calls = sorted(ta.iterdir(), key=lambda f: f.stat().st_mtime)
        print(f"\n[B] tool calls: {len(calls)}")

        by_tool = Counter()
        chat_search_calls = []
        chat_read_calls = []
        failures = []

        for cf in calls:
            args = json.load(cf.open())
            res_path = tr / cf.name
            if not res_path.exists():
                continue
            res = json.load(res_path.open())
            name = res.get("name") or res.get("tool_name") or "?"
            by_tool[name] += 1
            is_err = res.get("is_error") or res.get("isError")
            content = res.get("content") or ""
            if isinstance(content, list):
                content = " | ".join(
                    str(p.get("text", "") if isinstance(p, dict) else p) for p in content
                )
            content_head = str(content)[:160].replace("\n", " ¶ ")
            entry = (cf.name, args, is_err, content_head)
            if name == "chat.search":
                chat_search_calls.append(entry)
            elif name == "chat.read_messages":
                chat_read_calls.append(entry)
            if is_err:
                failures.append((name, cf.name, args, content_head))

        print(f"    by tool: {dict(by_tool)}")
        if failures:
            print(f"    !! {len(failures)} FAILED CALLS:")
            for name, cid, args, head in failures:
                print(
                    f"       - {name} ({cid[:18]}…) args={json.dumps(args, ensure_ascii=False)[:140]}"
                )
                print(f"         err: {head}")

        if chat_search_calls:
            print(f"\n    chat.search calls ({len(chat_search_calls)}):")
            for cid, args, is_err, head in chat_search_calls:
                tag = "❌" if is_err else "✅"
                print(
                    f"      {tag} args={json.dumps(args, ensure_ascii=False)[:180]}"
                )
                print(f"         res: {head}")

        if chat_read_calls:
            print(f"\n    chat.read_messages calls ({len(chat_read_calls)}):")
            for cid, args, is_err, head in chat_read_calls:
                tag = "❌" if is_err else "✅"
                # extract max_chars to verify guideline
                req = args.get("messages") or []
                max_chars_list = [r.get("max_chars") for r in req if isinstance(r, dict)]
                print(
                    f"      {tag} max_chars={max_chars_list} args={json.dumps(args, ensure_ascii=False)[:180]}"
                )
                print(f"         res: {head}")

    # ---- C. model rounds ----
    mr = run_dir / "model-responses"
    if mr.exists():
        rounds = sorted(mr.iterdir())
        print(f"\n[C] model rounds: {len(rounds)}")
        # token usage from last round if available
        if rounds:
            try:
                last = json.load(rounds[-1].open())
                meta = last.get("response", {}).get("providerMetadata", {})
                usage = meta.get("usage", {})
                if usage:
                    print(f"    last round usage: {usage}")
            except Exception as e:
                print(f"    failed to parse last round: {e}")

    # ---- D. run.json summary ----
    rj = run_dir / "run.json"
    if rj.exists():
        r = json.load(rj.open())
        status = r.get("status") or r.get("state") or "?"
        print(f"\n[D] run.json: status={status}")
        for k in ("startedAt", "completedAt", "errorMessage", "errorCode"):
            if k in r:
                print(f"    {k}: {r[k]}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", type=int, default=1, help="how many recent runs to analyze")
    ap.add_argument("--chat", type=str, help="specific chat dir (e.g. chat_699ad6e6df2b7467)")
    ap.add_argument("--run", type=str, help="specific run id (e.g. run_xxx)")
    ap.add_argument("--full-system", action="store_true", help="dump full system[0] text")
    args = ap.parse_args()

    if not WS_ROOT.exists():
        print(f"ERROR: workspace root not found: {WS_ROOT}")
        sys.exit(1)

    if args.run:
        # find it anywhere
        candidates = list(WS_ROOT.glob(f"*/runs/{args.run}"))
        if not candidates:
            print(f"ERROR: run not found: {args.run}")
            sys.exit(1)
        analyze_run(candidates[0], full_system=args.full_system)
        return

    chat_dir = None
    if args.chat:
        chat_dir = WS_ROOT / args.chat
        if not chat_dir.exists():
            print(f"ERROR: chat dir not found: {chat_dir}")
            sys.exit(1)
    else:
        chat_dir = latest_dir(WS_ROOT)
        if not chat_dir:
            print("no chats found")
            sys.exit(0)

    runs_dir = chat_dir / "runs"
    if not runs_dir.exists():
        print(f"no runs in {chat_dir}")
        sys.exit(0)

    runs = sorted(runs_dir.iterdir(), key=lambda d: d.stat().st_mtime, reverse=True)
    for r in runs[: args.runs]:
        analyze_run(r, full_system=args.full_system)
        print()


if __name__ == "__main__":
    main()
