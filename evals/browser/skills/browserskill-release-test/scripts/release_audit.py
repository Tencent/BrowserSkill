#!/usr/bin/env python3
"""Bsk-only execution ledger, fail-closed release gate, and multi-run benchmark suite. Standard library only."""

import argparse
import datetime as dt
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import uuid

SKILL = Path(__file__).resolve().parents[1]

ACTION_COMMANDS = {
    "open",
    "close",
    "ledger resolve",
    "click",
    "fill",
    "select",
    "press",
    "hover",
    "drag",
    "wheel",
    "scroll-to",
    "focus",
    "blur",
    "upload",
    "download",
    "navigate",
    "navigate back",
    "navigate forward",
    "navigate-back",
    "navigate-forward",
    "reload",
    "window resize",
    "emulate",
    "dialog accept",
    "dialog dismiss",
    "tab create",
    "tab select",
    "tab close",
    "tab borrow",
    "tab return",
}

READ_COMMANDS = {
    "sync",
    "ledger status",
    "read",
    "extract discover",
    "extract table",
    "extract list",
    "observe",
    "snapshot",
    "cooperate sync",
    "view",
    "get-html",
    "console",
    "network",
}


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def parse_iso_ms(ts):
    if not ts or not isinstance(ts, str):
        return None
    try:
        if ts.endswith("Z"):
            ts = ts[:-1] + "+00:00"
        return dt.datetime.fromisoformat(ts).timestamp() * 1000.0
    except ValueError:
        return None


def percentile(values, q):
    if not values:
        return 0.0
    ordered = sorted(float(v) for v in values)
    if len(ordered) == 1:
        return round(ordered[0], 2)
    pos = (len(ordered) - 1) * q
    low = int(math.floor(pos))
    high = int(math.ceil(pos))
    if low == high:
        return round(ordered[low], 2)
    weight = pos - low
    return round(ordered[low] * (1.0 - weight) + ordered[high] * weight, 2)


def stats_summary(values):
    nums = [float(v) for v in values if v is not None]
    if not nums:
        return {
            "count": 0,
            "total": 0.0,
            "mean": 0.0,
            "p50": 0.0,
            "p95": 0.0,
            "min": 0.0,
            "max": 0.0,
        }
    total = sum(nums)
    return {
        "count": len(nums),
        "total": round(total, 2),
        "mean": round(total / len(nums), 2),
        "p50": percentile(nums, 0.50),
        "p95": percentile(nums, 0.95),
        "min": round(min(nums), 2),
        "max": round(max(nums), 2),
    }


def digest(p):
    return hashlib.sha256(Path(p).read_bytes()).hexdigest()


def load(p):
    return json.loads(Path(p).read_text(encoding="utf-8"))


def write(p, value):
    p = Path(p)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_name(p.name + "." + uuid.uuid4().hex + ".tmp")
    tmp.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    tmp.replace(p)


def parse(text):
    try:
        return json.loads(text)
    except ValueError:
        try:
            return [json.loads(x) for x in text.splitlines() if x.strip()]
        except ValueError:
            return None


def discover(bsk, directory):
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    leaves = []
    seen = set()
    documents = []
    env = dict(os.environ, BSK_RECIPES="1", BSK_AUTO_UPDATE="off")

    def visit(parts):
        key = " ".join(parts)
        if key in seen:
            return
        seen.add(key)
        r = subprocess.run(
            [bsk, *parts, "--help"],
            capture_output=True,
            text=True,
            timeout=20,
            env=env,
        )
        if r.returncode:
            raise ValueError("Help discovery failed: " + key + " " + r.stderr)
        text = r.stdout
        file = directory / ((key.replace(" ", "__") or "root") + ".txt")
        file.write_text(text)
        documents.append({"command": key, "path": file.name, "sha256": digest(file)})
        match = re.search(r"^Commands:\s*\n(.*?)(?=^\S|\Z)", text, re.M | re.S)
        children = (
            re.findall(r"^  ([a-z][a-z0-9_-]*)\s", match.group(1), re.M)
            if match
            else []
        )
        # `recipe` is hidden from root `--help` while experimental, but `bsk recipe --help`
        # exposes its subcommands when supported by the candidate binary.
        if not parts and "recipe" not in children:
            probe = subprocess.run(
                [bsk, "recipe", "--help"],
                capture_output=True,
                text=True,
                timeout=20,
                env=env,
            )
            if (
                probe.returncode == 0
                and re.search(r"Usage:\s+\S+\s+recipe\b", probe.stdout)
                and re.search(r"^Commands:\s*\n", probe.stdout, re.M)
            ):
                children.append("recipe")
        # `help` is terminal; recursively exploring its aliases would cycle.
        children = [c for c in children if c != "help"]
        if children:
            # navigate has both a direct URL form and back/forward children.
            if parts and "Arguments:" in text:
                leaves.append(key)
            for child in children:
                visit(parts + [child])
            if not parts:
                leaves.append("help")
            return
        arguments = (
            text.split("Arguments:", 1)[1].split("Options:", 1)[0]
            if "Arguments:" in text
            else ""
        )
        action = re.search(r"\[possible values:\s*([^\]]+)\]", arguments, re.S)
        if action:
            for value in action.group(1).replace("\n", " ").split(","):
                leaves.append(" ".join(parts + [value.strip()]))
        elif parts:
            leaves.append(key)

    visit([])
    if not leaves:
        raise ValueError("Empty command inventory")
    return {
        "bsk": bsk,
        "entry_sha256": digest(bsk),
        "discovered_at": now(),
        "commands": sorted(set(leaves)),
        "help_documents": documents,
    }


def canonical(argv, inventory):
    if "--help" in argv or "-h" in argv:
        return None
    matches = [c for c in inventory if argv[: len(c.split())] == c.split()]
    return max(matches, key=lambda x: len(x.split())) if matches else None


