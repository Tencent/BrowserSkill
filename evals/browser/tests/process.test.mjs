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
