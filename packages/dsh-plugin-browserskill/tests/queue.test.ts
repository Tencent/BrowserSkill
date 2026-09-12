// KeyedExecutor: per-key FIFO guarantees, including the abort-while-queued
// race that used to release the tail early (letting a later task overlap the
// one still running on the same session).

import { describe, expect, it } from "vitest";
import { KeyedExecutor } from "../src/queue";

describe("KeyedExecutor", () => {
  it("runs same-key tasks in FIFO order", async () => {
    const queue = new KeyedExecutor();
    const order: string[] = [];
    const gate = new Promise<void>((resolve) => setTimeout(resolve, 5));
    await Promise.all([
      queue.run("k", async () => {
        await gate;
        order.push("a");
      }),
      queue.run("k", async () => {
        order.push("b");
      }),
      queue.run("k", async () => {
        order.push("c");
      }),
    ]);
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("a task aborted while queued does not let the next one overlap the runner", async () => {
    const queue = new KeyedExecutor();
    let releaseA!: () => void;
    const aRuns = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const events: string[] = [];

    // A holds the session until releaseA.
    const a = queue.run("s1", async () => {
      events.push("a:start");
      await aRuns;
      events.push("a:end");
    });
    // B is queued behind A and aborted before A finishes.
    const abortB = new AbortController();
    const b = queue.run(
      "s1",
      async () => {
        events.push("b:start");
      },
      abortB.signal,
    );
    // C is queued behind B.
    const c = queue.run("s1", async () => {
      events.push("c:start");
    });

    abortB.abort();
    await expect(b).rejects.toMatchObject({ name: "AbortError" });
    // Give C every chance to (wrongly) start while A is still in flight.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events).toEqual(["a:start"]);

    releaseA();
    await a;
    await c;
    expect(events).toEqual(["a:start", "a:end", "c:start"]);
  });

  it("a failed task never strands the queue", async () => {
    const queue = new KeyedExecutor();
    await expect(
      queue.run("k", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(queue.run("k", async () => "ok")).resolves.toBe("ok");
  });

  it("drops the tail entry once the queue drains", async () => {
    const queue = new KeyedExecutor();
    const internals = queue as unknown as { tails: Map<string, Promise<void>> };
    await queue.run("k", async () => {});
    await new Promise((resolve) => setImmediate(resolve));
    expect(internals.tails.size).toBe(0);
  });
});