def extract_metrics(cmd, exit_code, parsed, elapsed_ms):
    j = parsed if isinstance(parsed, dict) else {}
    if cmd == "plan":
        mode = "plan"
    elif cmd == "recipe run":
        mode = "recipe"
    elif cmd and cmd.startswith("recipe"):
        mode = "recipe_mgmt"
    elif cmd == "step":
        mode = "step"
    elif cmd in READ_COMMANDS:
        mode = "read"
    elif cmd in ACTION_COMMANDS:
        mode = "single_action"
    else:
        mode = "other"

    if cmd == "plan":
        actions = int(j.get("completed", 0)) if isinstance(j.get("completed"), int) else 0
    elif cmd == "recipe run":
        effects = j.get("effects") if isinstance(j.get("effects"), dict) else {}
        actions = int(effects.get("steps_done", 0)) if isinstance(effects.get("steps_done"), int) else 0
    elif cmd == "step":
        act_obj = j.get("action") if isinstance(j.get("action"), dict) else {}
        actions = 1 if (exit_code == 0 or "result" in act_obj) else 0
    elif cmd in ACTION_COMMANDS and exit_code == 0:
        actions = 1
    else:
        actions = 0

    if cmd == "view":
        browser_calls = 0
        rpc_calls = 0
    elif cmd in (
        "recipe list",
        "recipe show",
        "recipe save",
        "recipe rm",
        "recipe approve",
        "help",
    ):
        browser_calls = 0
        rpc_calls = 0
    elif cmd == "recipe draft":
        rpc_calls = 3 if exit_code == 0 else 1
        browser_calls = 2 if exit_code == 0 else 0
    elif cmd == "open":
        # `bsk open` = resolve/start session RPC + tool.navigate + settled sync
        # (crates/bsk-cli/src/cli/lifecycle.rs::dispatch_open); the latter two hit the browser.
        rpc_calls = 3 if exit_code == 0 else 1
        browser_calls = 2 if exit_code == 0 else 0
    elif cmd in ("ledger status", "ledger resolve"):
        rpc_calls = 1
        browser_calls = 0
    elif isinstance(j.get("rpc_calls"), int):
        rpc_calls = j["rpc_calls"]
        browser_calls = j.get("browser_calls", rpc_calls)
    elif cmd == "plan":
        if exit_code != 0 and not j:
            rpc_calls = 0
            browser_calls = 0
        else:
            rpc_calls = (
                actions
                + (1 if j.get("post") else 0)
                + (1 if j.get("readiness") else 0)
            )
            browser_calls = rpc_calls
    elif cmd == "recipe run":
        if j.get("status") == "refused" and not j.get("session_id"):
            rpc_calls = 0
            browser_calls = 0
        else:
            browser_calls = max(1, actions + 1)
            rpc_calls = browser_calls + (2 if j.get("session_stopped") else 1)
    else:
        rpc_calls = 1
        browser_calls = 1

    post = j.get("post") if isinstance(j.get("post"), dict) else {}
    obs = j.get("observation") if isinstance(j.get("observation"), dict) else {}
    post_obs = post.get("observation") if isinstance(post.get("observation"), dict) else {}
    obs_text = (
        obs.get("text")
        or post_obs.get("text")
        or (j.get("vom") if isinstance(j.get("vom"), str) else "")
        or (j.get("delta") if isinstance(j.get("delta"), str) else "")
    )
    obs_kind = (
        j.get("kind")
        or post.get("kind")
        or ("unchanged" if j.get("unchanged") is True else None)
        or ("delta" if isinstance(j.get("delta"), str) else None)
        or ("full" if isinstance(j.get("vom"), str) else None)
    )
    origin = j.get("observation_origin") or post.get("observation_origin") or {}
    reused = (isinstance(origin, dict) and origin.get("kind") == "reused") or (
        j.get("unchanged") is True
    )
    tool_elapsed = j.get("elapsed_ms") if isinstance(j.get("elapsed_ms"), (int, float)) else None

    return {
        "execution_mode": mode,
        "interaction_turns": 0 if cmd == "help" or cmd is None else 1,
        "actions_executed": actions,
        "rpc_calls": int(rpc_calls),
        "browser_calls": int(browser_calls),
        "elapsed_ms": round(float(elapsed_ms or 0.0), 2),
        "tool_elapsed_ms": round(float(tool_elapsed), 2) if tool_elapsed is not None else None,
        "observation_kind": obs_kind if isinstance(obs_kind, str) else None,
        "observation_reused": bool(reused),
        "vom_chars": len(obs_text) if isinstance(obs_text, str) else 0,
    }


def semantic_failure(meta, value):
    cmd = meta["command"]
    j = value.get("json")
    if cmd in ["evaluate", "step", "plan", "wait-for-element"]:
        if not isinstance(j, dict):
            return "Machine-readable result required for " + cmd
        if cmd in ["evaluate", "step", "plan"] and j.get("ok") is not True:
            return cmd + " did not return ok:true"
        if cmd == "wait-for-element" and j.get("satisfied") is not True:
            return "Wait condition was not satisfied"
    if cmd == "recipe run":
        if not isinstance(j, dict):
            return "Machine-readable result required for recipe run"
        if j.get("status") != "completed":
            return "recipe run did not return status:completed"
    if cmd == "recipe save":
        if not isinstance(j, dict):
            return "Machine-readable result required for recipe save"
        if j.get("saved") is False:
            return "recipe save returned saved:false"
    if cmd == "recipe draft":
        if not isinstance(j, dict):
            return "Machine-readable result required for recipe draft"
        if j.get("errors"):
            return "recipe draft reported errors"
    if cmd == "recipe approve":
        if not isinstance(j, dict):
            return "Machine-readable result required for recipe approve"
        if j.get("status") == "refused" or j.get("approved") is False:
            return "recipe approve was not confirmed"
    if cmd == "read":
        if not isinstance(j, dict) or not isinstance(j.get("items"), list):
            return "Machine-readable items array required for read"
    if cmd in ["open", "sync"] and "--json" in (value.get("argv") or []):
        if not isinstance(j, dict):
            return "Machine-readable result required for " + cmd
    if (
        cmd
        in [
            "open",
            "navigate",
            "navigate back",
            "navigate forward",
            "navigate-back",
            "navigate-forward",
            "wait-for-navigation",
        ]
        and isinstance(j, dict)
        and j.get("reached") == "timeout"
    ):
        return "Navigation timed out"
    return None


def init(args):
    out = Path(args.out).expanduser().resolve()
    if out.exists():
        raise ValueError("Use a fresh run directory; never overwrite an earlier round")
    bsk = str(Path(args.bsk).expanduser().resolve())
    out.mkdir(parents=True)
    inv = discover(bsk, out / "help")
    write(out / "inventory.json", inv)
    cases = load(SKILL / "references/scenarios.json")
    # Every discovered leaf gets its own reviewable result in addition to workflows.
    for cmd in inv["commands"]:
        cases.append(
            {
                "id": "CMD-" + cmd.replace(" ", "__"),
                "kind": "command",
                "command": cmd,
                "page_type": "command-contract",
                "required_commands": [cmd],
                "goal": "Execute this command (not --help) in its applicable fixture or isolated admin environment; verify its documented result.",
                "recipe": "references/command-recipes.md",
            }
        )
    if len({c["id"] for c in cases}) != len(cases):
        raise ValueError("Command paths produced duplicate case IDs")
    binary = str(Path(args.binary or bsk).expanduser().resolve())
    config = {
        "schema_version": 2,
        "created_at": now(),
        "bsk": bsk,
        "entry_sha256": inv["entry_sha256"],
        "binary": binary,
        "binary_sha256": digest(binary),
        "browser": args.browser,
        "candidate": args.candidate,
        "fixture_port": args.port,
        "execution_backend": "bsk",
        "site_urls": [
            "https://www.oceanengine.com/",
            "https://www.taobao.com/",
            "https://www.bilibili.com/",
            "https://www.v2ex.com/",
            "https://developer.mozilla.org/zh-CN/",
            "https://github.com/Tencent/BrowserSkill",
            "https://books.toscrape.com/",
            "https://news.ycombinator.com/",
        ],
    }
    write(out / "run.json", config)
    write(out / "plan.json", {"schema_version": 2, "cases": cases})
    config.update(
        inventory_sha256=digest(out / "inventory.json"),
        plan_sha256=digest(out / "plan.json"),
    )
    write(out / "run.json", config)
    assets = SKILL / "assets/fixtures"
    target = out / "fixtures"
    shutil.copytree(assets, target)
    for p in target.glob("*.html"):
        text = p.read_text(encoding="utf-8")
        text = text.replace("localhost:4187", f"localhost:{args.port}")
        text = text.replace("127.0.0.1:4187", f"127.0.0.1:{args.port}")
        p.write_text(text, encoding="utf-8")
    (target / "empty.txt").write_bytes(b"")
    (target / "upload 中文.txt").write_text(
        "合成上传内容 👋\n第二行\n", encoding="utf-8"
    )
    write(out / "results.json", {"cases": []})
    print(
        json.dumps(
            {
                "run": str(out),
                "commands": len(inv["commands"]),
                "cases": len(cases),
                "fixture_url": f"http://127.0.0.1:{args.port}",
            },
            ensure_ascii=False,
        )
    )


