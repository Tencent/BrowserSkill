import assert from "node:assert/strict";
import test from "node:test";

import { runProcess } from "../lib/process.mjs";

test("process output preserves UTF-8 characters split across pipe writes", async () => {
  const expected = "中文🙂";
  const source = `
    const bytes = Buffer.from(${JSON.stringify(expected)});
    let offset = 0;
    const timer = setInterval(() => {
      const chunk = bytes.subarray(offset, ++offset);
      process.stdout.write(chunk);
      process.stderr.write(chunk);
      if (offset === bytes.length) clearInterval(timer);
    }, 10);
  `;
  const result = await runProcess(process.execPath, ["-e", source]);

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, expected);
  assert.equal(result.stderr, expected);
});

test("process output flushes an incomplete final UTF-8 sequence", async () => {
  const source = `
    process.stdout.write(Buffer.from([0xe4, 0xb8]));
    process.stderr.write(Buffer.from([0xf0, 0x9f]));
  `;
  const result = await runProcess(process.execPath, ["-e", source]);

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "�");
  assert.equal(result.stderr, "�");
});

for (const parentExits of [false, true]) {
  test(
    `process timeout closes inherited pipes when the launcher ${parentExits ? "has exited" : "is running"}`,
    { skip: process.platform === "win32" },
    async () => {
      const descendant = `
        process.on("SIGTERM", () => {
          process.stdout.write("descendant terminated\\n");
          process.exit(0);
        });
        process.stdout.write("descendant ready\\n");
        setTimeout(() => process.exit(0), 5_000);
      `;
      const source = `
        const { spawn } = require("node:child_process");
        const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], {
          stdio: ["ignore", "inherit", "inherit"],
        });
        ${parentExits ? "child.unref();" : ""}
      `;
      const result = await runProcess(process.execPath, ["-e", source], { timeoutMs: 500 });

      assert.equal(result.timedOut, true);
      assert.match(result.stdout, /descendant ready/);
      assert.match(result.stdout, /descendant terminated/);
      assert.ok(result.durationMs < 3_000, `timeout took ${result.durationMs} ms`);
      assert.equal(result.exitCode, parentExits ? 0 : null);
      assert.equal(result.signal, parentExits ? null : "SIGTERM");
    },
  );
}

test(
  "process timeout escalates for descendants that ignore SIGTERM",
  { skip: process.platform === "win32" },
  async () => {
    const descendant = `
      process.on("SIGTERM", () => {});
      process.stdout.write("descendant ready\\n");
      setTimeout(() => process.exit(0), 6_000);
    `;
    const source = `
      const { spawn } = require("node:child_process");
      spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], {
        stdio: ["ignore", "inherit", "inherit"],
      });
    `;
    const result = await runProcess(process.execPath, ["-e", source], { timeoutMs: 500 });

    assert.equal(result.timedOut, true);
    assert.match(result.stdout, /descendant ready/);
    assert.ok(result.durationMs < 4_500, `timeout took ${result.durationMs} ms`);
    assert.equal(result.signal, "SIGTERM");
  },
);
