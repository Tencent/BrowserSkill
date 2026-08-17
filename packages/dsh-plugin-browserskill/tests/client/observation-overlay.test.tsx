// @vitest-environment happy-dom
// ObservationOverlay: visibility lifecycle, focus view, interrupt interaction,
// one-time hint, drag move/resize with clamps, collapse capsule, and PiP
// upgrade/fallback (mocked documentPictureInPicture). NOTE: use RTL's waitFor
// (act-flushing), not vi.waitFor, when asserting store-driven UI updates.

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ObservationOverlay } from "../../src/client/ObservationOverlay";
import { type EventSourceLike, ObservationClientStore } from "../../src/client/observation-store";
import type { SessionObservation } from "../../src/observation";

const BUSY: SessionObservation = { sessionId: "s1", action: "clicking", since: Date.now() - 7000 };

interface Harness {
  store: ObservationClientStore;
  es: () => EventSourceLike;
  push: (sessions: SessionObservation[]) => void;
  emitRaw: (event: unknown) => void;
  fetches: { url: string; init?: { body?: string } }[];
  loadImage: ReturnType<typeof vi.fn>;
}

function makeHarness(initial: SessionObservation[]): Harness {
  const fetches: Harness["fetches"] = [];
  let es: EventSourceLike | undefined;
  let current = initial;
  const loadImage = vi.fn(async (id: string) => `blob:${id}`);
  const store = new ObservationClientStore({
    fetchFn: async (url: string, init?: { body?: string }) => {
      fetches.push({ url, init });
      if (url === "/bsk-observation/state") {
        return { ok: true, json: async () => ({ sessions: current }) };
      }
      return { ok: true, json: async () => ({ interrupted: true }) };
    },
    eventSourceFactory: () => {
      es = { onmessage: null, close: vi.fn() };
      return es;
    },
    loadImage,
  });
  return {
    store,
    es: () => {
      if (es === undefined) throw new Error("no EventSource yet");
      return es;
    },
    push: (sessions) => {
      current = sessions;
      for (const s of sessions) {
        es?.onmessage?.({ data: JSON.stringify({ type: "upsert", session: s }) });
      }
      if (sessions.length === 0) es?.onmessage?.({ data: JSON.stringify({ type: "reset" }) });
    },
    emitRaw: (event) => {
      es?.onmessage?.({ data: JSON.stringify(event) });
    },
    fetches,
    loadImage,
  };
}

afterEach(cleanup);

