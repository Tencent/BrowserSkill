import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";

/** Exercise the shipped stdio boundary, not a replacement tool implementation. */
export async function createMcpRegressionClient(cli, env) {
  const child = spawn(cli, ["mcp"], { env, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map();
  let sequence = 0;
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr = (stderr + chunk).slice(-8192)));
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const reply = JSON.parse(line);
    const waiter = pending.get(reply.id);
    if (!waiter) return;
    pending.delete(reply.id);
    clearTimeout(waiter.timer);
    if (reply.error) waiter.reject(new Error(JSON.stringify(reply.error)));
    else waiter.resolve(reply.result);
  });
  child.on("exit", () => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`MCP closed: ${stderr}`));
    }
    pending.clear();
  });
  const rpc = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP timeout: ${method}`));
      }, 45000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "dynamic-read-regression", version: "1" },
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  return {
    rpc,
    async run(name, args, reason) {
      const result = await rpc("tools/call", { name, arguments: args });
      const value = JSON.parse(result.content[0].text);
      if (reason) assert.equal(value.data?.reason, reason, JSON.stringify(result));
      else assert(!result.isError, JSON.stringify(result));
      // Restore VOM only for test selection; never change the evidence metadata.
      if (value.observation?.text === "(VOM text in the next content block)")
        value.observation.text = result.content[1].text;
      return value;
    },
    async dispose() {
      const closed = once(child, "exit");
      child.stdin.end();
      const timer = setTimeout(() => child.kill(), 3000);
      await closed;
      clearTimeout(timer);
      lines.close();
    },
  };
}
