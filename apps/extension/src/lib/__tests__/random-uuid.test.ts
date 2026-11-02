import { afterEach, describe, expect, it, vi } from "vitest";
import { createRandomUuid } from "../random-uuid";

describe("createRandomUuid", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses crypto.randomUUID when it is available", () => {
    const randomUUID = vi.fn(() => "00000000-0000-4000-8000-000000000000");
    vi.stubGlobal("crypto", { randomUUID, getRandomValues: vi.fn() });

    expect(createRandomUuid()).toBe("00000000-0000-4000-8000-000000000000");
    expect(randomUUID).toHaveBeenCalledOnce();
  });

  it("falls back to getRandomValues and sets UUID v4 bits", () => {
    const bytes = new Uint8Array(16).fill(0xff);
    const getRandomValues = vi.fn((target: Uint8Array) => {
      target.set(bytes);
      return target;
    });
    vi.stubGlobal("crypto", { getRandomValues });

    const uuid = createRandomUuid();

    expect(uuid).toBe("ffffffff-ffff-4fff-bfff-ffffffffffff");
    expect(getRandomValues).toHaveBeenCalledOnce();
  });
});