describe("ObservationOverlay", () => {
  beforeEach(() => {
    delete (window as unknown as Record<string, unknown>).documentPictureInPicture;
  });

  it("renders nothing with no sessions, appears when one starts", async () => {
    const h = makeHarness([]);
    const { container } = render(<ObservationOverlay store={h.store} />);
    await waitFor(() => expect(h.es).not.toThrow());
    expect(container.firstChild).toBeNull();
    h.push([{ sessionId: "s1", action: "idle", since: Date.now() }]);
    await screen.findByText(/s1 · idle/);
    expect(screen.getByTestId("obs-card")).toBeTruthy();
  });

  it("shows the status row and a placeholder without a thumbnail", async () => {
    const h = makeHarness([BUSY]);
    render(<ObservationOverlay store={h.store} />);
    await screen.findByText(/s1 · clicking · 00:0/);
    expect(screen.getByText("waiting for page")).toBeTruthy();
  });

  it("loads and renders the thumbnail through the store", async () => {
    const h = makeHarness([{ ...BUSY, thumbnailAttachmentId: "att-9" }]);
    render(<ObservationOverlay store={h.store} />);
    await waitFor(() => expect(h.loadImage).toHaveBeenCalledWith("att-9"));
    await screen.findByRole("img", { name: "session s1 view" });
  });

  it("keeps the current frame on stage while the next thumbnail loads", async () => {
    let resolveNext: ((url: string) => void) | undefined;
    const h = makeHarness([{ ...BUSY, thumbnailAttachmentId: "att-1" }]);
    h.loadImage.mockImplementation(async (id: string) => {
      if (id === "att-2") {
        return new Promise<string>((resolve) => {
          resolveNext = resolve;
        });
      }
      return `blob:${id}`;
    });
    render(<ObservationOverlay store={h.store} />);
    const img = await screen.findByRole("img", { name: "session s1 view" });
    expect(img.getAttribute("src")).toBe("blob:att-1");
    h.push([{ ...BUSY, thumbnailAttachmentId: "att-2" }]);
    await waitFor(() => expect(h.loadImage).toHaveBeenCalledWith("att-2"));
    // Same <img> node, same src — no placeholder flash, no remount/fade.
    expect(screen.queryByText("waiting for page")).toBeNull();
    expect(screen.getByRole("img", { name: "session s1 view" })).toBe(img);
    expect(img.getAttribute("src")).toBe("blob:att-1");
    resolveNext?.("blob:att-2");
    await waitFor(() => expect(img.getAttribute("src")).toBe("blob:att-2"));
    expect(screen.getByRole("img", { name: "session s1 view" })).toBe(img);
  });

  it("interrupt: disabled while idle, active call posts and shows progress", async () => {
    const h = makeHarness([{ sessionId: "s1", action: "idle", since: Date.now() }]);
    render(<ObservationOverlay store={h.store} />);
    const button = await screen.findByRole("button", { name: /Interrupt the current/ });
    expect(button).toHaveProperty("disabled", true);
    h.push([BUSY]);
    await waitFor(() => expect(button).toHaveProperty("disabled", false));
    fireEvent.click(button);
    await waitFor(() =>
      expect(h.fetches.some((f) => f.url === "/bsk-observation/interrupt")).toBe(true),
    );
  });

  it("shows the semantics hint once", async () => {
    const h = makeHarness([BUSY]);
    render(<ObservationOverlay store={h.store} />);
    const button = await screen.findByRole("button", { name: /Interrupt the current/ });
    fireEvent.pointerEnter(button);
    await screen.findByRole("tooltip");
    fireEvent.pointerLeave(button);
    fireEvent.click(button);
    fireEvent.pointerEnter(button);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("collapses to a capsule and expands back", async () => {
    const h = makeHarness([BUSY]);
    render(<ObservationOverlay store={h.store} />);
    await screen.findByText(/s1 · clicking/);
    fireEvent.click(screen.getByRole("button", { name: "Collapse" }));
    const capsule = await screen.findByRole("button", {
      name: "Expand browser observation overlay",
    });
    expect(capsule.textContent).toContain("clicking");
    fireEvent.click(capsule);
    await screen.findByText(/s1 · clicking/);
  });

  it("resizes within min/max clamps", async () => {
    const h = makeHarness([BUSY]);
    render(<ObservationOverlay store={h.store} />);
    const card = await screen.findByTestId("obs-card");
    expect(Number.parseFloat(card.style.width)).toBe(320);
    fireEvent.pointerDown(screen.getByTestId("obs-resize"), { clientX: 100, clientY: 100 });
    fireEvent.pointerMove(document, { clientX: 40, clientY: 40 });
    fireEvent.pointerUp(document);
    expect(Number.parseFloat(card.style.width)).toBe(240); // min width clamp
    fireEvent.pointerDown(screen.getByTestId("obs-resize"), { clientX: 100, clientY: 100 });
    fireEvent.pointerMove(document, { clientX: 5000, clientY: 5000 });
    fireEvent.pointerUp(document);
    expect(Number.parseFloat(card.style.width)).toBe(window.innerWidth * 0.8);
  });

  it("moves the card with header drags, clamped to the viewport", async () => {
    const h = makeHarness([BUSY]);
    render(<ObservationOverlay store={h.store} />);
    const card = await screen.findByTestId("obs-card");
    fireEvent.pointerDown(screen.getByTestId("obs-header"), { clientX: 50, clientY: 50 });
    fireEvent.pointerMove(document, { clientX: -500, clientY: -500 });
    fireEvent.pointerUp(document);
    expect(card.style.left).toBe("0px");
    expect(card.style.top).toBe("0px");
  });

  it("hides Pop out when Document PiP is unsupported", async () => {
    const h = makeHarness([BUSY]);
    render(<ObservationOverlay store={h.store} />);
    await screen.findByText(/s1 · clicking/);
    expect(screen.queryByRole("button", { name: /Pop out/ })).toBeNull();
  });

  it("pops out with the card's current size and falls back on pagehide", async () => {
    const h = makeHarness([BUSY]);
    const pipDoc = document.implementation.createHTMLDocument("pip");
    const listeners = new Map<string, (() => void)[]>();
    const requestWindow = vi.fn(async (options?: { width?: number; height?: number }) => {
      void options;
      return {
        document: pipDoc,
        addEventListener: (name: string, fn: () => void) => {
          listeners.set(name, [...(listeners.get(name) ?? []), fn]);
        },
      } as unknown as Window;
    });
    (window as unknown as Record<string, unknown>).documentPictureInPicture = { requestWindow };
    render(<ObservationOverlay store={h.store} />);
    const popout = await screen.findByRole("button", { name: /Pop out/ });
    fireEvent.click(popout);
    await waitFor(() => expect(requestWindow).toHaveBeenCalledWith({ width: 320, height: 240 }));
    // Content now renders inside the PiP document.
    await waitFor(() => expect(pipDoc.body.textContent).toContain("s1"));
    // Closing the PiP returns to the in-page card with state preserved.
    for (const fn of listeners.get("pagehide") ?? []) fn();
    await screen.findByTestId("obs-card");
  });

  it("renders the strip for two sessions and pins focus on click", async () => {
    const older: SessionObservation = {
      sessionId: "s1",
      action: "idle",
      since: Date.now() - 60000,
    };
    const newer: SessionObservation = { sessionId: "s2", action: "clicking", since: Date.now() };
    const h = makeHarness([older, newer]);
    render(<ObservationOverlay store={h.store} />);
    // Auto-follows the most recently active session.
    await screen.findByText(/s2 · clicking/);
    const strip = screen.getByTestId("obs-strip");
    expect(strip.textContent).toContain("s1");
    expect(strip.textContent).toContain("s2");
    // Pin s1: focus moves and stays even when s2 gets newer activity.
    fireEvent.click(screen.getByRole("button", { name: "Pin session s1" }));
    await screen.findByText(/s1 · idle/);
    h.push([{ ...newer, since: Date.now() + 5000, action: "filling" }]);
    await waitFor(() => expect(screen.queryByText(/s2 · filling/)).toBeNull());
    expect(screen.getByText(/s1 · idle/)).toBeTruthy();
    // Unpin: auto-follow resumes.
    fireEvent.click(screen.getByRole("button", { name: "Unpin session s1" }));
    await screen.findByText(/s2 · filling/);
  });

  it("flags an errored strip item without stealing focus", async () => {
    const s1: SessionObservation = { sessionId: "s1", action: "idle", since: Date.now() - 30000 };
    const s2: SessionObservation = { sessionId: "s2", action: "idle", since: Date.now() - 10000 };
    const h = makeHarness([s1, s2]);
    render(<ObservationOverlay store={h.store} />);
    await screen.findByText(/s2 · idle/);
    // s2's latest action failed: red edge on its strip item, focus stays on s2 already…
    // now push an even-more-recent ERROR for s1 — focus must NOT jump to it.
    h.push([
      { ...s2, since: Date.now() - 5000 },
      { ...s1, since: Date.now(), lastError: "click failed" },
    ]);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Pin session s1" }).closest("[data-state]"),
      ).toHaveProperty("dataset", expect.objectContaining({ state: "error" })),
    );
    expect(screen.getByText(/s2 · idle/)).toBeTruthy();
  });

  it("shows browser-unavailable with a kept frame and a greyed interrupt", async () => {
    const h = makeHarness([{ ...BUSY, thumbnailAttachmentId: "att-1" }]);
    render(<ObservationOverlay store={h.store} />);
    await waitFor(() => expect(h.loadImage).toHaveBeenCalledWith("att-1"));
    await screen.findByRole("img", { name: "session s1 view" });
    h.emitRaw({ type: "availability", available: false });
    await screen.findByText("browser unavailable");
    // Last frame stays on stage; interrupt is greyed.
    expect(screen.getByRole("img", { name: "session s1 view" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Interrupt the current/ })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("greys out a dead session in the strip and skips it for focus", async () => {
    const s1: SessionObservation = { sessionId: "s1", action: "idle", since: Date.now() - 20000 };
    const s2: SessionObservation = { sessionId: "s2", action: "idle", since: Date.now() - 10000 };
    const h = makeHarness([s1, s2]);
    render(<ObservationOverlay store={h.store} />);
    await screen.findByText(/s2 · idle/);
    h.push([{ ...s1, dead: true, since: Date.now() }, s2]);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Pin session s1" }).closest("[data-state]"),
      ).toHaveProperty("dataset", expect.objectContaining({ state: "dead" })),
    );
    // Dead sessions never take the stage.
    expect(screen.getByText(/s2 · idle/)).toBeTruthy();
  });

  it("interrupts a strip session directly on hover without focusing it", async () => {
    const s1: SessionObservation = {
      sessionId: "s1",
      action: "clicking",
      since: Date.now() - 30000,
    };
    const s2: SessionObservation = { sessionId: "s2", action: "idle", since: Date.now() };
    const h = makeHarness([s1, s2]);
    render(<ObservationOverlay store={h.store} />);
    await screen.findByText(/s2 · idle/);
    const item = screen.getByRole("button", { name: "Pin session s1" }).closest("div");
    if (item === null) throw new Error("no strip item");
    fireEvent.pointerEnter(item);
    const mini = await screen.findByRole("button", { name: "Interrupt session s1" });
    fireEvent.click(mini);
    await waitFor(() =>
      expect(
        h.fetches.some(
          (f) => f.url === "/bsk-observation/interrupt" && f.init?.body === '{"sessionId":"s1"}',
        ),
      ).toBe(true),
    );
    // Focus did not move to s1.
    expect(screen.getByText(/s2 · idle/)).toBeTruthy();
  });
});
