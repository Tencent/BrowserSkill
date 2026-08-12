import { describe, expect, it, vi } from "vitest";

// `background.ts` is a WXT entrypoint that calls the global `defineBackground`
// at module load. WXT injects that helper at build time via auto-imports;
// vitest runs the file directly so we have to stub it before the import is
// resolved. `vi.hoisted` runs before ESM imports, which is exactly what we need.
vi.hoisted(() => {
  (globalThis as unknown as { defineBackground: (cb: unknown) => unknown }).defineBackground = (
    cb: unknown,
  ) => cb;
});

import { handleOverlayInterrupt } from "@/entrypoints/background";

describe("handleOverlayInterrupt", () => {
  it("sends a session.user_interrupt event to the daemon and acks ok", async () => {
    const send = vi.fn().mockReturnValue(undefined);
    const transport = { send } as unknown as Parameters<typeof handleOverlayInterrupt>[0];
    const result = await handleOverlayInterrupt(transport, "sess-1");
    expect(send).toHaveBeenCalledWith({
      event: "session.user_interrupt",
      payload: { session_id: "sess-1" },
    });
    expect(result).toEqual({ ok: true });
  });

  it("returns ok=false when the transport send throws", async () => {
    const send = vi.fn(() => {
      throw new Error("ws closed");
    });
    const transport = { send } as unknown as Parameters<typeof handleOverlayInterrupt>[0];
    const result = await handleOverlayInterrupt(transport, "sess-1");
    expect(result).toEqual({ ok: false });
  });
});
