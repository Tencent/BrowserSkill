import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
/** Each drift type runs this many times. The acceptance bar in docs/recipes.md is 20. */
const RUNS = Number(process.env.BSK_RECIPE_RUNS ?? 2);

/**
 * `bsk recipe` through the installed extension. The server's request log is the truth:
 * a wrong action shows up there whatever the run reports about itself.
 */
export async function runRecipeScenarios({ send, bsk, cli, env, base, requests }) {
  const directory = await mkdtemp(join(tmpdir(), "bsk-recipes-"));
  const recipe = async (args) => {
    try {
      const { stdout } = await exec(cli, ["recipe", ...args], {
        env,
        timeout: 60000,
        maxBuffer: 2 ** 22,
      });
      return { exit: 0, reply: JSON.parse(stdout) };
    } catch (error) {
      assert(error.stdout, String(error));
      return { exit: error.code, reply: JSON.parse(error.stdout) };
    }
  };
  const save = async (document) => {
    const path = join(directory, `${document.name}-${Date.now()}.json`);
    await writeFile(path, JSON.stringify(document));
    const { exit, reply } = await recipe(["save", "--file", path]);
    assert.equal(exit, 0, JSON.stringify(reply));
    return reply;
  };
  const stop = (session) => bsk(["session", "stop", session]).catch(() => {});
  const posts = (path) => requests.filter((request) => request.path === path);

  try {
    await save({
      recipe_version: 1,
      name: "fixture-report",
      description: "Query a region's total for one quarter",
      site: { origins: [base], start: "/recipe/report?drift={{drift}}" },
      params: {
        drift: { type: "string", default: "none" },
        region: { type: "enum", values: ["east", "north"] },
        quarter: { type: "string", pattern: "^Q[1-4]$" },
      },
      segments: [
        {
          id: "query",
          requires: [{ role: "heading", name: "销售报表" }],
          steps: [
            {
              action: "select",
              target: { role: "combobox", name: "地区" },
              values: ["{{region}}"],
            },
            {
              action: "select",
              target: { role: "combobox", name: "季度" },
              values: ["{{quarter}}"],
            },
            { action: "click", target: { role: "button", name: "查询" } },
          ],
          until: { text: "合计金额", timeout_ms: 2500 },
        },
      ],
      outputs: { total: { regex: "合计金额 ¥(\\d+)", required: true } },
      interrupts: [
        { when: { role: "dialog", name: "订阅优惠" }, click: { role: "button", name: "关闭" } },
      ],
    });

    // What each kind of drift must do. `queries` counts the business request.
    const expected = {
      none: { status: "completed", queries: 1 },
      ids: { status: "completed", queries: 1 },
      order: { status: "completed", queries: 1 },
      late: { status: "completed", queries: 1 },
      popup: { status: "completed", queries: 1 },
      // The button the plan resolved is gone before its click: resolved again, sent once.
      rerender: { status: "completed", queries: 1 },
      label: { status: "handoff", reason: "target_not_found", queries: 0, steps: 0 },
      semantics: { status: "handoff", reason: "target_not_found", queries: 0, steps: 0 },
      duplicate: { status: "handoff", reason: "target_ambiguous", queries: 0, steps: 0 },
      "unknown-popup": { status: "handoff", reason: "requires_failed", queries: 0, steps: 0 },
      login: { status: "handoff", reason: "requires_failed", queries: 0, steps: 0 },
      // Sent, once, and reported as sent. The result is simply not there yet.
      slow: { status: "handoff", reason: "until_timeout", queries: 1, steps: 3 },
      required: { status: "handoff", reason: "until_timeout", queries: 0, steps: 3 },
    };
    const results = {};
    let wrongActions = 0;
    for (const [drift, want] of Object.entries(expected)) {
      const elapsed = [];
      for (let run = 0; run < RUNS; run++) {
        requests.length = 0;
        const { exit, reply } = await recipe([
          "run",
          "fixture-report",
          "--param",
          `drift=${drift}`,
          "--param",
          "region=north",
          "--param",
          "quarter=Q3",
        ]);
        const label = `${drift} #${run}: ${JSON.stringify({ ...reply, post: reply.post?.observation?.text })}`;
        assert.equal(reply.status, want.status, label);
        if (want.reason) assert.equal(reply.reason, want.reason, label);
        if (want.steps !== undefined) assert.equal(reply.effects.steps_done, want.steps, label);
        assert.equal(exit, want.status === "completed" ? 0 : 1, label);
        // The wrong button, a draft saved by mistake, or a query sent twice.
        wrongActions +=
          posts("/recipe/wrong").length +
          posts("/recipe/draft").length +
          Math.max(0, posts("/recipe/query").length - want.queries);
        if (drift !== "slow") assert.equal(posts("/recipe/query").length, want.queries, label);
        if (want.status === "completed") {
          // Quarter Q3 in the north: the page's own arithmetic, read from the page.
          assert.equal(reply.outputs.total, "1300", label);
          assert.deepEqual(JSON.parse(posts("/recipe/query")[0].body), {
            region: "north",
            quarter: "Q3",
          });
          assert.equal(reply.session_stopped, true, label);
          assert.equal(reply.post, undefined, label);
        } else {
          // The caller can take over from here, in the session the run left open.
          assert(reply.post?.context_id, label);
          assert(reply.post.observation.text.startsWith("@vom"), label);
          assert(reply.session_id, label);
          await stop(reply.session_id);
        }
        elapsed.push(reply.elapsed_ms);
      }
      results[drift] = { runs: RUNS, status: want.status, reason: want.reason, elapsed };
    }
    assert.equal(wrongActions, 0, "a drifted page must never receive a wrong action");

    // Another site: stopped before any input, whatever that page shows.
    const other = base.replace("127.0.0.1", "localhost");
    requests.length = 0;
    const redirected = await recipe([
      "run",
      "fixture-report",
      "--param",
      `drift=redirect&to=${other}/recipe/report`,
      "--param",
      "region=east",
      "--param",
      "quarter=Q1",
    ]);
    // The value is encoded, so it stays one query field and cannot send the page away.
    assert.equal(redirected.reply.status, "completed", JSON.stringify(redirected.reply));
    await save({
      recipe_version: 1,
      name: "fixture-redirect",
      description: "Follows a page that leaves the site",
      site: {
        origins: [base],
        start: `/recipe/report?drift=redirect&to=${encodeURIComponent(`${other}/recipe/report`)}`,
      },
      segments: [
        {
          id: "only",
          steps: [{ action: "click", target: { role: "button", name: "查询" } }],
        },
      ],
    });
    requests.length = 0;
    const offsite = await recipe(["run", "fixture-redirect"]);
    assert.equal(offsite.reply.reason, "origin_mismatch", JSON.stringify(offsite.reply));
    assert.equal(posts("/recipe/query").length, 0);
    await stop(offsite.reply.session_id);

    // A caller's session: already synchronized elsewhere, moved to the start page, left open.
    const { session_id: own } = await bsk(["session", "start"]);
    const ownScope = ["--session", own];
    await bsk(["navigate", `${base}/recipe/form?source=caller`, ...ownScope]);
    const syncedElsewhere = performance.now() + 5000;
    for (;;) {
      const reply = await bsk(["cooperate", "sync", ...ownScope]).catch(() => undefined);
      if (reply?.observation?.text.includes("开户申请")) break;
      assert(performance.now() < syncedElsewhere, "the caller's page did not load");
    }
    const inSession = (quarter) =>
      recipe([
        "run",
        "fixture-report",
        ...ownScope,
        "--param",
        "region=east",
        "--param",
        `quarter=${quarter}`,
      ]);
    const owned = await inSession("Q2");
    assert.equal(owned.reply.status, "completed", JSON.stringify(owned.reply));
    assert.equal(owned.reply.outputs.total, "200");
    assert.equal(owned.reply.session_id, own);
    assert.equal(owned.reply.session_stopped, undefined);
    // The same answer again cannot be told apart from a page that has not responded.
    const repeated = await inSession("Q2");
    assert.equal(repeated.reply.reason, "until_timeout", JSON.stringify(repeated.reply));
    assert.equal(repeated.reply.effects.last_effect_state, "committed");
    // A different answer is proof that it did.
    const refreshed = await inSession("Q4");
    assert.equal(refreshed.reply.outputs?.total, "400", JSON.stringify(refreshed.reply));
    await stop(own);

    // A later segment on another page, opened with the evidence navigation requires.
    await save({
      recipe_version: 1,
      name: "fixture-two-pages",
      description: "Query a total, then open the form",
      site: { origins: [base], start: "/recipe/report?page=first" },
      params: { company: { type: "string" } },
      segments: [
        {
          id: "query",
          steps: [
            { action: "select", target: { role: "combobox", name: "季度" }, values: ["Q1"] },
            { action: "click", target: { role: "button", name: "查询" } },
          ],
          until: { text: "合计金额", timeout_ms: 2500 },
        },
        {
          id: "form",
          navigate: "/recipe/form?for={{company}}",
          requires: [{ role: "heading", name: "开户申请" }],
          steps: [
            { action: "fill", target: { role: "textbox", name: "公司名称" }, value: "{{company}}" },
            { action: "click", target: { role: "button", name: "预览" } },
          ],
          until: { text: "预览 ", timeout_ms: 2500 },
        },
      ],
      outputs: { preview: { regex: '预览 ([^/"]+)/', required: true } },
    });
    requests.length = 0;
    const twoPages = await recipe(["run", "fixture-two-pages", "--param", "company=A/B C"]);
    assert.equal(twoPages.reply.status, "completed", JSON.stringify(twoPages.reply));
    assert.equal(twoPages.reply.outputs.preview, "A");
    assert.equal(twoPages.reply.effects.steps_done, 4);
    assert.equal(posts("/recipe/query").length, 1);

    // A person acting between segments ends the run before its next input.
    await save({
      recipe_version: 1,
      name: "fixture-human",
      description: "Query, then export",
      site: { origins: [base], start: "/recipe/report?delay=2000&human=1" },
      segments: [
        {
          id: "query",
          steps: [
            { action: "select", target: { role: "combobox", name: "季度" }, values: ["Q1"] },
            { action: "click", target: { role: "button", name: "查询" } },
          ],
          until: { text: "合计金额", timeout_ms: 8000 },
        },
        {
          id: "export",
          steps: [{ action: "click", target: { role: "button", name: "导出" } }],
        },
      ],
    });
    requests.length = 0;
    const running = recipe(["run", "fixture-human"]);
    const deadline = performance.now() + 15000;
    while (posts("/recipe/query").length === 0) {
      assert(performance.now() < deadline, "the run's query did not arrive");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const target = (await send("Target.getTargets")).targetInfos.find((entry) =>
      entry.url.includes("delay=2000"),
    );
    assert(target, "the run's page was not found");
    const { sessionId } = await send("Target.attachToTarget", {
      targetId: target.targetId,
      flatten: true,
    });
    await send("Page.bringToFront", {}, sessionId);
    const read = async (expression) =>
      (await send("Runtime.evaluate", { expression, returnByValue: true }, sessionId)).result.value;
    const point = await read(`(() => {
      const rect = document.querySelector('#human').getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    })()`);
    for (const type of ["mousePressed", "mouseReleased"])
      await send(
        "Input.dispatchMouseEvent",
        { type, button: "left", clickCount: 1, ...point },
        sessionId,
      );
    assert.equal(await read("window.humanChanged"), true);
    const interrupted = await running;
    await send("Target.detachFromTarget", { sessionId }).catch(() => {});
    assert.equal(interrupted.reply.status, "handoff", JSON.stringify(interrupted.reply));
    assert.equal(interrupted.reply.reason, "human_intervention", JSON.stringify(interrupted.reply));
    assert.equal(posts("/recipe/export").length, 0, "no input may follow a person's action");
    await stop(interrupted.reply.session_id);

    // From an agent's run to a saved recipe, then a second run with no decisions at all.
    const { session_id: session } = await bsk(["session", "start"]);
    const scope = ["--session", session];
    await bsk(["navigate", `${base}/recipe/form?source=first`, ...scope]);
    let first;
    const synced = performance.now() + 5000;
    while (!first?.observation?.text.includes("开户申请")) {
      assert(performance.now() < synced, "the form did not load");
      first = await bsk(["cooperate", "sync", ...scope]).catch(() => undefined);
    }
    assert.equal(first.control_policy, "target");
    const ref = (role, name) => {
      const found = first.observation.text.match(
        new RegExp(`(@e\\d+) ${role} "${name}(?: \\[has-submenu\\])?"`),
      );
      assert(found, `${role} ${name}: ${first.observation.text}`);
      return found[1];
    };
    const steps = [
      { action: "fill", ref: ref("textbox", "公司名称"), value: "云杉科技" },
      { action: "fill", ref: ref("textbox", "联系人"), value: "李雷" },
      { action: "fill", ref: ref("textbox", "手机号"), value: "13800138000" },
      { action: "fill", ref: ref("textbox", "邮箱"), value: "li@example.com" },
      { action: "select", ref: ref("combobox", "省份"), values: ["浙江"] },
      { action: "select", ref: ref("combobox", "城市"), values: ["杭州"] },
      { action: "select", ref: ref("combobox", "行业"), values: ["零售"] },
      { action: "click", ref: ref("checkbox", "我已阅读说明") },
      { action: "click", ref: ref("button", "预览") },
    ];
    const planned = JSON.parse(
      (
        await exec(
          cli,
          ["plan", ...scope, "--context", first.context_id, "--steps", JSON.stringify(steps)],
          { env, timeout: 35000, maxBuffer: 2 ** 22 },
        )
      ).stdout,
    );
    assert.equal(planned.completed, 9, JSON.stringify(planned));

    const draftPath = join(directory, "draft.json");
    const drafted = await recipe([
      "draft",
      ...scope,
      "--name",
      "fixture-form",
      "--description",
      "Fill the account form and preview it",
      "--out",
      draftPath,
    ]);
    assert.equal(drafted.exit, 0, JSON.stringify(drafted.reply));
    assert.deepEqual(drafted.reply.errors, []);
    const draft = drafted.reply.draft;
    assert.deepEqual(draft.site.origins, [base]);
    assert.equal(draft.site.start, "/recipe/form");
    assert.equal(draft.segments.length, 1);
    assert.equal(draft.segments[0].steps.length, 9);
    assert.equal(draft.segments[0].requires[0].name, "开户申请");
    // The daemon saw every input, and kept none of them.
    const rendered = JSON.stringify(drafted.reply);
    for (const secret of ["云杉科技", "13800138000", "li@example.com"])
      assert(!rendered.includes(secret), `${secret} leaked into the draft: ${rendered}`);
    assert(rendered.includes("query string"), rendered);
    await stop(session);

    // The author restores the constants, names what varies, and says what to read.
    const reviewed = JSON.parse(await readFile(draftPath, "utf8"));
    const constants = { 省份: "浙江", 城市: "杭州", 行业: "零售" };
    for (const step of reviewed.segments[0].steps) {
      const constant = constants[step.target.name];
      if (constant) step.values = [constant];
    }
    reviewed.params = Object.fromEntries(
      Object.entries(reviewed.params).filter(([, param]) => !constants[param.description]),
    );
    reviewed.segments[0].until = { text: "预览 ", timeout_ms: 3000 };
    reviewed.outputs = { preview: { regex: '预览 ([^"]+)', required: true } };
    const saved = await save(reviewed);
    assert.equal(saved.status, "draft");
    const parameters = Object.entries(reviewed.params).map(
      ([name, param]) =>
        `${name}=${{ 公司名称: "云杉科技", 联系人: "韩梅", 手机号: "13900139000", 邮箱: "han@example.com" }[param.description]}`,
    );
    const form = [];
    for (let run = 0; run < Math.max(RUNS, 3); run++) {
      const { exit, reply } = await recipe([
        "run",
        "fixture-form",
        ...parameters.flatMap((parameter) => ["--param", parameter]),
      ]);
      assert.equal(exit, 0, JSON.stringify(reply));
      assert.equal(
        reply.outputs.preview,
        "云杉科技/韩梅/13900139000/han@example.com 浙江/杭州/零售 true",
      );
      assert.equal(reply.effects.steps_done, 9);
      form.push(reply.elapsed_ms);
    }
    const shown = await recipe(["show", "fixture-form"]);
    assert.equal(shown.reply.state.status, "verified");

    // Three stops at one step tell the author the site has moved on.
    for (let run = 0; run < 3; run++) {
      const { reply } = await recipe([
        "run",
        "fixture-report",
        "--param",
        "drift=label",
        "--param",
        "region=east",
        "--param",
        "quarter=Q1",
      ]);
      await stop(reply.session_id);
    }
    const listed = (await recipe(["list", "--site", base])).reply.recipes;
    const report = listed.find((entry) => entry.name === "fixture-report");
    assert.equal(report.status, "stale", JSON.stringify(listed));
    assert.match(report.notice, /query\/1/);
    const log = await recipe(["show", "fixture-report"]);
    assert.equal(log.reply.state.status, "stale");

    return { runsPerDrift: RUNS, wrongActions, drifts: results, nineStepFormMs: form };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