def resolve_admin_home(root):
    admin_dir = Path(root).resolve() / "admin-runtime"
    admin_dir.mkdir(parents=True, exist_ok=True)
    if sys.platform == "win32":
        return str(admin_dir)
    sock_probe = str(admin_dir / "run" / "daemon.sock")
    if len(sock_probe.encode("utf-8")) <= 96:
        return str(admin_dir)
    tag = hashlib.sha256(str(admin_dir).encode("utf-8")).hexdigest()[:12]
    tmp_root = Path("/tmp") if Path("/tmp").is_dir() else Path(tempfile.gettempdir())
    link = tmp_root / f"bsk-adm-{tag}"
    try:
        if link.is_symlink() or link.exists():
            if link.resolve() == admin_dir:
                return str(link)
            if link.is_symlink():
                link.unlink()
        link.symlink_to(admin_dir, target_is_directory=True)
        return str(link)
    except OSError:
        return str(admin_dir)


def execute(args):
    root = Path(args.run).resolve()
    cfg = load(root / "run.json")
    inv = load(root / "inventory.json")
    if digest(cfg["bsk"]) != cfg["entry_sha256"]:
        raise ValueError("Bsk entry changed; start a new candidate round")
    if digest(cfg["binary"]) != cfg["binary_sha256"]:
        raise ValueError("Bsk binary changed; start a new candidate round")
    argv = args.argv
    if argv and argv[0] == "--":
        argv = argv[1:]
    if not argv:
        raise ValueError("Supply Bsk arguments after --")
    ids = {c["id"] for c in load(root / "plan.json")["cases"]}
    if args.case not in ids:
        raise ValueError("Unknown case ID")
    record_id = uuid.uuid4().hex
    folder = root / "commands" / record_id
    folder.mkdir(parents=True)
    env = dict(
        os.environ,
        BSK_AUTO_START="0",
        BSK_AUTO_UPDATE="off",
        BSK_RECIPES=os.environ.get("BSK_RECIPES", "1"),
    )
    explicit_env = {}
    for item in getattr(args, "env", None) or []:
        if "=" not in item:
            raise ValueError("Environment override must be KEY=VALUE")
        k, v = item.split("=", 1)
        explicit_env[k] = v
    exe = cfg["bsk"]
    if args.lane == "admin":
        exe = cfg["binary"]
        env["BSK_HOME"] = resolve_admin_home(root)
    env.update(explicit_env)
    stdin_path = within(root, args.stdin_file) if args.stdin_file else None
    cmd_name = canonical(argv, inv["commands"])
    started_iso = now()
    started_ms = parse_iso_ms(started_iso)
    # No implicit context, tab, session, browser, retries, or argument repair.
    meta = {
        "id": record_id,
        "case_id": args.case,
        "argv": argv,
        "command": cmd_name,
        "started": started_iso,
        "bsk": cfg["bsk"],
        "entry_sha256": cfg["entry_sha256"],
        "backend": "bsk",
        "binary_sha256": cfg["binary_sha256"],
        "lane": args.lane,
        "executable": exe,
        "stdin_sha256": digest(stdin_path) if stdin_path else None,
    }
    write(folder / "started.json", meta)
    timed_out = False
    with (
        (folder / "stdout.txt").open("wb") as stdout,
        (folder / "stderr.txt").open("wb") as stderr,
    ):
        if stdin_path and args.interactive:
            raise ValueError("Choose a stdin file or interactive mode")
        input_handle = (
            stdin_path.open("rb")
            if stdin_path
            else (subprocess.PIPE if args.interactive else subprocess.DEVNULL)
        )
        p = subprocess.Popen(
            [exe, *argv], stdout=stdout, stderr=stderr, stdin=input_handle, env=env
        )
        if args.interactive:

            def forward():
                with (folder / "stdin.txt").open("wb") as log:
                    while True:
                        line = sys.stdin.buffer.readline()
                        if not line:
                            break
                        log.write(line)
                        log.flush()
                        try:
                            p.stdin.write(line)
                            p.stdin.flush()
                        except (BrokenPipeError, OSError):
                            break
                try:
                    p.stdin.close()
                except (BrokenPipeError, OSError):
                    pass

            threading.Thread(target=forward, daemon=True).start()
        print(
            json.dumps(
                {
                    "started_record": record_id,
                    "stdout": str(folder / "stdout.txt"),
                    "stderr": str(folder / "stderr.txt"),
                }
            ),
            flush=True,
        )
        try:
            code = p.wait(timeout=args.timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
            p.send_signal(signal.SIGINT)
            try:
                code = p.wait(timeout=5)
            except subprocess.TimeoutExpired:
                p.kill()
                code = p.wait()
        if stdin_path:
            input_handle.close()
    finished_iso = now()
    finished_ms = parse_iso_ms(finished_iso)
    elapsed_ms = (
        round(max(0.0, finished_ms - started_ms), 2)
        if started_ms is not None and finished_ms is not None
        else 0.0
    )
    out_text = (folder / "stdout.txt").read_text(errors="replace")
    err_text = (folder / "stderr.txt").read_text(errors="replace")
    parsed_json = parse(out_text.strip() or err_text.strip())
    metrics = extract_metrics(cmd_name, code, parsed_json, elapsed_ms)
    meta.update(
        finished=finished_iso,
        elapsed_ms=elapsed_ms,
        exit_code=code,
        timed_out=timed_out,
        stdout_sha256=digest(folder / "stdout.txt"),
        stderr_sha256=digest(folder / "stderr.txt"),
        metrics=metrics,
    )
    if args.interactive and (folder / "stdin.txt").exists():
        meta["stdin_sha256"] = digest(folder / "stdin.txt")
    write(folder / "meta.json", meta)
    print(
        json.dumps(
            {
                "record": record_id,
                "exit_code": code,
                "timed_out": timed_out,
                "elapsed_ms": elapsed_ms,
                "metrics": metrics,
                "stdout": str(folder / "stdout.txt"),
                "stderr": str(folder / "stderr.txt"),
            },
            ensure_ascii=False,
        )
    )
    return code if 0 <= code <= 125 else 1


def pointer(value, path):
    if path == "":
        return value
    if not path.startswith("/"):
        raise ValueError("JSON pointer must start with /")
    for key in path[1:].split("/"):
        key = key.replace("~1", "/").replace("~0", "~")
        value = value[int(key)] if isinstance(value, list) else value[key]
    return value


def within(root, value):
    path = (root / value).resolve()
    if not path.is_relative_to(root):
        raise ValueError("Evidence must be inside this run")
    return path


def read_record(root, record_id):
    if not re.fullmatch("[a-f0-9]{32}", record_id):
        raise ValueError("Invalid record ID")
    d = root / "commands" / record_id
    m = load(d / "meta.json")
    if m["id"] != record_id:
        raise ValueError("Record identity mismatch")
    for kind in ["stdout", "stderr"]:
        if digest(d / (kind + ".txt")) != m[kind + "_sha256"]:
            raise ValueError("Changed raw " + kind)
    if (d / "stdin.txt").exists() and digest(d / "stdin.txt") != m.get("stdin_sha256"):
        raise ValueError("Changed protocol input")
    out = (d / "stdout.txt").read_text(errors="replace")
    err = (d / "stderr.txt").read_text(errors="replace")
    parsed_json = parse(out.strip() or err.strip())
    if "elapsed_ms" not in m:
        s_ms = parse_iso_ms(m.get("started"))
        f_ms = parse_iso_ms(m.get("finished"))
        m["elapsed_ms"] = (
            round(max(0.0, f_ms - s_ms), 2)
            if s_ms is not None and f_ms is not None
            else 0.0
        )
    if "metrics" not in m:
        m["metrics"] = extract_metrics(
            m.get("command"), m.get("exit_code", 0), parsed_json, m["elapsed_ms"]
        )
    return m, {
        "json": parsed_json,
        "stdout": out,
        "stderr": err,
        "exit_code": m["exit_code"],
        "argv": m["argv"],
        "elapsed_ms": m["elapsed_ms"],
        "metrics": m["metrics"],
    }


def assertion(root, check):
    if "record" in check:
        _, value = read_record(root, check["record"])
    elif "artifact" in check:
        p = within(root, check["artifact"])
        if check.get("op") == "file_nonempty":
            return p.is_file() and p.stat().st_size > 0
        if check.get("op") == "sha256":
            return digest(p) == check["value"]
        value = load(p)
    else:
        raise ValueError("Check needs a raw Bsk record or an evidence artifact")
    value = pointer(value, check.get("pointer", ""))
    expected = check.get("value")
    op = check["op"]
    if op == "eq":
        return type(value) == type(expected) and value == expected
    if op == "ne":
        return value != expected
    if op == "contains":
        return expected in value
    if op == "regex":
        return isinstance(value, str) and bool(re.search(expected, value))
    if op == "len_eq":
        return len(value) == expected
    if op in ("gt", "gte", "lt", "lte"):
        if (
            isinstance(value, bool)
            or isinstance(expected, bool)
            or not isinstance(value, (int, float))
            or not isinstance(expected, (int, float))
        ):
            return False
    if op == "gt":
        return value > expected
    if op == "gte":
        return value >= expected
    if op == "lt":
        return value < expected
    if op == "lte":
        return value <= expected
    if op == "is_string":
        return isinstance(value, str) and bool(value)
    if op == "not_contains":
        return expected not in value
    raise ValueError("Unknown assertion " + op)


def result(args):
    root = Path(args.run).resolve()
    value = load(args.file)
    plan = load(root / "plan.json")["cases"]
    if value.get("id") not in {c["id"] for c in plan}:
        raise ValueError("Result is outside plan")
    results = load(root / "results.json")["cases"]
    if any(x["id"] == value["id"] for x in results):
        raise ValueError(
            "Result already recorded; preserve it and use a fresh full round for release approval"
        )
    value["recorded_at"] = now()
    results.append(value)
    write(root / "results.json", {"cases": results})
    print(value["id"] + " recorded; final gate still required")


def compute_run_benchmark(root, passed_ids=None):
    root = Path(root).resolve()
    cfg = load(root / "run.json")
    planned = load(root / "plan.json")["cases"]
    results = load(root / "results.json")["cases"]
    result_map = {r["id"]: r for r in results if isinstance(r, dict) and "id" in r}
    if passed_ids is None:
        gate_path = root / "gate.json"
        if gate_path.exists():
            gate_data = load(gate_path)
            if isinstance(gate_data.get("passed_ids"), list):
                passed_set = set(gate_data["passed_ids"])
            else:
                passed_set = {
                    r["id"]
                    for r in results
                    if isinstance(r, dict) and r.get("status") == "passed"
                }
        else:
            passed_set = {
                r["id"]
                for r in results
                if isinstance(r, dict) and r.get("status") == "passed"
            }
    else:
        passed_set = set(passed_ids)

    case_benchmarks = []
    mode_buckets = {}
    command_latencies = {}
    run_starts = []
    run_finishes = []

    for c in planned:
        cid = c["id"]
        kind = c.get("kind", "workflow")
        page_type = c.get("page_type", "unspecified")
        is_negative = bool(c.get("negative"))
        r = result_map.get(cid)
        status = (
            "passed"
            if cid in passed_set
            else (r.get("status", "missing") if r else "missing")
        )
        records = r.get("records", []) if isinstance(r, dict) else []
        metas_and_values = []
        for rid in records:
            try:
                metas_and_values.append(read_record(root, rid))
            except (ValueError, KeyError, OSError):
                continue

        turns = 0
        actions = 0
        rpc_calls = 0
        browser_calls = 0
        sync_count = 0
        reused_count = 0
        vom_chars = 0
        cmd_elapsed = []
        c_starts = []
        c_finishes = []

        for m, v in metas_and_values:
            metrics = m.get("metrics") or {}
            el = float(m.get("elapsed_ms", 0.0))
            cmd_elapsed.append(el)
            t = int(metrics.get("interaction_turns", 1))
            act = int(metrics.get("actions_executed", 0))
            turns += t
            actions += act
            rpc_calls += int(metrics.get("rpc_calls", 1))
            browser_calls += int(metrics.get("browser_calls", 1))
            vom_chars += int(metrics.get("vom_chars", 0))
            if m.get("command") in ("cooperate sync", "sync") or metrics.get(
                "observation_kind"
            ):
                sync_count += 1
            if metrics.get("observation_reused"):
                reused_count += 1

            s_ms = parse_iso_ms(m.get("started"))
            f_ms = parse_iso_ms(m.get("finished"))
            if s_ms is not None:
                c_starts.append(s_ms)
                run_starts.append(s_ms)
            if f_ms is not None:
                c_finishes.append(f_ms)
                run_finishes.append(f_ms)

            cmd_ok = (
                m.get("exit_code") == 0
                and not m.get("timed_out")
                and not semantic_failure(m, v)
            )
            # Only count each distinct command invocation once in global mode/command buckets
            # (workflow cases vs CMD-* cases may reference the same record UUID).
            # Intentional negative guardrail rejections are tracked in `negative_guard_invocations`
            # rather than diluting positive mode compression/latency/success_rate.
            mode = metrics.get("execution_mode", "other")
            bucket = mode_buckets.setdefault(
                mode,
                {
                    "records": set(),
                    "neg_records": set(),
                    "turns": 0,
                    "actions": 0,
                    "success": 0,
                    "latencies": [],
                },
            )
            if is_negative and not cmd_ok:
                bucket["neg_records"].add(m["id"])
            elif m["id"] not in bucket["records"]:
                bucket["records"].add(m["id"])
                bucket["turns"] += 1
                bucket["actions"] += act
                if cmd_ok:
                    bucket["success"] += 1
                bucket["latencies"].append(el)

            cname = m.get("command") or "unknown"
            cb = command_latencies.setdefault(
                cname, {"records": set(), "latencies": [], "success": 0}
            )
            if m["id"] not in cb["records"]:
                cb["records"].add(m["id"])
                cb["latencies"].append(el)
                if cmd_ok or (is_negative and cid in passed_set):
                    cb["success"] += 1

        total_el = round(sum(cmd_elapsed), 2)
        wall_el = (
            round(max(0.0, max(c_finishes) - min(c_starts)), 2)
            if c_starts and c_finishes
            else total_el
        )
        turn_stats = stats_summary(cmd_elapsed)
        case_benchmarks.append(
            {
                "id": cid,
                "kind": kind,
                "page_type": page_type,
                "status": status,
                "passed": cid in passed_set,
                "records_count": len(metas_and_values),
                "interaction_turns": turns,
                "actions_executed": actions,
                "turn_compression_ratio": round(actions / turns, 2) if turns > 0 else 0.0,
                "rpc_calls": rpc_calls,
                "browser_calls": browser_calls,
                "sync_count": sync_count,
                "reused_observations": reused_count,
                "vom_chars": vom_chars,
                "elapsed_ms": total_el,
                "wall_elapsed_ms": wall_el,
                "avg_turn_ms": turn_stats["mean"],
                "p50_turn_ms": turn_stats["p50"],
                "p95_turn_ms": turn_stats["p95"],
                "max_turn_ms": turn_stats["max"],
            }
        )

    workflows = [c for c in case_benchmarks if c["kind"] != "command"]
    commands_only = [c for c in case_benchmarks if c["kind"] == "command"]

    page_type_benchmarks = {}
    for c in workflows:
        pt = c["page_type"]
        b = page_type_benchmarks.setdefault(
            pt,
            {
                "required": 0,
                "passed": 0,
                "interaction_turns": 0,
                "actions_executed": 0,
                "elapsed_ms": 0.0,
                "case_latencies": [],
            },
        )
        b["required"] += 1
        b["passed"] += int(c["passed"])
        b["interaction_turns"] += c["interaction_turns"]
        b["actions_executed"] += c["actions_executed"]
        b["elapsed_ms"] = round(b["elapsed_ms"] + c["elapsed_ms"], 2)
        b["case_latencies"].append(c["elapsed_ms"])

    for pt, b in page_type_benchmarks.items():
        req = b["required"]
        b["success_rate"] = round(b["passed"] / req, 4) if req else 0.0
        b["avg_turns_per_case"] = round(b["interaction_turns"] / req, 2) if req else 0.0
        b["avg_case_elapsed_ms"] = round(b["elapsed_ms"] / req, 2) if req else 0.0
        b["p95_case_elapsed_ms"] = percentile(b.pop("case_latencies"), 0.95)

    mode_summary = {}
    for mode, b in sorted(mode_buckets.items()):
        t_count = b["turns"]
        a_count = b["actions"]
        lat = stats_summary(b["latencies"])
        mode_summary[mode] = {
            "invocations": t_count,
            "negative_guard_invocations": len(b["neg_records"] - b["records"]),
            "success_count": b["success"],
            "success_rate": round(b["success"] / t_count, 4) if t_count else 0.0,
            "actions_executed": a_count,
            "avg_actions_per_turn": round(a_count / t_count, 2) if t_count else 0.0,
            "total_elapsed_ms": lat["total"],
            "avg_ms_per_turn": lat["mean"],
            "avg_ms_per_action": round(lat["total"] / a_count, 2) if a_count else 0.0,
            "p50_ms": lat["p50"],
            "p95_ms": lat["p95"],
        }

    command_summary = {}
    for cname, b in sorted(command_latencies.items()):
        cnt = len(b["records"])
        lat = stats_summary(b["latencies"])
        command_summary[cname] = {
            "invocations": cnt,
            "success_rate": round(b["success"] / cnt, 4) if cnt else 0.0,
            "mean_ms": lat["mean"],
            "p50_ms": lat["p50"],
            "p95_ms": lat["p95"],
            "total_ms": lat["total"],
        }

    distinct_records = {}
    for p in (root / "commands").glob("*/meta.json"):
        try:
            m, _ = read_record(root, p.parent.name)
            distinct_records[m["id"]] = m
            s_ms = parse_iso_ms(m.get("started"))
            f_ms = parse_iso_ms(m.get("finished"))
            if s_ms is not None:
                run_starts.append(s_ms)
            if f_ms is not None:
                run_finishes.append(f_ms)
        except (ValueError, KeyError, OSError):
            continue

    total_turns = sum(
        int((m.get("metrics") or {}).get("interaction_turns", 1))
        for m in distinct_records.values()
    )
    total_actions = sum(
        int((m.get("metrics") or {}).get("actions_executed", 0))
        for m in distinct_records.values()
    )
    total_cmd_ms = round(
        sum(float(m.get("elapsed_ms", 0.0)) for m in distinct_records.values()), 2
    )
    wall_run_ms = (
        round(max(0.0, max(run_finishes) - min(run_starts)), 2)
        if run_starts and run_finishes
        else total_cmd_ms
    )

    return {
        "schema_version": 1,
        "generated_at": now(),
        "candidate": cfg.get("candidate"),
        "browser": cfg.get("browser"),
        "summary": {
            "total_cases": len(planned),
            "passed_cases": len(passed_set),
            "success_rate": round(len(passed_set) / len(planned), 4) if planned else 0.0,
            "workflow_cases": len(workflows),
            "workflow_passed": sum(int(c["passed"]) for c in workflows),
            "workflow_success_rate": (
                round(sum(int(c["passed"]) for c in workflows) / len(workflows), 4)
                if workflows
                else 0.0
            ),
            "command_cases": len(commands_only),
            "command_passed": sum(int(c["passed"]) for c in commands_only),
            "distinct_command_invocations": len(distinct_records),
            "total_interaction_turns": total_turns,
            "total_actions_executed": total_actions,
            "overall_turn_compression": (
                round(total_actions / total_turns, 2) if total_turns > 0 else 0.0
            ),
            "total_command_elapsed_ms": total_cmd_ms,
            "wall_elapsed_ms": wall_run_ms,
            "turn_latency_ms": stats_summary(
                [m.get("elapsed_ms", 0.0) for m in distinct_records.values()]
            ),
            "workflow_case_latency_ms": stats_summary([c["elapsed_ms"] for c in workflows]),
        },
        "execution_modes": mode_summary,
        "page_types": page_type_benchmarks,
        "commands": command_summary,
        "cases": case_benchmarks,
    }


def render_benchmark_markdown(bench):
    s = bench["summary"]
    lines = [
        f"# BrowserSkill Release Benchmark Report (`{bench.get('candidate', 'unknown')}`)",
        "",
        "## 1. 总体指标 (Overall Summary)",
        "",
        "| 指标 | 数值 |",
        "| --- | --- |",
        f"| 总用例通过率 (`success_rate`) | **{s['passed_cases']} / {s['total_cases']} ({s['success_rate'] * 100:.1f}%)** |",
        f"| 真实场景工作流通过率 (`workflow_success_rate`) | **{s['workflow_passed']} / {s['workflow_cases']} ({s['workflow_success_rate'] * 100:.1f}%)** |",
        f"| 总交互轮次 (`total_interaction_turns`) | {s['total_interaction_turns']} turns |",
        f"| 总执行浏览器动作数 (`total_actions_executed`) | {s['total_actions_executed']} actions |",
        f"| 整体轮次压缩比 (`actions / turn`) | {s['overall_turn_compression']:.2f}x |",
        f"| 命令累计执行耗时 (`total_command_elapsed_ms`) | {s['total_command_elapsed_ms']:.2f} ms |",
        f"| 端到端总墙钟耗时 (`wall_elapsed_ms`) | {s['wall_elapsed_ms']:.2f} ms |",
        f"| 单次交互耗时 (Mean / P50 / P95) | {s['turn_latency_ms']['mean']:.1f} / {s['turn_latency_ms']['p50']:.1f} / {s['turn_latency_ms']['p95']:.1f} ms |",
        "",
        "## 2. 执行模式对比 (`single_action` vs `step` vs `plan` vs `recipe`)",
        "",
        "| 模式 | 调用次数 (Turns) | 成功率 | 完成动作数 | 每轮动作数 (`actions/turn`) | 平均单轮耗时 (ms) | 平均单动作耗时 (ms) | P95 耗时 (ms) |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]
    for mode, m in bench.get("execution_modes", {}).items():
        lines.append(
            f"| `{mode}` | {m['invocations']} | {m['success_rate'] * 100:.1f}% | {m['actions_executed']} | {m['avg_actions_per_turn']:.2f} | {m['avg_ms_per_turn']:.1f} | {m['avg_ms_per_action']:.1f} | {m['p95_ms']:.1f} |"
        )
    lines.extend(
        [
            "",
            "## 3. 按场景类别统计 (Page Type Breakdown)",
            "",
            "| 场景类别 (`page_type`) | 通过 / 必测 | 成功率 | 总交互轮次 | 总动作数 | 平均每场景轮次 | 平均场景耗时 (ms) | P95 场景耗时 (ms) |",
            "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
        ]
    )
    for pt, p in sorted(bench.get("page_types", {}).items()):
        lines.append(
            f"| `{pt}` | {p['passed']} / {p['required']} | {p['success_rate'] * 100:.1f}% | {p['interaction_turns']} | {p['actions_executed']} | {p['avg_turns_per_case']:.1f} | {p['avg_case_elapsed_ms']:.1f} | {p['p95_case_elapsed_ms']:.1f} |"
        )
    lines.extend(
        [
            "",
            "## 4. 重点工作流场景明细 (Workflow Scenarios)",
            "",
            "| Case ID | 类别 | 状态 | 交互轮次 | 动作数 | 轮次压缩比 | 累计耗时 (ms) | P95 单轮耗时 (ms) |",
            "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |",
        ]
    )
    for c in bench.get("cases", []):
        if c.get("kind") == "command":
            continue
        lines.append(
            f"| `{c['id']}` | `{c['page_type']}` | `{c['status']}` | {c['interaction_turns']} | {c['actions_executed']} | {c['turn_compression_ratio']:.2f}x | {c['elapsed_ms']:.1f} | {c['p95_turn_ms']:.1f} |"
        )
    return "\n".join(lines) + "\n"


def aggregate_multi_run_benchmarks(roots):
    run_benchmarks = []
    for r in roots:
        root = Path(r).resolve()
        b_path = root / "benchmark.json"
        if b_path.exists():
            run_benchmarks.append(load(b_path))
        else:
            run_benchmarks.append(compute_run_benchmark(root))

    if not run_benchmarks:
        raise ValueError("No benchmark runs supplied")

    case_Rollup = {}
    mode_Rollup = {}
    for rb in run_benchmarks:
        for c in rb.get("cases", []):
            cid = c["id"]
            entry = case_Rollup.setdefault(
                cid,
                {
                    "id": cid,
                    "kind": c.get("kind", "workflow"),
                    "page_type": c.get("page_type", "unspecified"),
                    "runs": 0,
                    "passes": 0,
                    "turns": [],
                    "actions": [],
                    "elapsed_ms": [],
                },
            )
            entry["runs"] += 1
            entry["passes"] += int(bool(c.get("passed")))
            entry["turns"].append(c.get("interaction_turns", 0))
            entry["actions"].append(c.get("actions_executed", 0))
            entry["elapsed_ms"].append(c.get("elapsed_ms", 0.0))

        for mode, m in rb.get("execution_modes", {}).items():
            me = mode_Rollup.setdefault(
                mode,
                {"invocations": 0, "success_count": 0, "actions": 0, "total_ms": 0.0},
            )
            me["invocations"] += m.get("invocations", 0)
            me["success_count"] += m.get("success_count", 0)
            me["actions"] += m.get("actions_executed", 0)
            me["total_ms"] = round(me["total_ms"] + m.get("total_elapsed_ms", 0.0), 2)

    cases_summary = []
    for cid, e in case_Rollup.items():
        lat = stats_summary(e["elapsed_ms"])
        t_stat = stats_summary(e["turns"])
        a_stat = stats_summary(e["actions"])
        cases_summary.append(
            {
                "id": cid,
                "kind": e["kind"],
                "page_type": e["page_type"],
                "runs": e["runs"],
                "passes": e["passes"],
                "pass_rate": round(e["passes"] / e["runs"], 4) if e["runs"] else 0.0,
                "mean_turns": t_stat["mean"],
                "mean_actions": a_stat["mean"],
                "mean_elapsed_ms": lat["mean"],
                "p50_elapsed_ms": lat["p50"],
                "p95_elapsed_ms": lat["p95"],
                "min_elapsed_ms": lat["min"],
                "max_elapsed_ms": lat["max"],
            }
        )

    modes_summary = {}
    for mode, me in sorted(mode_Rollup.items()):
        inv = me["invocations"]
        act = me["actions"]
        modes_summary[mode] = {
            "invocations": inv,
            "success_rate": round(me["success_count"] / inv, 4) if inv else 0.0,
            "actions_executed": act,
            "avg_actions_per_turn": round(act / inv, 2) if inv else 0.0,
            "avg_ms_per_turn": round(me["total_ms"] / inv, 2) if inv else 0.0,
            "avg_ms_per_action": round(me["total_ms"] / act, 2) if act else 0.0,
        }

    run_rates = [rb["summary"]["success_rate"] for rb in run_benchmarks]
    wf_rates = [rb["summary"]["workflow_success_rate"] for rb in run_benchmarks]
    run_turns = [rb["summary"]["total_interaction_turns"] for rb in run_benchmarks]
    run_actions = [rb["summary"]["total_actions_executed"] for rb in run_benchmarks]
    run_elapsed = [rb["summary"]["total_command_elapsed_ms"] for rb in run_benchmarks]

    return {
        "schema_version": 1,
        "generated_at": now(),
        "runs_count": len(run_benchmarks),
        "candidates": [rb.get("candidate") for rb in run_benchmarks],
        "summary": {
            "runs_count": len(run_benchmarks),
            "full_pass_runs": sum(1 for r in run_rates if r == 1.0),
            "mean_success_rate": round(sum(run_rates) / len(run_rates), 4),
            "mean_workflow_success_rate": round(sum(wf_rates) / len(wf_rates), 4),
            "interaction_turns": stats_summary(run_turns),
            "actions_executed": stats_summary(run_actions),
            "command_elapsed_ms": stats_summary(run_elapsed),
        },
        "execution_modes": modes_summary,
        "cases": cases_summary,
    }


def render_multi_run_markdown(agg):
    s = agg["summary"]
    lines = [
        f"# BrowserSkill Multi-Run Benchmark Report ({agg['runs_count']} Runs)",
        "",
        "## 1. 跨轮次汇总指标 (Multi-Run Summary)",
        "",
        "| 指标 | 数值 |",
        "| --- | --- |",
        f"| 统计轮次数 (`runs_count`) | {s['runs_count']} |",
        f"| 全量 100% 通过轮次数 (`full_pass_runs`) | {s['full_pass_runs']} / {s['runs_count']} |",
        f"| 平均总通过率 (`mean_success_rate`) | **{s['mean_success_rate'] * 100:.2f}%** |",
        f"| 平均工作流通过率 (`mean_workflow_success_rate`) | **{s['mean_workflow_success_rate'] * 100:.2f}%** |",
        f"| 平均每轮总交互轮次 (`interaction_turns`) | {s['interaction_turns']['mean']:.1f} (P50: {s['interaction_turns']['p50']:.1f}, P95: {s['interaction_turns']['p95']:.1f}) |",
        f"| 平均每轮总动作数 (`actions_executed`) | {s['actions_executed']['mean']:.1f} |",
        f"| 平均每轮累计耗时 (`command_elapsed_ms`) | {s['command_elapsed_ms']['mean']:.1f} ms (P50: {s['command_elapsed_ms']['p50']:.1f}, P95: {s['command_elapsed_ms']['p95']:.1f}) |",
        "",
        "## 2. 执行模式跨轮次效率 (`execution_modes`)",
        "",
        "| 模式 | 累计调用 (Turns) | 成功率 | 累计动作数 | 每轮动作数 | 平均每轮耗时 (ms) | 平均每动作耗时 (ms) |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]
    for mode, m in agg.get("execution_modes", {}).items():
        lines.append(
            f"| `{mode}` | {m['invocations']} | {m['success_rate'] * 100:.1f}% | {m['actions_executed']} | {m['avg_actions_per_turn']:.2f} | {m['avg_ms_per_turn']:.1f} | {m['avg_ms_per_action']:.1f} |"
        )
    lines.extend(
        [
            "",
            "## 3. 各场景运行成功率、交互轮次与耗时分布",
            "",
            "| Case ID | 类别 | 运行次数 | 成功率 (`pass_rate`) | 平均交互轮次 | 平均动作数 | 平均耗时 (ms) | P50 耗时 (ms) | P95 耗时 (ms) |",
            "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
        ]
    )
    for c in agg.get("cases", []):
        if c.get("kind") == "command":
            continue
        lines.append(
            f"| `{c['id']}` | `{c['page_type']}` | {c['runs']} | {c['pass_rate'] * 100:.1f}% | {c['mean_turns']:.1f} | {c['mean_actions']:.1f} | {c['mean_elapsed_ms']:.1f} | {c['p50_elapsed_ms']:.1f} | {c['p95_elapsed_ms']:.1f} |"
        )
    return "\n".join(lines) + "\n"


def gate(root):
    root = Path(root).resolve()
    cfg = load(root / "run.json")
    inv = load(root / "inventory.json")
    planned = load(root / "plan.json")["cases"]
    results = load(root / "results.json")["cases"]
    errors = []
    passed = []
    covered = set()
    negative_records = set()
    intermediate_records = set()
    case_coverage = {}
    if digest(cfg["bsk"]) != cfg["entry_sha256"]:
        errors.append("Bsk entry changed")
    if digest(cfg["binary"]) != cfg["binary_sha256"]:
        errors.append("Bsk binary changed")
    if digest(root / "inventory.json") != cfg["inventory_sha256"]:
        errors.append("Command inventory changed")
    if digest(root / "plan.json") != cfg["plan_sha256"]:
        errors.append("Required plan changed")
    for doc in inv["help_documents"]:
        if digest(within(root, "help/" + doc["path"])) != doc["sha256"]:
            errors.append("Help evidence changed: " + doc["command"])
    ids = [x["id"] for x in planned]
    baseline = load(SKILL / "references/scenarios.json")
    if len(set(ids)) != len(ids):
        errors.append("Duplicate plan case ID")
    for original in baseline:
        current = next((x for x in planned if x["id"] == original["id"]), None)
        if current != original:
            errors.append("Required scenario removed/changed: " + original["id"])
    required_commands = set(inv["commands"])
    if {
        x.get("command") for x in planned if x.get("kind") == "command"
    } != required_commands:
        errors.append("Command plan differs from discovered inventory")
    if len({x["id"] for x in results}) != len(results):
        errors.append("Duplicate result ID")
    if {x["id"] for x in results} - set(ids):
        errors.append("Result outside plan")
    for c in planned:
        candidates = [x for x in results if x.get("id") == c["id"]]
        if len(candidates) != 1:
            errors.append(c["id"] + ": missing result")
            continue
        r = candidates[0]
        if r.get("status") != "passed":
            errors.append(c["id"] + ": " + str(r.get("status", "unverified")))
            continue
        try:
            records = r.get("records", [])
            if not records or not r.get("checks") or not r.get("oracle_summary"):
                raise ValueError("No command/check/business oracle")
            if not any(
                x.get("record") in records
                and x.get("pointer", "").startswith(("/json", "/stdout", "/stderr"))
                for x in r["checks"]
            ):
                raise ValueError("No raw output assertion")
            metas = [read_record(root, k)[0] for k in records]
            for m in metas:
                if (
                    m["bsk"] != cfg["bsk"]
                    or m["entry_sha256"] != cfg["entry_sha256"]
                    or m["backend"] != "bsk"
                ):
                    raise ValueError("Mixed executable/backend")
                if m.get("binary_sha256") != cfg["binary_sha256"]:
                    raise ValueError("Mixed candidate binary")
                if m["timed_out"]:
                    raise ValueError("Outer execution timeout")
                if m["command"] != canonical(m["argv"], inv["commands"]):
                    raise ValueError("Command identity mismatch")
            actual = {m["command"] for m in metas if m["command"]}
            if len(set(records)) != len(records):
                raise ValueError("Duplicate command record in result")
            if any(x.get("record") and x["record"] not in records for x in r["checks"]):
                raise ValueError("Check references a record outside this result")
            if not set(c.get("required_commands", [])).issubset(actual):
                raise ValueError("Required commands not executed")
            for cmd, minimum in c.get("required_command_counts", {}).items():
                count = sum(m["command"] == cmd and m["exit_code"] == 0 for m in metas)
                if count < minimum:
                    raise ValueError(
                        "Insufficient actual calls for "
                        + cmd
                        + ": "
                        + str(count)
                        + "/"
                        + str(minimum)
                    )
            for variant in c.get("required_argv", []):
                if not any(
                    m["command"] == variant["command"]
                    and all(a in m["argv"] for a in variant["args"])
                    for m in metas
                ):
                    raise ValueError("Missing argument variant " + str(variant))
            if c.get("negative"):
                if not any(m["exit_code"] != 0 for m in metas) and not c.get(
                    "allow_zero_rejection"
                ):
                    raise ValueError("Negative test unexpectedly succeeded")
                # A rejection needs reason/effect assertions, not a bare nonzero exit.
                pointers = {
                    x.get("pointer") for x in r["checks"] if x.get("record") in records
                }
                allowed_error_pointers = {"/json/code"}
                if c.get("allow_plan_stopped"):
                    allowed_error_pointers.update(
                        {
                            "/json/stopped/error/code",
                            "/json/stopped/reason",
                            "/stderr",
                        }
                    )
                if c.get("allow_recipe_handoff") or c.get("allow_recipe_refusal"):
                    allowed_error_pointers.update(
                        {
                            "/json/status",
                            "/json/reason",
                            "/json/saved",
                            "/stderr",
                        }
                    )
                if c.get("allow_zero_rejection"):
                    if not any(
                        x.get("pointer") in ["/json/satisfied", "/json/data/satisfied"]
                        and x.get("op") == "eq"
                        and x.get("value") is False
                        for x in r["checks"]
                    ):
                        raise ValueError("No unsatisfied-wait assertion")
                elif not (pointers & allowed_error_pointers):
                    raise ValueError("Negative test has no error-code assertion")
                allowed_effect_pointers = {
                    "/json/data/effect_state",
                    "/json/stopped/effect_state",
                    "/json/effects/last_effect_state",
                }
                if c.get("check_effect", True) and not (
                    pointers & allowed_effect_pointers
                ):
                    raise ValueError("Negative test has no effect-state assertion")
            else:
                pending = set(r.get("intermediate_records", []))
                if pending and not c.get("allow_dialog_pending"):
                    raise ValueError("Intermediate results not allowed for this case")
                if not pending.issubset(records):
                    raise ValueError("Unknown intermediate record")
                for m in metas:
                    if m["exit_code"] == 0:
                        _, v = read_record(root, m["id"])
                        issue = semantic_failure(m, v)
                        if issue:
                            raise ValueError(issue)
                        continue
                    if m["id"] not in pending:
                        raise ValueError(
                            "Unexpected nonzero exit; recovery does not erase failure"
                        )
                    _, v = read_record(root, m["id"])
                    if pointer(v, "/json/code") != "dialog_pending":
                        raise ValueError(
                            "Only documented dialog_pending is a resumable intermediate result"
                        )
                    if not any(
                        x.get("record") == m["id"]
                        and x.get("pointer") == "/json/code"
                        and x.get("op") == "eq"
                        and x.get("value") == "dialog_pending"
                        for x in r["checks"]
                    ):
                        raise ValueError("Missing intermediate assertion")
            if not all(assertion(root, x) for x in r["checks"]):
                raise ValueError("Oracle assertion failed")
            if c.get("negative"):
                negative_records.update(records)
                # For commands executed inside a negative case that succeeded as setup
                # steps (exit_code == 0 and no semantic failure), allow them to count.
                for m in metas:
                    if m["exit_code"] == 0 and m["command"]:
                        _, v = read_record(root, m["id"])
                        if not semantic_failure(m, v):
                            covered.add(m["command"])
            else:
                intermediate_records.update(r.get("intermediate_records", []))
                covered.update(
                    m["command"] for m in metas if m["exit_code"] == 0 and m["command"]
                )
            passed.append(c["id"])
            case_coverage[c["id"]] = sorted(actual)
        except (ValueError, KeyError, IndexError, TypeError, OSError) as e:
            errors.append(c["id"] + ": " + str(e))
    # Every started command must settle, and every unexpected failure blocks the round.
    for p in (root / "commands").glob("*/started.json"):
        if not (p.parent / "meta.json").exists():
            errors.append("Unfinished command " + p.parent.name)
            continue
        try:
            m, v = read_record(root, p.parent.name)
            if m["timed_out"] or (
                m["exit_code"] != 0
                and m["id"] not in negative_records | intermediate_records
            ):
                errors.append("Unresolved failed invocation " + m["id"])
            if m[
                "id"
            ] not in negative_records | intermediate_records and semantic_failure(m, v):
                errors.append(
                    "Unresolved business failure "
                    + m["id"]
                    + ": "
                    + semantic_failure(m, v)
                )
        except (ValueError, KeyError, OSError) as e:
            errors.append(str(e))
    missing = sorted(required_commands - covered)
    if missing:
        errors.append("Uncovered commands: " + ", ".join(missing))
    workflows = [c for c in planned if c.get("kind") != "command"]
    types = {}
    for c in workflows:
        key = c.get("page_type", "unspecified")
        types.setdefault(key, {"passed": 0, "required": 0})
        types[key]["required"] += 1
        types[key]["passed"] += int(c["id"] in passed)

    bench = compute_run_benchmark(root, passed_ids=passed)
    write(root / "benchmark.json", bench)
    (root / "benchmark.md").write_text(
        render_benchmark_markdown(bench), encoding="utf-8"
    )

    report = {
        "generated_at": now(),
        "release_ready": not errors and len(passed) == len(planned),
        "candidate": cfg["candidate"],
        "passed": len(passed),
        "passed_ids": passed,
        "required": len(planned),
        "success_rate": len(passed) / len(planned) if planned else 0,
        "command_coverage": (
            len(required_commands & covered) / len(required_commands)
            if required_commands
            else 0
        ),
        "workflow_success_rate": (
            sum(c["id"] in passed for c in workflows) / len(workflows)
            if workflows
            else 0
        ),
        "page_type_results": types,
        "page_type_coverage": (
            sum(v["passed"] == v["required"] for v in types.values()) / len(types)
            if types
            else 0
        ),
        "benchmark_summary": bench["summary"],
        "execution_modes": bench["execution_modes"],
        "uncovered_commands": missing,
        "errors": errors,
        "case_commands": case_coverage,
        "note": "Evidence/contract gate, not a substitute for inspecting the correctness of business and visual oracles.",
    }
    write(root / "gate.json", report)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["release_ready"] else 1


def benchmark_cmd(args):
    runs = list(args.run or [])
    if args.runs_dir:
        base = Path(args.runs_dir).expanduser().resolve()
        for child in sorted(base.iterdir()):
            if child.is_dir() and (child / "run.json").exists():
                runs.append(str(child))
    if not runs:
        raise ValueError("Supply --run <dir> [more dirs...] or --runs-dir <dir>")
    if len(runs) == 1:
        root = Path(runs[0]).expanduser().resolve()
        bench = compute_run_benchmark(root)
        md = render_benchmark_markdown(bench)
        write(root / "benchmark.json", bench)
        (root / "benchmark.md").write_text(md, encoding="utf-8")
    else:
        bench = aggregate_multi_run_benchmarks(runs)
        md = render_multi_run_markdown(bench)
    if args.out:
        write(Path(args.out).expanduser().resolve(), bench)
    if args.markdown:
        md_path = Path(args.markdown).expanduser().resolve()
        md_path.parent.mkdir(parents=True, exist_ok=True)
        md_path.write_text(md, encoding="utf-8")
    print(json.dumps(bench, ensure_ascii=False, indent=2))
    return 0


def main():
    p = argparse.ArgumentParser(description=__doc__)
    subs = p.add_subparsers(dest="action", required=True)
    q = subs.add_parser("init")
    q.add_argument("--out", required=True)
    q.add_argument("--bsk", required=True)
    q.add_argument("--binary", help="Actual compiled binary if --bsk is a wrapper")
    q.add_argument("--browser", required=True)
    q.add_argument("--candidate", required=True)
    q.add_argument("--port", type=int, default=4187)
    q = subs.add_parser("exec")
    q.add_argument("--run", required=True)
    q.add_argument("--case", required=True)
    q.add_argument("--timeout", type=int, default=60)
    q.add_argument("--lane", choices=["browser", "admin"], default="browser")
    q.add_argument(
        "--env",
        action="append",
        default=[],
        help="Optional KEY=VALUE environment override for negative or experimental tests",
    )
    q.add_argument(
        "--stdin-file", help="Run-relative input for stdio MCP or interactive CLI"
    )
    q.add_argument(
        "--interactive",
        action="store_true",
        help="Forward stdin to Bsk, saving its protocol transcript; use a managed PTY",
    )
    q.add_argument("argv", nargs=argparse.REMAINDER)
    q = subs.add_parser("result")
    q.add_argument("--run", required=True)
    q.add_argument("--file", required=True)
    q = subs.add_parser("gate")
    q.add_argument("--run", required=True)
    q = subs.add_parser("benchmark")
    q.add_argument("--run", nargs="*", help="One or more run directories to benchmark")
    q.add_argument("--runs-dir", help="Directory containing multiple run subdirectories")
    q.add_argument("--out", help="Optional path to write benchmark JSON")
    q.add_argument("--markdown", help="Optional path to write Markdown benchmark report")
    a = p.parse_args()
    if a.action == "init":
        init(a)
        return 0
    if a.action == "exec":
        return execute(a)
    if a.action == "result":
        result(a)
        return 0
    if a.action == "benchmark":
        return benchmark_cmd(a)
    return gate(a.run)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValueError, OSError, subprocess.SubprocessError) as e:
        print(str(e), file=sys.stderr)
        sys.exit(2)
