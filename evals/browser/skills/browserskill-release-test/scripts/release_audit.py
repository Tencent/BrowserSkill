#!/usr/bin/env python3
"""Bsk-only execution ledger and fail-closed release gate. Standard library only."""

import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import threading
import uuid

SKILL = Path(__file__).resolve().parents[1]


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat()


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

    def visit(parts):
        key = " ".join(parts)
        if key in seen:
            return
        seen.add(key)
        r = subprocess.run(
            [bsk, *parts, "--help"], capture_output=True, text=True, timeout=20
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


def semantic_failure(meta, value):
    cmd = meta["command"]
    j = value.get("json")
    if cmd in ["evaluate", "step", "wait-for-element"]:
        if not isinstance(j, dict):
            return "Machine-readable result required for " + cmd
        if cmd in ["evaluate", "step"] and j.get("ok") is not True:
            return cmd + " did not return ok:true"
        if cmd == "wait-for-element" and j.get("satisfied") is not True:
            return "Wait condition was not satisfied"
    if (
        cmd in ["navigate", "wait-for-navigation"]
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
        "schema_version": 1,
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
            "https://developer.mozilla.org/zh-CN/",
            "https://github.com/Tencent/BrowserSkill",
            "https://books.toscrape.com/",
            "https://news.ycombinator.com/",
        ],
    }
    write(out / "run.json", config)
    write(out / "plan.json", {"schema_version": 1, "cases": cases})
    config.update(
        inventory_sha256=digest(out / "inventory.json"),
        plan_sha256=digest(out / "plan.json"),
    )
    write(out / "run.json", config)
    assets = SKILL / "assets/fixtures"
    target = out / "fixtures"
    shutil.copytree(assets, target)
    for p in target.glob("*.html"):
        p.write_text(
            p.read_text().replace("localhost:4187", f"localhost:{args.port}"),
            encoding="utf-8",
        )
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
    env = dict(os.environ, BSK_AUTO_START="0", BSK_AUTO_UPDATE="off")
    exe = cfg["bsk"]
    if args.lane == "admin":
        exe = cfg["binary"]
        env["BSK_HOME"] = str(root / "admin-runtime")
    stdin_path = within(root, args.stdin_file) if args.stdin_file else None
    # No implicit context, tab, session, browser, retries, or argument repair.
    meta = {
        "id": record_id,
        "case_id": args.case,
        "argv": argv,
        "command": canonical(argv, inv["commands"]),
        "started": now(),
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
    meta.update(
        finished=now(),
        exit_code=code,
        timed_out=timed_out,
        stdout_sha256=digest(folder / "stdout.txt"),
        stderr_sha256=digest(folder / "stderr.txt"),
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
    return m, {
        "json": parse(out.strip() or err.strip()),
        "stdout": out,
        "stderr": err,
        "exit_code": m["exit_code"],
        "argv": m["argv"],
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
    if op == "gt":
        return value > expected
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
                if c.get("allow_zero_rejection"):
                    if not any(
                        x.get("pointer") in ["/json/satisfied", "/json/data/satisfied"]
                        and x.get("op") == "eq"
                        and x.get("value") is False
                        for x in r["checks"]
                    ):
                        raise ValueError("No unsatisfied-wait assertion")
                elif "/json/code" not in pointers:
                    raise ValueError("Negative test has no error-code assertion")
                if (
                    c.get("check_effect", True)
                    and "/json/data/effect_state" not in pointers
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
    report = {
        "generated_at": now(),
        "release_ready": not errors and len(passed) == len(planned),
        "candidate": cfg["candidate"],
        "passed": len(passed),
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
        "uncovered_commands": missing,
        "errors": errors,
        "case_commands": case_coverage,
        "note": "Evidence/contract gate, not a substitute for inspecting the correctness of business and visual oracles.",
    }
    write(root / "gate.json", report)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["release_ready"] else 1


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
    a = p.parse_args()
    if a.action == "init":
        init(a)
        return 0
    if a.action == "exec":
        return execute(a)
    if a.action == "result":
        result(a)
        return 0
    return gate(a.run)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValueError, OSError, subprocess.SubprocessError) as e:
        print(str(e), file=sys.stderr)
        sys.exit(2)
