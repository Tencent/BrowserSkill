#!/usr/bin/env python3
"""Behavioral tests of the audit helper, not BrowserSkill product tests."""

import contextlib, importlib.util, io, json, tempfile, unittest
from pathlib import Path
from types import SimpleNamespace as NS
from unittest.mock import patch
import threading, urllib.request

spec = importlib.util.spec_from_file_location(
    "audit", Path(__file__).with_name("release_audit.py")
)
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)
spec2 = importlib.util.spec_from_file_location(
    "serve", Path(__file__).with_name("serve.py")
)
serve = importlib.util.module_from_spec(spec2)
spec2.loader.exec_module(serve)
FAKE = """#!/usr/bin/env python3
import json,sys
args=sys.argv[1:]
if '--help' in args:
 print('Usage: bsk [OPTIONS] <COMMAND>\\n\\nCommands:\\n  status  Show status\\n\\nOptions:\\n  --help  Help' if args==['--help'] else 'Usage: bsk status [OPTIONS]')
elif '--fail' in args:
 print(json.dumps({'code':'synthetic_rejection','data':{'effect_state':'none'}}));sys.exit(3)
elif '--unsatisfied' in args:print(json.dumps({'satisfied':False}))
else:print(json.dumps({'ok':True,'value':'synthetic'}))
"""


class AuditTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)
        self.skill = self.base / "skill"
        (self.skill / "references").mkdir(parents=True)
        (self.skill / "assets/fixtures").mkdir(parents=True)
        (self.skill / "assets/fixtures/minimal.html").write_text(
            "<title>synthetic</title>"
        )
        self.binary = self.base / "bsk"
        self.binary.write_text(FAKE)
        self.binary.chmod(0o755)
        self.patch = patch.object(audit, "SKILL", self.skill)
        self.patch.start()
        self.root = self.base / "run"

    def tearDown(self):
        self.patch.stop()
        self.tmp.cleanup()

    def init(self, extra=None):
        cases = [
            {"id": "FLOW", "kind": "workflow", "required_commands": ["status"]}
        ] + (extra or [])
        audit.write(self.skill / "references/scenarios.json", cases)
        with contextlib.redirect_stdout(io.StringIO()):
            audit.init(
                NS(
                    out=str(self.root),
                    bsk=str(self.binary),
                    binary=str(self.binary),
                    browser="synthetic-browser",
                    candidate="synthetic-build",
                    port=4567,
                )
            )

    def execute(self, argv=None, case="FLOW"):
        with contextlib.redirect_stdout(io.StringIO()):
            audit.execute(
                NS(
                    run=str(self.root),
                    case=case,
                    argv=argv or ["status"],
                    timeout=5,
                    lane="browser",
                    stdin_file=None,
                    interactive=False,
                )
            )
        return max(
            (self.root / "commands").glob("*/meta.json"),
            key=lambda p: p.stat().st_mtime_ns,
        ).parent.name

    def passed(self, rid, case="FLOW", checks=None):
        return {
            "id": case,
            "status": "passed",
            "records": [rid],
            "oracle_summary": "Synthetic helper contract verified",
            "checks": checks
            or [{"record": rid, "pointer": "/json/ok", "op": "eq", "value": True}],
        }

    def fill(self, rid, extra=None):
        help_id = self.execute(["help"], "CMD-help")
        audit.write(
            self.root / "results.json",
            {
                "cases": [
                    self.passed(rid),
                    self.passed(rid, "CMD-status"),
                    self.passed(help_id, "CMD-help"),
                ]
                + (extra or [])
            },
        )

    def gate(self):
        with contextlib.redirect_stdout(io.StringIO()):
            code = audit.gate(self.root)
        return code, audit.load(self.root / "gate.json")

    def test_full_helper_contract_can_pass(self):
        self.init()
        rid = self.execute()
        self.fill(rid)
        code, r = self.gate()
        self.assertEqual(code, 0)
        self.assertTrue(r["release_ready"])
        self.assertEqual(r["command_coverage"], 1)

    def test_missing_result_blocks(self):
        self.init()
        self.execute()
        self.assertEqual(self.gate()[0], 1)

    def test_retry_does_not_erase_failure(self):
        self.init()
        self.execute(["status", "--fail"])
        rid = self.execute()
        self.fill(rid)
        self.assertFalse(self.gate()[1]["release_ready"])

    def test_raw_output_tampering_blocks(self):
        self.init()
        rid = self.execute()
        self.fill(rid)
        (self.root / "commands" / rid / "stdout.txt").write_text('{"ok":false}')
        self.assertEqual(self.gate()[0], 1)

    def test_candidate_change_blocks(self):
        self.init()
        rid = self.execute()
        self.fill(rid)
        self.binary.write_text(FAKE + "\n# changed\n")
        self.assertEqual(self.gate()[0], 1)

    def test_deleted_scenario_blocks(self):
        self.init()
        rid = self.execute()
        self.fill(rid)
        plan = audit.load(self.root / "plan.json")
        plan["cases"] = plan["cases"][1:]
        audit.write(self.root / "plan.json", plan)
        self.assertEqual(self.gate()[0], 1)

    def test_unfinished_command_blocks(self):
        self.init()
        rid = self.execute()
        self.fill(rid)
        d = self.root / "commands" / ("a" * 32)
        audit.write(d / "started.json", {})
        self.assertEqual(self.gate()[0], 1)

    def test_declared_negative_exact_error_passes(self):
        self.init([{"id": "NEG", "negative": True, "required_commands": ["status"]}])
        good = self.execute()
        bad = self.execute(["status", "--fail"], "NEG")
        checks = [
            {
                "record": bad,
                "pointer": "/json/code",
                "op": "eq",
                "value": "synthetic_rejection",
            },
            {
                "record": bad,
                "pointer": "/json/data/effect_state",
                "op": "eq",
                "value": "none",
            },
        ]
        self.fill(good, [self.passed(bad, "NEG", checks)])
        self.assertEqual(self.gate()[0], 0)

    def test_wrong_negative_reason_blocks(self):
        self.init([{"id": "NEG", "negative": True, "required_commands": ["status"]}])
        good = self.execute()
        bad = self.execute(["status", "--fail"], "NEG")
        checks = [
            {
                "record": bad,
                "pointer": "/json/code",
                "op": "eq",
                "value": "wrong_reason",
            },
            {
                "record": bad,
                "pointer": "/json/data/effect_state",
                "op": "eq",
                "value": "none",
            },
        ]
        self.fill(good, [self.passed(bad, "NEG", checks)])
        self.assertEqual(self.gate()[0], 1)

    def test_zero_exit_unsatisfied_wait_is_explicit_negative(self):
        self.init(
            [
                {
                    "id": "NEG",
                    "negative": True,
                    "allow_zero_rejection": True,
                    "check_effect": False,
                    "required_commands": ["status"],
                }
            ]
        )
        good = self.execute()
        bad = self.execute(["status", "--unsatisfied"], "NEG")
        checks = [
            {"record": bad, "pointer": "/json/satisfied", "op": "eq", "value": False}
        ]
        self.fill(good, [self.passed(bad, "NEG", checks)])
        self.assertEqual(self.gate()[0], 0)

    def test_exit_code_only_is_not_business_verification(self):
        self.init()
        rid = self.execute()
        r = self.passed(
            rid,
            checks=[{"record": rid, "pointer": "/exit_code", "op": "eq", "value": 0}],
        )
        audit.write(
            self.root / "results.json", {"cases": [r, self.passed(rid, "CMD-status")]}
        )
        self.assertEqual(self.gate()[0], 1)

    def test_zero_exit_script_failure_cannot_be_hidden(self):
        body = FAKE.replace(
            "  status  Show status", "  status  Show status\\n  evaluate  Script"
        )
        body = body.replace(
            "elif '--unsatisfied'",
            "elif '--eval-false' in args:print(json.dumps({'ok':False,'marker':'present'}))\nelif '--unsatisfied'",
        )
        self.binary.write_text(body)
        self.init()
        good = self.execute()
        bad = self.execute(["evaluate", "--eval-false"], "CMD-evaluate")
        self.fill(
            good,
            [
                self.passed(
                    bad,
                    "CMD-evaluate",
                    [
                        {
                            "record": bad,
                            "pointer": "/json/marker",
                            "op": "eq",
                            "value": "present",
                        }
                    ],
                )
            ],
        )
        r = self.gate()[1]
        self.assertFalse(r["release_ready"])
        self.assertTrue(any("ok:true" in e for e in r["errors"]))

    def test_required_call_count_needs_distinct_actual_invocations(self):
        self.init(
            [
                {
                    "id": "COUNT",
                    "kind": "workflow",
                    "required_commands": ["status"],
                    "required_command_counts": {"status": 2},
                }
            ]
        )
        first = self.execute()
        r = self.passed(first, "COUNT")
        self.fill(first, [r])
        report = self.gate()[1]
        self.assertFalse(report["release_ready"])
        self.assertTrue(any("Insufficient actual calls" in e for e in report["errors"]))
        second = self.execute(case="COUNT")
        results = audit.load(self.root / "results.json")
        next(v for v in results["cases"] if v["id"] == "COUNT")["records"].append(
            second
        )
        audit.write(self.root / "results.json", results)
        self.assertEqual(self.gate()[0], 0)

    def test_duplicate_record_cannot_satisfy_call_count(self):
        self.init(
            [
                {
                    "id": "COUNT",
                    "kind": "workflow",
                    "required_commands": ["status"],
                    "required_command_counts": {"status": 2},
                }
            ]
        )
        first = self.execute()
        r = self.passed(first, "COUNT")
        r["records"] = [first, first]
        self.fill(first, [r])
        report = self.gate()[1]
        self.assertFalse(report["release_ready"])
        self.assertTrue(any("Duplicate command record" in e for e in report["errors"]))

    def test_strict_types_and_path_boundary(self):
        self.init()
        rid = self.execute()
        self.assertFalse(
            audit.assertion(
                self.root,
                {"record": rid, "pointer": "/json/ok", "op": "eq", "value": 1},
            )
        )
        with self.assertRaises(ValueError):
            audit.within(self.root, "../outside")

    def test_discovery_keeps_navigate_and_distinct_alias_help(self):
        body = """#!/usr/bin/env python3
import sys
p=sys.argv[1:-1]
if not p:print('Usage: bsk <COMMAND>\\n\\nCommands:\\n  navigate  Go\\n  navigate-back  Alias\\n\\nOptions:\\n  --help Help')
elif p==['navigate']:print('Usage: bsk navigate [URL]\\n\\nCommands:\\n  back  Back\\n\\nArguments:\\n  [URL] Destination\\n\\nOptions:\\n  --help Help')
else:print('Usage: bsk '+' '.join(p))
"""
        self.binary.write_text(body)
        inv = audit.discover(str(self.binary), self.base / "help")
        self.assertEqual(
            set(inv["commands"]), {"help", "navigate", "navigate back", "navigate-back"}
        )
        self.assertEqual(
            len({x["path"] for x in inv["help_documents"]}), len(inv["help_documents"])
        )
        self.init()
        plan = audit.load(self.root / "plan.json")["cases"]
        self.assertEqual(len({c["id"] for c in plan}), len(plan))
        command_ids = {
            c["command"]: c["id"] for c in plan if c.get("kind") == "command"
        }
        self.assertNotEqual(command_ids["navigate back"], command_ids["navigate-back"])

    def test_server_routes_and_event_oracle(self):
        root = self.skill / "assets/fixtures"
        (root / "plan-recipe-lab.html").write_text("<title>plan-recipe-lab</title>")
        server = serve.make_server(root, 0)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        url = "http://127.0.0.1:" + str(server.server_port)
        try:
            with urllib.request.urlopen(url + "/minimal") as r:
                self.assertIn(b"synthetic", r.read())
            with urllib.request.urlopen(url + "/recipe/report?drift=none") as r:
                self.assertIn(b"plan-recipe-lab", r.read())
            with urllib.request.urlopen(
                urllib.request.Request(
                    url + "/event", data=b'{"type":"test"}', method="POST"
                )
            ) as r:
                self.assertEqual(json.load(r)["received"]["type"], "test")
            with urllib.request.urlopen(url + "/events") as r:
                self.assertEqual(json.load(r)[0]["data"]["type"], "test")
            with self.assertRaises(urllib.error.HTTPError):
                urllib.request.urlopen(url + "/../test_release_audit.py")
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_hidden_recipe_discovery_and_plan_recipe_benchmark(self):
        body = """#!/usr/bin/env python3
import json, sys
args = sys.argv[1:]
if '--help' in args:
    p = args[:-1]
    if not p:
        print('Usage: bsk <COMMAND>\\n\\nCommands:\\n  status  Status\\n  plan    Batch plan\\n\\nOptions:\\n  --help Help')
    elif p == ['recipe']:
        print('Usage: bsk recipe <COMMAND>\\n\\nCommands:\\n  run   Replay\\n  save  Save\\n\\nOptions:\\n  --help Help')
    else:
        print('Usage: bsk ' + ' '.join(p))
elif args[:1] == ['plan']:
    if '--fail-plan' in args:
        print(json.dumps({'ok': False, 'completed': 1, 'total': 3, 'stopped': {'index': 1, 'action': 'click', 'effect_state': 'none', 'reason': 'wait_unsatisfied'}}))
        sys.exit(1)
    print(json.dumps({'ok': True, 'completed': 5, 'total': 5, 'elapsed_ms': 42, 'post': {'context_id': 'c2', 'kind': 'baseline', 'observation': {'text': '@vom 1\\nL1 page'}}}))
elif args[:2] == ['recipe', 'run']:
    if '--handoff' in args:
        print(json.dumps({'status': 'handoff', 'reason': 'target_not_found', 'effects': {'steps_done': 0, 'last_effect_state': 'none'}}))
        sys.exit(1)
    print(json.dumps({'status': 'completed', 'outputs': {'total': '1300'}, 'effects': {'steps_done': 4, 'last_effect_state': 'committed'}, 'elapsed_ms': 85}))
elif args[:2] == ['recipe', 'save']:
    print(json.dumps({'saved': True, 'revision': 1, 'status': 'draft'}))
else:
    print(json.dumps({'ok': True, 'value': 'synthetic'}))
"""
        self.binary.write_text(body)
        inv = audit.discover(str(self.binary), self.base / "help")
        self.assertEqual(
            set(inv["commands"]),
            {"help", "status", "plan", "recipe run", "recipe save"},
        )
        self.init(
            [
                {
                    "id": "PLAN-FLOW",
                    "kind": "workflow",
                    "page_type": "batch-plan",
                    "required_commands": ["plan"],
                },
                {
                    "id": "NEG-PLAN",
                    "kind": "workflow",
                    "page_type": "batch-plan",
                    "required_commands": ["plan"],
                    "negative": True,
                    "allow_plan_stopped": True,
                },
                {
                    "id": "RECIPE-FLOW",
                    "kind": "workflow",
                    "page_type": "recipe",
                    "required_commands": ["recipe save", "recipe run"],
                },
                {
                    "id": "NEG-RECIPE",
                    "kind": "workflow",
                    "page_type": "recipe",
                    "required_commands": ["recipe run"],
                    "negative": True,
                    "check_effect": False,
                    "allow_recipe_handoff": True,
                },
            ]
        )
        r_status = self.execute(["status"], "FLOW")
        r_help = self.execute(["help"], "CMD-help")
        r_plan_ok = self.execute(["plan", "--steps", "[]"], "PLAN-FLOW")
        r_plan_neg = self.execute(["plan", "--fail-plan"], "NEG-PLAN")
        r_rec_save = self.execute(["recipe", "save"], "RECIPE-FLOW")
        r_rec_run = self.execute(["recipe", "run", "sales"], "RECIPE-FLOW")
        r_rec_neg = self.execute(["recipe", "run", "sales", "--handoff"], "NEG-RECIPE")

        cases = [
            self.passed(r_status, "FLOW"),
            self.passed(r_status, "CMD-status"),
            self.passed(r_help, "CMD-help"),
            self.passed(r_plan_ok, "PLAN-FLOW"),
            self.passed(r_plan_ok, "CMD-plan"),
            self.passed(
                r_plan_neg,
                "NEG-PLAN",
                [
                    {
                        "record": r_plan_neg,
                        "pointer": "/json/stopped/reason",
                        "op": "eq",
                        "value": "wait_unsatisfied",
                    },
                    {
                        "record": r_plan_neg,
                        "pointer": "/json/stopped/effect_state",
                        "op": "eq",
                        "value": "none",
                    },
                ],
            ),
            {
                "id": "RECIPE-FLOW",
                "status": "passed",
                "records": [r_rec_save, r_rec_run],
                "oracle_summary": "Recipe saved and replayed",
                "checks": [
                    {
                        "record": r_rec_save,
                        "pointer": "/json/saved",
                        "op": "eq",
                        "value": True,
                    },
                    {
                        "record": r_rec_run,
                        "pointer": "/json/status",
                        "op": "eq",
                        "value": "completed",
                    },
                ],
            },
            self.passed(
                r_rec_save,
                "CMD-recipe__save",
                [
                    {
                        "record": r_rec_save,
                        "pointer": "/json/saved",
                        "op": "eq",
                        "value": True,
                    }
                ],
            ),
            self.passed(
                r_rec_run,
                "CMD-recipe__run",
                [
                    {
                        "record": r_rec_run,
                        "pointer": "/json/status",
                        "op": "eq",
                        "value": "completed",
                    }
                ],
            ),
            self.passed(
                r_rec_neg,
                "NEG-RECIPE",
                [
                    {
                        "record": r_rec_neg,
                        "pointer": "/json/status",
                        "op": "eq",
                        "value": "handoff",
                    },
                    {
                        "record": r_rec_neg,
                        "pointer": "/json/reason",
                        "op": "eq",
                        "value": "target_not_found",
                    },
                ],
            ),
        ]
        audit.write(self.root / "results.json", {"cases": cases})
        code, report = self.gate()
        self.assertEqual(code, 0, report.get("errors"))
        self.assertTrue(report["release_ready"])
        self.assertIn("benchmark_summary", report)
        self.assertEqual(report["execution_modes"]["plan"]["actions_executed"], 5)
        self.assertEqual(report["execution_modes"]["plan"]["avg_actions_per_turn"], 5.0)
        self.assertEqual(report["execution_modes"]["plan"]["success_rate"], 1.0)
        self.assertEqual(
            report["execution_modes"]["plan"]["negative_guard_invocations"], 1
        )
        self.assertEqual(report["execution_modes"]["recipe"]["actions_executed"], 4)
        self.assertEqual(
            report["execution_modes"]["recipe"]["avg_actions_per_turn"], 4.0
        )
        self.assertEqual(report["execution_modes"]["recipe"]["success_rate"], 1.0)
        self.assertEqual(
            report["execution_modes"]["recipe"]["negative_guard_invocations"], 1
        )
        self.assertEqual(
            report["execution_modes"]["recipe_mgmt"]["actions_executed"], 0
        )
        self.assertTrue((self.root / "benchmark.json").exists())
        self.assertTrue((self.root / "benchmark.md").exists())

        # Verify step error vs result action counting and semantic checks
        m_step_err = audit.extract_metrics(
            "step", 1, {"ok": False, "action": {"error": {"code": "refused"}}}, 12.0
        )
        self.assertEqual(m_step_err["actions_executed"], 0)
        m_step_ok = audit.extract_metrics(
            "step", 0, {"ok": True, "action": {"result": {"tab_id": 1}}}, 15.0
        )
        self.assertEqual(m_step_ok["actions_executed"], 1)
        self.assertIsNotNone(
            audit.semantic_failure(
                {"command": "recipe draft"}, {"json": {"errors": ["ambiguous"]}}
            )
        )
        self.assertIsNone(
            audit.semantic_failure(
                {"command": "recipe approve"},
                {"json": {"name": "sales", "approval_required": False}},
            )
        )
        self.assertIsNotNone(
            audit.semantic_failure(
                {"command": "read"}, {"json": {"ok": True}}
            )
        )
        self.assertIsNone(
            audit.semantic_failure(
                {"command": "read"}, {"json": {"items": [{"text": "hello"}]}}
            )
        )

        # Multi-run aggregation
        agg = audit.aggregate_multi_run_benchmarks([self.root, self.root])
        self.assertEqual(agg["runs_count"], 2)
        self.assertEqual(agg["summary"]["full_pass_runs"], 2)
        self.assertEqual(agg["summary"]["mean_success_rate"], 1.0)
        md = audit.render_multi_run_markdown(agg)
        self.assertIn("PLAN-FLOW", md)
        self.assertIn("RECIPE-FLOW", md)

    def test_adversarial_server_routes_bfcache_cors_and_media_mimes(self):
        root = self.skill / "assets/fixtures"
        (root / "arena-bfcache-detail.html").write_text("<title>bfcache</title>")
        (root / "captions-zh.vtt").write_text("WEBVTT\n\n00:00.000 --> 00:01.000\n你好\n")
        (root / "arena-audio.wav").write_bytes(b"RIFF\x24\x00\x00\x00WAVE")
        server = serve.make_server(root, 0)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        port = server.server_port
        url = f"http://127.0.0.1:{port}"

        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, req, fp, code, msg, headers, newurl):
                return None

        opener = urllib.request.build_opener(NoRedirect)
        try:
            with urllib.request.urlopen(url + "/minimal") as r:
                self.assertEqual(r.headers.get("Cache-Control"), "no-store")
                self.assertEqual(r.headers.get("Access-Control-Allow-Origin"), "*")
            with urllib.request.urlopen(url + "/arena-bfcache-detail") as r:
                self.assertEqual(r.headers.get("Cache-Control"), "public, max-age=300")
            with urllib.request.urlopen(url + "/minimal?bfcache=1") as r:
                self.assertEqual(r.headers.get("Cache-Control"), "public, max-age=300")
            with urllib.request.urlopen(url + "/captions-zh.vtt") as r:
                self.assertEqual(r.headers.get("Content-Type"), "text/vtt; charset=utf-8")
            with urllib.request.urlopen(url + "/arena-audio.wav") as r:
                self.assertEqual(r.headers.get("Content-Type"), "audio/wav")
                self.assertEqual(r.headers.get("Accept-Ranges"), "bytes")
                self.assertEqual(r.read(), b"RIFF\x24\x00\x00\x00WAVE")
            with urllib.request.urlopen(
                urllib.request.Request(
                    url + "/arena-audio.wav", headers={"Range": "bytes=0-3"}
                )
            ) as r:
                self.assertEqual(r.status, 206)
                self.assertEqual(r.headers.get("Content-Range"), "bytes 0-3/12")
                self.assertEqual(r.read(), b"RIFF")
            with urllib.request.urlopen(
                urllib.request.Request(
                    url + "/arena-audio.wav", headers={"Range": "bytes=8-"}
                )
            ) as r:
                self.assertEqual(r.status, 206)
                self.assertEqual(r.headers.get("Content-Range"), "bytes 8-11/12")
                self.assertEqual(r.read(), b"WAVE")
            with urllib.request.urlopen(
                urllib.request.Request(
                    url + "/arena-audio.wav", headers={"Range": "bytes=-4"}
                )
            ) as r:
                self.assertEqual(r.status, 206)
                self.assertEqual(r.headers.get("Content-Range"), "bytes 8-11/12")
                self.assertEqual(r.read(), b"WAVE")
            for invalid_range in ("bytes=999-", "bytes=8-2", "bytes=-0", "bytes=bad"):
                with self.assertRaises(urllib.error.HTTPError) as r_err:
                    urllib.request.urlopen(
                        urllib.request.Request(
                            url + "/arena-audio.wav", headers={"Range": invalid_range}
                        )
                    )
                self.assertEqual(r_err.exception.code, 416)
                self.assertEqual(
                    r_err.exception.headers.get("Content-Range"), "bytes */12"
                )
            with urllib.request.urlopen(
                urllib.request.Request(url + "/arena-audio.wav", method="HEAD")
            ) as r:
                self.assertEqual(r.status, 200)
                self.assertEqual(r.headers.get("Accept-Ranges"), "bytes")
                self.assertEqual(r.headers.get("Content-Length"), "12")
                self.assertEqual(r.read(), b"")
            with self.assertRaises(urllib.error.HTTPError) as ctx:
                opener.open(url + "/redirect-cross-origin")
            self.assertEqual(ctx.exception.code, 302)
            self.assertEqual(
                ctx.exception.headers.get("Location"),
                f"http://localhost:{port}/arena-bfcache-detail?from=cross_origin_302&bfcache=1",
            )
            with urllib.request.urlopen(url + "/slow-doc?delay_ms=15") as r:
                self.assertIn(b"slow-doc-ready", r.read())
            with urllib.request.urlopen(url + "/download") as r:
                self.assertEqual(r.read(), "编号,名称\n42,中文文件 ✅\n".encode("utf-8"))
            with urllib.request.urlopen(
                url + "/download?scene=joint-filing&org=TestOrg&gross=1272.00"
            ) as r:
                joint_csv = r.read()
                self.assertIn(b"JNT-COMMIT-2026-9901,TestOrg,1272.00", joint_csv)
            with urllib.request.urlopen(url + "/download-stream?chunks=2&chunk_ms=5") as r:
                stream_csv = r.read().decode("utf-8")
                self.assertIn("流式对账分片-2", stream_csv)
            with urllib.request.urlopen(url + "/events") as r:
                ev_types = [e.get("type") for e in json.load(r)]
                self.assertIn("redirect-cross-origin", ev_types)
                self.assertIn("slow-doc", ev_types)
                self.assertIn("download-stream", ev_types)
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_wave_commands_range_assertions_and_long_admin_home(self):
        (self.skill / "assets/fixtures/arena-frame-outer.html").write_text(
            '<iframe src="http://localhost:4187/a"></iframe><iframe src="http://127.0.0.1:4187/b"></iframe>'
        )
        self.init()
        rewritten = (self.root / "fixtures/arena-frame-outer.html").read_text()
        self.assertIn("http://localhost:4567/a", rewritten)
        self.assertIn("http://127.0.0.1:4567/b", rewritten)
        rid = self.execute()
        d = self.root / "commands" / rid
        (d / "stdout.txt").write_text('{"ok": true, "size": 42, "label": "9"}')
        m = audit.load(d / "meta.json")
        m["stdout_sha256"] = audit.digest(d / "stdout.txt")
        audit.write(d / "meta.json", m)
        self.assertTrue(
            audit.assertion(
                self.root, {"record": rid, "pointer": "/json/size", "op": "lt", "value": 50}
            )
        )
        self.assertTrue(
            audit.assertion(
                self.root, {"record": rid, "pointer": "/json/size", "op": "lte", "value": 42}
            )
        )
        self.assertTrue(
            audit.assertion(
                self.root, {"record": rid, "pointer": "/json/size", "op": "gte", "value": 42}
            )
        )
        for op, ptr, val in [
            ("gte", "/json/ok", 1),
            ("lte", "/json/ok", 1),
            ("gt", "/json/ok", 0),
            ("gte", "/json/size", True),
            ("gt", "/json/label", "10"),
        ]:
            self.assertFalse(
                audit.assertion(
                    self.root, {"record": rid, "pointer": ptr, "op": op, "value": val}
                ),
                f"Expected strict numeric rejection for {op} on {ptr} vs {val!r}",
            )
        m_open = audit.extract_metrics(
            "open", 0, {"vom": "@vom 2\npage", "elapsed_ms": 20}, 25.0
        )
        self.assertEqual(m_open["execution_mode"], "single_action")
        self.assertEqual(m_open["actions_executed"], 1)
        self.assertEqual(m_open["observation_kind"], "full")
        self.assertGreater(m_open["vom_chars"], 0)
        m_sync = audit.extract_metrics("sync", 0, {"unchanged": True}, 8.0)
        self.assertEqual(m_sync["execution_mode"], "read")
        self.assertTrue(m_sync["observation_reused"])
        self.assertEqual(m_sync["observation_kind"], "unchanged")
        m_ledger = audit.extract_metrics("ledger status", 0, {"pending": []}, 5.0)
        self.assertEqual(m_ledger["browser_calls"], 0)
        self.assertIsNotNone(
            audit.semantic_failure(
                {"command": "navigate back"}, {"json": {"reached": "timeout"}, "argv": ["navigate", "back"]}
            )
        )
        self.assertIsNotNone(
            audit.semantic_failure(
                {"command": "sync"}, {"json": None, "argv": ["sync", "--json"]}
            )
        )
        deep_run = (
            self.base
            / ("very_deep_nested_segment_" * 4)
            / "candidate_run_directory"
        )
        deep_run.mkdir(parents=True)
        with patch.object(audit.sys, "platform", "win32"):
            win_home = audit.resolve_admin_home(deep_run)
            self.assertEqual(Path(win_home), (deep_run / "admin-runtime").resolve())
        resolved = Path(audit.resolve_admin_home(deep_run))
        try:
            self.assertLessEqual(len(str(resolved / "run" / "daemon.sock")), 96)
            self.assertEqual(resolved.resolve(), (deep_run / "admin-runtime").resolve())
        finally:
            if resolved.is_symlink():
                resolved.unlink()

    def test_shipped_scenarios_and_fixture_manifest_integrity(self):
        import re as _re

        real_skill = Path(__file__).resolve().parents[1]
        scenarios = audit.load(real_skill / "references/scenarios.json")
        self.assertGreaterEqual(len(scenarios), 98)
        ids = [s["id"] for s in scenarios]
        self.assertEqual(len(ids), len(set(ids)))
        for required_id in [
            "PLAN-BATCH-FORM",
            "NEG-PLAN-MIDSTEP-EXPECT",
            "RECIPE-LIFECYCLE",
            "RECIPE-DRIFT-RESILIENCE",
            "NEG-RECIPE-HANDOFF",
            "READ-DYNAMIC-BOUNDED",
            "EDGE-VIRTUAL-LIST-RECYCLE",
            "EDGE-STACKED-MODALS",
            "LOCAL-VIDEO-PORTAL",
            "LOCAL-FORUM-HUB",
            "PUBLIC-BILIBILI-FEED",
            "PUBLIC-BILIBILI-PLAYER",
            "PUBLIC-FORUM-TOPICS",
            "PUBLIC-FORUM-THREAD",
            "ARENA-JOINT-FORMS",
            "ARENA-NEG-FORM-BOUNDARIES",
            "ARENA-SHADOW-MATRIX",
            "ARENA-IFRAME-FEDERATION",
            "ARENA-MEDIA-STUDIO",
            "ARENA-MODERN-SPA-BFCACHE",
            "ARENA-VIRTUAL-GRID-STEGANO",
            "ARENA-NEG-VIRTUAL-RECYCLE",
        ]:
            self.assertIn(required_id, ids)
        corpus = "\n".join(
            p.read_text(encoding="utf-8")
            for p in [
                *(real_skill / "assets/fixtures").glob("arena-*.html"),
                real_skill / "scripts/serve.py",
            ]
        )
        known_dom_ids = set(_re.findall(r'id=["\']([A-Za-z0-9_-]+)["\']', corpus))
        for sc in scenarios:
            if not sc["id"].startswith("ARENA-"):
                continue
            for sel_id in _re.findall(r"#([A-Za-z][A-Za-z0-9_-]*)", sc.get("goal", "")):
                if sel_id.endswith("..3"):
                    sel_id = sel_id[:-3]
                self.assertIn(
                    sel_id,
                    known_dom_ids,
                    f"Scenario {sc['id']} references #{sel_id} missing from arena fixtures",
                )
        manifest = audit.load(real_skill / "references/fixture-manifest.json")
        actual_files = {
            f.relative_to(real_skill / "assets").as_posix()
            for f in (real_skill / "assets/fixtures").iterdir()
            if f.is_file()
        }
        self.assertEqual(set(manifest.keys()), actual_files)
        for rel, expected_sha in manifest.items():
            full = real_skill / "assets" / rel
            self.assertTrue(full.is_file(), f"Missing fixture {rel}")
            self.assertEqual(audit.digest(full), expected_sha, f"Hash mismatch for {rel}")


if __name__ == "__main__":
    unittest.main()
