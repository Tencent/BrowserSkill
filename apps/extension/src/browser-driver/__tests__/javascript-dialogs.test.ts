import { describe, expect, it, vi } from "vitest";
import { DialogPendingError, JavaScriptDialogs } from "../javascript-dialogs";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("JavaScript dialog decisions", () => {
  it.each([
    "confirm",
    "prompt",
  ])("keeps %s pending without answering for the agent", async (type) => {
    const send = vi.fn(async () => {});
    const dialogs = new JavaScriptDialogs(send, () => true);
    await dialogs.opened({ tabId: 7 }, { type, message: "Decide", url: "https://example.test/" });
    expect(send).not.toHaveBeenCalled();
    expect(dialogs.pending(7)).toMatchObject({ type, message: "Decide", sequence: 1 });
    expect(dialogs.since(7, 0)).toEqual([]);
  });

  it.each(["alert", "beforeunload"])("auto-accepts %s only when policy permits", async (type) => {
    const send = vi.fn(async () => {});
    const dialogs = new JavaScriptDialogs(send, () => true);
    await dialogs.opened({ tabId: 7 }, { type, message: "auto" });
    expect(send).toHaveBeenCalledWith({ tabId: 7 }, { accept: true });
    expect(dialogs.since(7, 0)[0]).toMatchObject({ type, handled: "accepted" });
    const manual = new JavaScriptDialogs(send, () => false);
    send.mockClear();
    await manual.opened({ tabId: 8 }, { type });
    expect(manual.pending(8)?.type).toBe(type);
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    "",
    "Ada",
  ])("preserves omitted versus explicit prompt text: %s", async (text) => {
    const send = vi.fn(async () => {});
    const dialogs = new JavaScriptDialogs(send, () => true);
    const defaultPrompt = "x".repeat(5000);
    await dialogs.opened({ tabId: 7, sessionId: "iframe" }, { type: "prompt", defaultPrompt });
    expect(dialogs.pending(7)?.default_prompt?.length).toBeLessThan(5000);
    await dialogs.handle(7, dialogs.pending(7)!.id, true, text);
    expect(send).toHaveBeenCalledWith(
      { tabId: 7, sessionId: "iframe" },
      {
        accept: true,
        promptText: text ?? defaultPrompt,
      },
    );
    expect(dialogs.pending(7)).toBeNull();
  });

  it("records manual closing and rejects a stale decision without answering the next dialog", async () => {
    const send = vi.fn(async () => {});
    const dialogs = new JavaScriptDialogs(send, () => true);
    await dialogs.opened({ tabId: 7 }, { type: "confirm" });
    const oldId = dialogs.pending(7)!.id;
    dialogs.closed({ tabId: 7 }, { result: false });
    expect(dialogs.since(7, 0)[0]?.handled).toBe("dismissed");
    await dialogs.opened({ tabId: 7 }, { type: "prompt" });
    await expect(dialogs.handle(7, oldId, true)).rejects.toThrow("changed");
    expect(send).not.toHaveBeenCalled();
    await dialogs.handle(7, dialogs.pending(7)!.id, false);
    expect(send).toHaveBeenCalledWith({ tabId: 7 }, { accept: false });
  });

  it("returns promptly from blocked native calls, retains their execution fence, and never replays cleanup", async () => {
    const native = deferred<unknown>();
    const run = vi.fn(() => native.promise);
    const dialogs = new JavaScriptDialogs(
      async () => {
        native.resolve({});
      },
      () => true,
    );
    const release = { type: "mouseReleased", button: "left" };
    const waiting = dialogs.run({ tabId: 7 }, "Input.dispatchMouseEvent", release, run);
    const rejected = expect(waiting).rejects.toBeInstanceOf(DialogPendingError);
    await dialogs.opened({ tabId: 7 }, { type: "confirm" });
    await rejected;
    await expect(
      dialogs.run({ tabId: 7 }, "Input.dispatchMouseEvent", release, run),
    ).rejects.toBeInstanceOf(DialogPendingError);
    expect(run).toHaveBeenCalledOnce();
    expect(dialogs.executionPending(7)).toBe(true);
    await dialogs.handle(7, dialogs.pending(7)!.id, false);
    expect(dialogs.executionPending(7)).toBe(false);
    await expect(dialogs.run({ tabId: 7 }, "Runtime.evaluate", {}, async () => 42)).resolves.toBe(
      42,
    );
  });

  it("does not mistake a closed dialog for completion of its original script", async () => {
    const native = deferred<unknown>();
    const dialogs = new JavaScriptDialogs(
      async () => {},
      () => true,
    );
    const rejected = expect(
      dialogs.run({ tabId: 7 }, "Runtime.evaluate", {}, () => native.promise),
    ).rejects.toBeInstanceOf(DialogPendingError);
    await dialogs.opened({ tabId: 7 }, { type: "confirm" });
    await rejected;
    dialogs.closed({ tabId: 7 }, { result: true });
    const another = vi.fn(async () => 42);
    await expect(dialogs.run({ tabId: 7 }, "Runtime.evaluate", {}, another)).rejects.toThrow(
      "still finishing",
    );
    expect(another).not.toHaveBeenCalled();
    native.resolve({});
    await vi.waitFor(() => expect(dialogs.executionPending(7)).toBe(false));
  });

  it("does not erase the next dialog when the previous handle response arrives late", async () => {
    const response = deferred<unknown>();
    const dialogs = new JavaScriptDialogs(
      () => response.promise,
      () => true,
    );
    await dialogs.opened({ tabId: 7 }, { type: "confirm", message: "first" });
    const handling = dialogs.handle(7, dialogs.pending(7)!.id, true);
    dialogs.closed({ tabId: 7 }, { result: true });
    await dialogs.opened({ tabId: 7 }, { type: "prompt", message: "second" });
    response.resolve({});
    await handling;
    expect(dialogs.pending(7)?.message).toBe("second");
    expect(dialogs.since(7, 0)).toHaveLength(1);
  });

  it("clears state on detach and ignores a late automatic-policy lookup", async () => {
    const policy = deferred<boolean>();
    const send = vi.fn(async () => {});
    const dialogs = new JavaScriptDialogs(send, () => policy.promise);
    const opening = dialogs.opened({ tabId: 7 }, { type: "alert" });
    dialogs.clear(7);
    policy.resolve(true);
    await opening;
    expect(send).not.toHaveBeenCalled();
    expect(dialogs.cursor(7)).toBe(0);
    expect(dialogs.pending(7)).toBeNull();
  });
});
