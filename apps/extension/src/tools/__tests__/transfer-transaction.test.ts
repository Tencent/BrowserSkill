import { expect, it } from "vitest";
import { waitBounded } from "../transfer-transaction";

it.each([
  "aborted",
  "timeout",
])("consumes late failures after an already %s boundary", async (kind) => {
  const controller = new AbortController();
  if (kind === "aborted") controller.abort();
  const pending = Promise.withResolvers<void>();
  await expect(
    waitBounded(
      pending.promise,
      kind === "timeout" ? Date.now() - 1 : Date.now() + 1000,
      controller.signal,
      "expired",
    ),
  ).rejects.toMatchObject({ kind });
  pending.reject(new Error("late CDP failure"));
  await new Promise((resolve) => setTimeout(resolve, 0));
});
