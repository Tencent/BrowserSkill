import { describe, expect, it, vi } from "vitest";
import { OVERLAY_HOST_MARKER_ATTR, OVERLAY_HOST_NAME } from "../../../lib/overlay-bridge";
import { captureViewModel, collectOverlayExcludedBackendIds, probeHoverSurfaces } from "../capture";

// Minimal but format-accurate captureSnapshot reply: a body with one
// fixed full-screen overlay div carrying a password input.
function fakeSnapshotReply() {
  // strings table
  const S = [
    "html",
    "body",
    "div",
    "input",
    "position",
    "fixed",
    "static",
    "pointer-events",
    "auto",
    "type",
    "password",
    "value",
    "hunter2",
  ];
  const i = (s: string) => S.indexOf(s);
  return {
    strings: S,
    documents: [
      {
        nodes: {
          parentIndex: [-1, 0, 1, 2],
          nodeType: [1, 1, 1, 1],
          nodeName: [i("html"), i("body"), i("div"), i("input")],
          backendNodeId: [10, 11, 12, 13],
          attributes: [[], [], [], [i("type"), i("password"), i("value"), i("hunter2")]],
          inputValue: { index: [3], value: [i("hunter2")] },
        },
        layout: {
          nodeIndex: [1, 2, 3],
          // Legacy fixture: omitted style columns fall back to visible defaults.
          styles: [
            [i("static"), i("auto")],
            [i("fixed"), i("auto")],
            [i("static"), i("auto")],
          ],
          bounds: [
            [0, 0, 1000, 4000],
            [0, 0, 1000, 800],
            [400, 300, 200, 40],
          ],
          paintOrders: [0, 50, 51],
        },
      },
    ],
  };
}

function hoverTriggerSnapshotReply() {
  const S = [
    "html",
    "body",
    "button",
    "class",
    "user-avatar",
    "position",
    "static",
    "pointer-events",
    "auto",
    "cursor",
    "pointer",
  ];
  const i = (s: string) => S.indexOf(s);
  return {
    strings: S,
    documents: [
      {
        nodes: {
          parentIndex: [-1, 0, 1],
          nodeType: [1, 1, 1],
          nodeName: [i("html"), i("body"), i("button")],
          backendNodeId: [10, 11, 12],
          attributes: [[], [], [i("class"), i("user-avatar")]],
        },
        layout: {
          nodeIndex: [1, 2],
          styles: [
            [i("static"), i("auto"), i("pointer")],
            [i("static"), i("auto"), i("pointer")],
          ],
          bounds: [
            [0, 0, 1000, 800],
            [940, 16, 32, 32],
          ],
          paintOrders: [0, 1],
        },
      },
    ],
  };
}

function twoHoverTriggerSnapshotReply() {
  const S = [
    "html",
    "body",
    "button",
    "class",
    "user-avatar",
    "secondary-dropdown-trigger",
    "position",
    "static",
    "pointer-events",
    "auto",
    "cursor",
    "pointer",
  ];
  const i = (s: string) => S.indexOf(s);
  return {
    strings: S,
    documents: [
      {
        nodes: {
          parentIndex: [-1, 0, 1, 1],
          nodeType: [1, 1, 1, 1],
          nodeName: [i("html"), i("body"), i("button"), i("button")],
          backendNodeId: [10, 11, 12, 13],
          attributes: [
            [],
            [],
            [i("class"), i("user-avatar")],
            [i("class"), i("secondary-dropdown-trigger")],
          ],
        },
        layout: {
          nodeIndex: [1, 2, 3],
          styles: [
            [i("static"), i("auto"), i("pointer")],
            [i("static"), i("auto"), i("pointer")],
            [i("static"), i("auto"), i("pointer")],
          ],
          bounds: [
            [0, 0, 1000, 800],
            [940, 16, 32, 32],
            [100, 120, 32, 32],
          ],
          paintOrders: [0, 1, 2],
        },
      },
    ],
  };
}

function nestedHoverTriggerSnapshotReply() {
  const S = [
    "html",
    "body",
    "div",
    "img",
    "class",
    "tg-avatar",
    "tg-avatar__inner",
    "tg-avatar__image",
    "position",
    "static",
    "pointer-events",
    "auto",
    "cursor",
    "pointer",
  ];
  const i = (s: string) => S.indexOf(s);
  return {
    strings: S,
    documents: [
      {
        nodes: {
          parentIndex: [-1, 0, 1, 2, 3],
          nodeType: [1, 1, 1, 1, 1],
          nodeName: [i("html"), i("body"), i("div"), i("div"), i("img")],
          backendNodeId: [10, 11, 12, 13, 14],
          attributes: [
            [],
            [],
            [i("class"), i("tg-avatar")],
            [i("class"), i("tg-avatar__inner")],
            [i("class"), i("tg-avatar__image")],
          ],
        },
        layout: {
          nodeIndex: [1, 2, 3, 4],
          styles: [
            [i("static"), i("auto"), i("pointer")],
            [i("static"), i("auto"), i("pointer")],
            [i("static"), i("auto"), i("pointer")],
            [i("static"), i("auto"), i("pointer")],
          ],
          bounds: [
            [0, 0, 1000, 800],
            [940, 16, 32, 32],
            [942, 18, 28, 28],
            [944, 20, 24, 24],
          ],
          paintOrders: [0, 1, 2, 3],
        },
      },
    ],
  };
}

function makeCdp(snapshot: unknown) {
  return {
    send: vi.fn(async (_tab: number, method: string) => {
      if (method === "DOMSnapshot.enable") return {};
      if (method === "DOMSnapshot.captureSnapshot") return snapshot;
      if (method === "Page.getLayoutMetrics") {
        return { cssLayoutViewport: { clientWidth: 1000, clientHeight: 800, pageX: 0, pageY: 0 } };
      }
      if (method === "Runtime.evaluate") {
        return {
          result: {
            value: {
              controls: [
                {
                  state: "filled",
                  sensitive: true,
                  defaultValue: "hunter2",
                  value: "hunter2",
                  placeholder: "secret",
                },
              ],
              childFrames: [],
            },
          },
        };
      }
      throw new Error(`unexpected ${method}`);
    }) as unknown as <T>(tabId: number, method: string, params?: object) => Promise<T>,
  };
}

describe("captureViewModel", () => {
  it("parses nodes, attrs, rects, paint order and styles", async () => {
    const { nodes, viewport, iframeNodes } = await captureViewModel(
      makeCdp(fakeSnapshotReply()),
      4,
    );
    expect(iframeNodes.size).toBe(0);
    expect(viewport).toEqual({ width: 1000, height: 800 });
    const div = nodes.find((n) => n.backendNodeId === 12);
    expect(div).toMatchObject({ tag: "div", position: "fixed", parentBackendNodeId: 11 });
    expect(div?.rect).toEqual({ x: 0, y: 0, w: 1000, h: 800 });
    expect(div?.paintOrder).toBe(50);
    const input = nodes.find((n) => n.backendNodeId === 13);
    expect(input?.attrs).toEqual({ type: "password" });
  });

  it("never hovers the page while capturing", async () => {
    const cdp = makeCdp(fakeSnapshotReply());
    await captureViewModel(cdp, 4);

    expect(cdp.send).not.toHaveBeenCalledWith(4, "Input.dispatchMouseEvent", expect.anything());
  });

  it("batch-enriches form controls without per-node object resolution", async () => {
    const cdp = makeCdp(fakeSnapshotReply());
    const result = await captureViewModel(cdp, 4);
    const input = result.nodes.find((node) => node.backendNodeId === 13);

    expect(input).toMatchObject({
      formState: "filled",
      formPlaceholder: "secret",
      attrs: { type: "password" },
    });
    expect(input?.formValue).toBeUndefined();
    expect(input?.formDefaultValue).toBeUndefined();
    expect(cdp.send).toHaveBeenCalledWith(
      4,
      "Runtime.evaluate",
      expect.objectContaining({ returnByValue: true }),
    );
    expect(cdp.send).not.toHaveBeenCalledWith(4, "DOM.resolveNode", expect.anything());
    expect(cdp.send).not.toHaveBeenCalledWith(4, "Runtime.callFunctionOn", expect.anything());
  });

  it("runs hover surface probes when explicitly enabled", async () => {
    let hoverStateCalls = 0;
    const cdp = {
      send: vi.fn(async (_tabId: number, method: string, params?: object) => {
        if (method === "DOMSnapshot.enable") return {};
        if (method === "DOMSnapshot.captureSnapshot") return hoverTriggerSnapshotReply();
        if (method === "Page.getLayoutMetrics") {
          return {
            cssLayoutViewport: { clientWidth: 1000, clientHeight: 800, pageX: 0, pageY: 0 },
          };
        }
        if (method === "Runtime.evaluate") {
          const expression = (params as { expression?: string } | undefined)?.expression ?? "";
          if (expression.includes("input,textarea,select")) {
            return { result: { value: { controls: [], childFrames: [] } } };
          }
          if (expression.includes("document.styleSheets")) {
            return { result: { value: [] } };
          }
          if (expression.includes("querySelectorAll(selectors)")) {
            hoverStateCalls += 1;
            return hoverStateCalls === 1
              ? { result: { value: [] } }
              : {
                  result: {
                    value: [
                      { text: "My profile", role: "", tag: "a", x: 900, y: 60 },
                      { text: "Sign out", role: "", tag: "a", x: 900, y: 90 },
                    ],
                  },
                };
          }
          throw new Error(`unexpected Runtime.evaluate: ${expression.slice(0, 80)}`);
        }
        if (method === "Input.dispatchMouseEvent") return {};
        throw new Error(`unexpected ${method}`);
      }) as unknown as <T>(tabId: number, method: string, params?: object) => Promise<T>,
    };

    const captured = await captureViewModel(cdp, 4);
    const surfaceProbes = await probeHoverSurfaces(cdp, 4, captured.nodes);

    expect(surfaceProbes).toEqual([
      {
        triggerBackendNodeId: 12,
        triggerPoint: { x: 956, y: 32 },
        triggerAction: "hover",
        subItems: ["My profile", "Sign out"],
        confidence: "high",
      },
    ]);
    expect(cdp.send).toHaveBeenCalledWith(
      4,
      "Input.dispatchMouseEvent",
      expect.objectContaining({ type: "mouseMoved", x: 956, y: 32 }),
    );
    expect(cdp.send).toHaveBeenCalledWith(
      4,
      "Input.dispatchMouseEvent",
      expect.objectContaining({ type: "mouseMoved", x: -10, y: -10 }),
    );
  });

  it("uses a fresh baseline for each hover candidate", async () => {
    let hoverStateCalls = 0;
    const cdp = {
      send: vi.fn(async (_tabId: number, method: string, params?: object) => {
        if (method === "DOMSnapshot.enable") return {};
        if (method === "DOMSnapshot.captureSnapshot") return twoHoverTriggerSnapshotReply();
        if (method === "Page.getLayoutMetrics") {
          return {
            cssLayoutViewport: { clientWidth: 1000, clientHeight: 800, pageX: 0, pageY: 0 },
          };
        }
        if (method === "Runtime.evaluate") {
          const expression = (params as { expression?: string } | undefined)?.expression ?? "";
          if (expression.includes("input,textarea,select")) {
            return { result: { value: { controls: [], childFrames: [] } } };
          }
          if (expression.includes("document.styleSheets")) {
            return { result: { value: [] } };
          }
          if (expression.includes("querySelectorAll(selectors)")) {
            hoverStateCalls += 1;
            const visibleMenu = [
              { text: "My profile", role: "", tag: "a", x: 900, y: 60 },
              { text: "Sign out", role: "", tag: "a", x: 900, y: 90 },
            ];
            return hoverStateCalls === 1
              ? { result: { value: [] } }
              : { result: { value: visibleMenu } };
          }
          throw new Error(`unexpected Runtime.evaluate: ${expression.slice(0, 80)}`);
        }
        if (method === "Input.dispatchMouseEvent") return {};
        throw new Error(`unexpected ${method}`);
      }) as unknown as <T>(tabId: number, method: string, params?: object) => Promise<T>,
    };

    const captured = await captureViewModel(cdp, 4);
    const surfaceProbes = await probeHoverSurfaces(cdp, 4, captured.nodes);

    expect(surfaceProbes).toEqual([
      expect.objectContaining({
        triggerBackendNodeId: 12,
        subItems: ["My profile", "Sign out"],
      }),
    ]);
    expect(hoverStateCalls).toBeGreaterThanOrEqual(4);
  });

  it("deduplicates nested hover candidates for one visual trigger", async () => {
    let hoverMoves = 0;
    const cdp = {
      send: vi.fn(async (_tabId: number, method: string, params?: object) => {
        if (method === "DOMSnapshot.enable") return {};
        if (method === "DOMSnapshot.captureSnapshot") return nestedHoverTriggerSnapshotReply();
        if (method === "Page.getLayoutMetrics") {
          return {
            cssLayoutViewport: { clientWidth: 1000, clientHeight: 800, pageX: 0, pageY: 0 },
          };
        }
        if (method === "Runtime.evaluate") {
          const expression = (params as { expression?: string } | undefined)?.expression ?? "";
          if (expression.includes("input,textarea,select")) {
            return { result: { value: { controls: [], childFrames: [] } } };
          }
          if (expression.includes("document.styleSheets")) {
            return { result: { value: [] } };
          }
          if (expression.includes("querySelectorAll(selectors)")) {
            return { result: { value: [] } };
          }
          throw new Error(`unexpected Runtime.evaluate: ${expression.slice(0, 80)}`);
        }
        if (method === "Input.dispatchMouseEvent") {
          const point = params as { x?: number; y?: number };
          if (point.x !== -10 && point.x !== 0) hoverMoves += 1;
          return {};
        }
        throw new Error(`unexpected ${method}`);
      }) as unknown as <T>(tabId: number, method: string, params?: object) => Promise<T>,
    };

    const captured = await captureViewModel(cdp, 4);
    await probeHoverSurfaces(cdp, 4, captured.nodes);

    expect(hoverMoves).toBe(1);
  });

  it("excludes the agent's own overlay shadow host and its inlined shadow subtree", async () => {
    // DOMSnapshot inlines an open shadow root's content as descendants of the
    // host. The agent's WXT overlay host carries a fixed full-viewport
    // click-blocker + the "中断" button. Capturing it makes the snapshot detect
    // the agent's own mask as a blocking layer and occlude the real page, so the
    // whole subtree must be dropped.
    const S = [
      "html",
      "body",
      "div",
      OVERLAY_HOST_NAME,
      "button",
      OVERLAY_HOST_MARKER_ATTR,
      "position",
      "fixed",
      "static",
      "pointer-events",
      "auto",
      "cursor",
      "pointer",
    ];
    const i = (s: string) => S.indexOf(s);
    const snapshot = {
      strings: S,
      documents: [
        {
          nodes: {
            parentIndex: [-1, 0, 1, 0, 3, 4],
            nodeName: [i("html"), i("body"), i("div"), i(OVERLAY_HOST_NAME), i("div"), i("button")],
            backendNodeId: [10, 11, 12, 13, 14, 15],
            attributes: [[], [], [], [i(OVERLAY_HOST_MARKER_ATTR), -1], [], []],
          },
          layout: {
            nodeIndex: [0, 1, 2, 3, 4, 5],
            styles: [
              [i("static"), i("auto"), i("auto")],
              [i("static"), i("auto"), i("auto")],
              [i("static"), i("auto"), i("auto")],
              [i("static"), i("auto"), i("auto")],
              [i("fixed"), i("auto"), i("auto")],
              [i("fixed"), i("auto"), i("pointer")],
            ],
            bounds: [
              [0, 0, 1000, 4000],
              [0, 0, 1000, 800],
              [10, 10, 200, 40],
              [0, 0, 0, 0],
              [0, 0, 1000, 800],
              [400, 750, 80, 40],
            ],
            paintOrders: [0, 1, 2, 3, 9, 10],
          },
        },
      ],
    };

    const { nodes } = await captureViewModel(makeCdp(snapshot), 4);
    const ids = nodes.map((n) => n.backendNodeId);
    // Real page nodes survive.
    expect(ids).toContain(12);
    // Overlay host + its inlined shadow subtree are gone.
    expect(ids).not.toContain(13);
    expect(ids).not.toContain(14);
    expect(ids).not.toContain(15);
  });

  it("returns excludedBackendNodeIds for the overlay host subtree", async () => {
    const S = [
      "html",
      "body",
      "div",
      OVERLAY_HOST_NAME,
      "button",
      OVERLAY_HOST_MARKER_ATTR,
      "position",
      "fixed",
      "static",
      "pointer-events",
      "auto",
      "cursor",
      "pointer",
    ];
    const i = (s: string) => S.indexOf(s);
    const snapshot = {
      strings: S,
      documents: [
        {
          nodes: {
            parentIndex: [-1, 0, 1, 0, 3, 4],
            nodeName: [i("html"), i("body"), i("div"), i(OVERLAY_HOST_NAME), i("div"), i("button")],
            backendNodeId: [10, 11, 12, 13, 14, 15],
            attributes: [[], [], [], [i(OVERLAY_HOST_MARKER_ATTR), -1], [], []],
          },
          layout: {
            nodeIndex: [0, 1, 2, 3, 4, 5],
            styles: [
              [i("static"), i("auto"), i("auto")],
              [i("static"), i("auto"), i("auto")],
              [i("static"), i("auto"), i("auto")],
              [i("static"), i("auto"), i("auto")],
              [i("fixed"), i("auto"), i("auto")],
              [i("fixed"), i("auto"), i("pointer")],
            ],
            bounds: [
              [0, 0, 1000, 4000],
              [0, 0, 1000, 800],
              [10, 10, 200, 40],
              [0, 0, 0, 0],
              [0, 0, 1000, 800],
              [400, 750, 80, 40],
            ],
            paintOrders: [0, 1, 2, 3, 9, 10],
          },
        },
      ],
    };

    const { excludedBackendNodeIds } = await captureViewModel(makeCdp(snapshot), 4);
    expect(excludedBackendNodeIds).toEqual(new Set([13, 14, 15]));
  });

  it("excludes overlay host matched by tag name only", async () => {
    const S = [
      "html",
      "body",
      OVERLAY_HOST_NAME,
      "position",
      "static",
      "pointer-events",
      "auto",
      "cursor",
      "auto",
    ];
    const i = (s: string) => S.indexOf(s);
    const snapshot = {
      strings: S,
      documents: [
        {
          nodes: {
            parentIndex: [-1, 0, 1],
            nodeName: [i("html"), i("body"), i(OVERLAY_HOST_NAME)],
            backendNodeId: [10, 11, 13],
            attributes: [[], [], []],
          },
          layout: {
            nodeIndex: [1, 2],
            styles: [
              [i("static"), i("auto"), i("auto")],
              [i("static"), i("auto"), i("auto")],
            ],
            bounds: [
              [0, 0, 1000, 800],
              [0, 0, 100, 40],
            ],
            paintOrders: [0, 1],
          },
        },
      ],
    };

    const { nodes, excludedBackendNodeIds } = await captureViewModel(makeCdp(snapshot), 4);
    expect(nodes.map((n) => n.backendNodeId)).not.toContain(13);
    expect(excludedBackendNodeIds).toEqual(new Set([13]));
  });

  it("excludes overlay host matched by marker attribute only", async () => {
    const S = [
      "html",
      "body",
      "div",
      OVERLAY_HOST_MARKER_ATTR,
      "position",
      "static",
      "pointer-events",
      "auto",
      "cursor",
      "auto",
    ];
    const i = (s: string) => S.indexOf(s);
    const snapshot = {
      strings: S,
      documents: [
        {
          nodes: {
            parentIndex: [-1, 0, 1],
            nodeName: [i("html"), i("body"), i("div")],
            backendNodeId: [10, 11, 13],
            attributes: [[], [], [i(OVERLAY_HOST_MARKER_ATTR), -1]],
          },
          layout: {
            nodeIndex: [1, 2],
            styles: [
              [i("static"), i("auto"), i("auto")],
              [i("static"), i("auto"), i("auto")],
            ],
            bounds: [
              [0, 0, 1000, 800],
              [0, 0, 100, 40],
            ],
            paintOrders: [0, 1],
          },
        },
      ],
    };

    const { nodes, excludedBackendNodeIds } = await captureViewModel(makeCdp(snapshot), 4);
    expect(nodes.map((n) => n.backendNodeId)).not.toContain(13);
    expect(excludedBackendNodeIds).toEqual(new Set([13]));
  });

  it("parses the computed cursor from the third style column", async () => {
    const S = [
      "html",
      "body",
      "div",
      "position",
      "static",
      "fixed",
      "pointer-events",
      "auto",
      "cursor",
      "pointer",
    ];
    const i = (s: string) => S.indexOf(s);
    const snapshot = {
      strings: S,
      documents: [
        {
          nodes: {
            parentIndex: [-1, 0, 1],
            nodeName: [i("html"), i("body"), i("div")],
            backendNodeId: [10, 11, 12],
            attributes: [[], [], []],
          },
          layout: {
            nodeIndex: [1, 2],
            // styles columns: [position, pointer-events, cursor]
            styles: [
              [i("static"), i("auto"), i("auto")],
              [i("fixed"), i("auto"), i("pointer")],
            ],
            bounds: [
              [0, 0, 1000, 800],
              [10, 10, 40, 40],
            ],
            paintOrders: [0, 1],
          },
        },
      ],
    };
    const { nodes } = await captureViewModel(makeCdp(snapshot), 4);
    expect(nodes.find((n) => n.backendNodeId === 12)?.cursor).toBe("pointer");
    expect(nodes.find((n) => n.backendNodeId === 11)?.cursor).toBe("auto");
  });

  it("captures painted visibility as DOM fallback evidence", async () => {
    const S = ["html", "body", "button", "static", "auto", "visible", "hidden", "1", "0"];
    const i = (value: string) => S.indexOf(value);
    const snapshot = {
      strings: S,
      documents: [
        {
          nodes: {
            parentIndex: [-1, 0, 1, 1, 1],
            nodeName: [i("html"), i("body"), i("button"), i("button"), i("button")],
            backendNodeId: [10, 11, 12, 13, 14],
            attributes: [[], [], [], [], []],
          },
          layout: {
            nodeIndex: [1, 2, 3, 4],
            styles: [
              [i("static"), i("auto"), i("auto"), i("visible"), i("1")],
              [i("static"), i("auto"), i("auto"), i("visible"), i("1")],
              [i("static"), i("auto"), i("auto"), i("hidden"), i("1")],
              [i("static"), i("auto"), i("auto"), i("visible"), i("0")],
            ],
            bounds: [
              [0, 0, 1000, 800],
              [10, 10, 100, 30],
              [10, 50, 100, 30],
              [10, 90, 100, 30],
            ],
            paintOrders: [0, 1, 2, 3],
          },
        },
      ],
    };

    const { nodes } = await captureViewModel(makeCdp(snapshot), 4);

    expect(nodes.find((node) => node.backendNodeId === 12)?.rendered).toBe(true);
    expect(nodes.find((node) => node.backendNodeId === 13)?.rendered).toBe(false);
    expect(nodes.find((node) => node.backendNodeId === 14)?.rendered).toBe(false);
  });

  it("subtracts scroll offset to make rects viewport-relative", async () => {
    const cdp = {
      send: vi.fn(async (_t: number, method: string) => {
        if (method === "DOMSnapshot.enable") return {};
        if (method === "DOMSnapshot.captureSnapshot") return fakeSnapshotReply();
        if (method === "Page.getLayoutMetrics") {
          return {
            cssLayoutViewport: { clientWidth: 1000, clientHeight: 800, pageX: 0, pageY: 200 },
          };
        }
        throw new Error(method);
      }) as unknown as <T>(tabId: number, method: string, params?: object) => Promise<T>,
    };
    const { nodes } = await captureViewModel(cdp, 4);
    const div = nodes.find((n) => n.backendNodeId === 12);
    expect(div?.localRect?.y).toBe(-200);
    expect(div?.rect).toMatchObject({ y: 0, h: 600 });
  });

  it("normalizes device-pixel bounds by devicePixelRatio", async () => {
    const S = ["html", "body", "div", "position", "fixed", "static", "pointer-events", "auto"];
    const i = (s: string) => S.indexOf(s);
    const snapshot = {
      strings: S,
      documents: [
        {
          nodes: {
            parentIndex: [-1, 0, 1],
            nodeName: [i("html"), i("body"), i("div")],
            backendNodeId: [10, 11, 12],
            attributes: [[], [], []],
          },
          layout: {
            nodeIndex: [1, 2],
            styles: [
              [i("static"), i("auto")],
              [i("fixed"), i("auto")],
            ],
            bounds: [
              [0, 0, 2000, 3200],
              [0, 0, 2000, 1600],
            ],
            paintOrders: [0, 50],
          },
        },
      ],
    };
    const cdp = {
      send: vi.fn(async (_t: number, method: string) => {
        if (method === "DOMSnapshot.enable") return {};
        if (method === "DOMSnapshot.captureSnapshot") return snapshot;
        if (method === "Page.getLayoutMetrics") {
          return {
            cssLayoutViewport: { clientWidth: 1000, clientHeight: 800, pageX: 0, pageY: 0 },
            layoutViewport: { clientWidth: 2000, clientHeight: 1600 },
          };
        }
        throw new Error(method);
      }) as unknown as <T>(tabId: number, method: string, params?: object) => Promise<T>,
    };
    const { nodes } = await captureViewModel(cdp, 4);
    expect(nodes.find((n) => n.backendNodeId === 12)?.rect).toEqual({
      x: 0,
      y: 0,
      w: 1000,
      h: 800,
    });
  });

  it("extracts textContent from #text child nodes via nodeValue", async () => {
    // Simulates a button with text "登录" and an <a> with text "忘记密码".
    // nodeValue is a parallel array: element nodes = -1, text nodes = string index.
    const S = [
      "html",
      "body",
      "button",
      "a",
      "position",
      "fixed",
      "static",
      "pointer-events",
      "auto",
      "登录",
      "忘记密码",
    ];
    const i = (s: string) => S.indexOf(s);
    const snapshot = {
      strings: S,
      documents: [
        {
          scrollOffsetX: 0,
          scrollOffsetY: 0,
          nodes: {
            parentIndex: [-1, 0, 1, 2, 1, 4],
            nodeName: [i("html"), i("body"), i("button"), i("#text"), i("a"), i("#text")],
            backendNodeId: [10, 11, 12, 13, 14, 15],
            attributes: [[], [], [], [], [], []],
            nodeValue: [-1, -1, -1, i("登录"), -1, i("忘记密码")],
          },
          layout: {
            nodeIndex: [1, 2, 4],
            styles: [
              [i("static"), i("auto")],
              [i("static"), i("auto")],
              [i("static"), i("auto")],
            ],
            bounds: [
              [0, 0, 1000, 800],
              [100, 300, 200, 60],
              [100, 380, 120, 36],
            ],
            paintOrders: [0, 10, 11],
          },
        },
      ],
    };
    const cdp = {
      send: vi.fn(async (_t: number, method: string) => {
        if (method === "DOMSnapshot.enable") return {};
        if (method === "DOMSnapshot.captureSnapshot") return snapshot;
        if (method === "Page.getLayoutMetrics") {
          return {
            cssLayoutViewport: { clientWidth: 1000, clientHeight: 800, pageX: 0, pageY: 0 },
          };
        }
        throw new Error(method);
      }) as unknown as <T>(tabId: number, method: string, params?: object) => Promise<T>,
    };
    const { nodes } = await captureViewModel(cdp, 4);
    const btn = nodes.find((n) => n.backendNodeId === 12);
    expect(btn?.textContent).toBe("登录");
    const link = nodes.find((n) => n.backendNodeId === 14);
    expect(link?.textContent).toBe("忘记密码");
    // Nodes without text children should have no textContent
    const body = nodes.find((n) => n.backendNodeId === 11);
    expect(body?.textContent).toBeUndefined();
  });

  it("parses iframe sub-documents and returns iframeNodes keyed by iframe backendNodeId", async () => {
    const S = [
      "html",
      "body",
      "div",
      "iframe",
      "input",
      "position",
      "fixed",
      "static",
      "pointer-events",
      "auto",
      "type",
      "text",
      "src",
      "https://passport.jd.com/login",
    ];
    const i = (s: string) => S.indexOf(s);
    const snapshot = {
      strings: S,
      documents: [
        {
          frameId: "main-frame",
          scrollOffsetX: 0,
          scrollOffsetY: 0,
          nodes: {
            parentIndex: [-1, 0, 1, 2],
            nodeName: [i("html"), i("body"), i("div"), i("iframe")],
            backendNodeId: [10, 11, 12, 13],
            attributes: [[], [], [], [i("src"), i("https://passport.jd.com/login")]],
            // Sparse: node at array-index 3 (the iframe, backendNodeId=13) → documents[1]
            contentDocumentIndex: { index: [3], value: [1] },
          },
          layout: {
            nodeIndex: [1, 2, 3],
            styles: [
              [i("static"), i("auto")],
              [i("fixed"), i("auto")],
              [i("static"), i("auto")],
            ],
            bounds: [
              [0, 0, 1000, 4000],
              [0, 0, 1000, 800],
              [100, 300, 800, 400],
            ],
            paintOrders: [0, 50, 51],
          },
        },
        // documents[1]: the iframe's sub-document with a login input
        {
          frameId: "child-frame",
          scrollOffsetX: 0,
          scrollOffsetY: 0,
          nodes: {
            parentIndex: [-1, 0],
            nodeName: [i("body"), i("input")],
            backendNodeId: [100, 101],
            attributes: [[], [i("type"), i("text")]],
          },
          layout: {
            nodeIndex: [1],
            styles: [[i("static"), i("auto")]],
            bounds: [[0, 0, 200, 40]],
            paintOrders: [0],
          },
        },
      ],
    };
    const cdp = {
      send: vi.fn(async (_t: number, method: string) => {
        if (method === "DOMSnapshot.enable") return {};
        if (method === "DOMSnapshot.captureSnapshot") return snapshot;
        if (method === "Page.getLayoutMetrics") {
          return {
            cssLayoutViewport: { clientWidth: 1000, clientHeight: 800, pageX: 0, pageY: 0 },
          };
        }
        throw new Error(method);
      }) as unknown as <T>(tabId: number, method: string, params?: object) => Promise<T>,
    };
    const {
      nodes,
      iframeNodes,
      frameNodes,
      frameOwnerBackendNodeIds,
      frameParentIds,
      rootFrameId,
    } = await captureViewModel(cdp, 4);
    // Main frame has 4 nodes; iframe is included
    expect(nodes.find((n) => n.backendNodeId === 13)?.tag).toBe("iframe");
    // iframeNodes keyed by the <iframe> element's backendNodeId=13
    expect(iframeNodes.size).toBe(1);
    expect(iframeNodes.has(13)).toBe(true);
    const subNodes = iframeNodes.get(13)!;
    const input = subNodes.find((n) => n.backendNodeId === 101);
    expect(input?.tag).toBe("input");
    expect(input?.attrs.type).toBe("text");
    expect(input?.ownerFrameBackendNodeId).toBe(13);
    expect(input?.localRect).toEqual({ x: 0, y: 0, w: 200, h: 40 });
    expect(input?.rect).toEqual({ x: 100, y: 300, w: 200, h: 40 });
    expect(rootFrameId).toBe("main-frame");
    expect(frameNodes?.get("child-frame")).toBe(subNodes);
    expect(frameOwnerBackendNodeIds?.get("child-frame")).toBe(13);
    expect(frameParentIds?.get("child-frame")).toBe("main-frame");
  });

  it("captures iframe documents without requiring owner-frame geometry", async () => {
    const S = [
      "html",
      "body",
      "iframe",
      "input",
      "position",
      "static",
      "pointer-events",
      "auto",
      "type",
      "text",
    ];
    const i = (s: string) => S.indexOf(s);
    const snapshot = {
      strings: S,
      documents: [
        {
          scrollOffsetX: 0,
          scrollOffsetY: 0,
          nodes: {
            parentIndex: [-1, 0, 1],
            nodeName: [i("html"), i("body"), i("iframe")],
            backendNodeId: [10, 11, 13],
            attributes: [[], [], []],
            contentDocumentIndex: { index: [2], value: [1] },
          },
          layout: {
            nodeIndex: [1],
            styles: [[i("static"), i("auto")]],
            bounds: [[0, 0, 1000, 800]],
            paintOrders: [0],
          },
        },
        {
          scrollOffsetX: 0,
          scrollOffsetY: 0,
          nodes: {
            parentIndex: [-1, 0],
            nodeName: [i("body"), i("input")],
            backendNodeId: [100, 101],
            attributes: [[], [i("type"), i("text")]],
          },
          layout: {
            nodeIndex: [1],
            styles: [[i("static"), i("auto")]],
            bounds: [[20, 20, 120, 60]],
            paintOrders: [0],
          },
        },
      ],
    };
    const cdp = {
      send: vi.fn(async (_t: number, method: string) => {
        if (method === "DOMSnapshot.enable") return {};
        if (method === "DOMSnapshot.captureSnapshot") return snapshot;
        if (method === "Page.getLayoutMetrics") {
          return {
            cssLayoutViewport: { clientWidth: 1000, clientHeight: 800, pageX: 0, pageY: 0 },
          };
        }
        throw new Error(method);
      }) as unknown as <T>(tabId: number, method: string, params?: object) => Promise<T>,
    };

    const { iframeNodes } = await captureViewModel(cdp, 4);
    const input = iframeNodes.get(13)?.find((n) => n.backendNodeId === 101);

    expect(input?.localRect).toEqual({ x: 20, y: 20, w: 120, h: 60 });
    expect(input?.rect).toBeNull();
  });

  it("recursively normalizes nested iframe sub-documents", async () => {
    const S = [
      "html",
      "body",
      "iframe",
      "input",
      "position",
      "static",
      "pointer-events",
      "auto",
      "type",
      "text",
    ];
    const i = (s: string) => S.indexOf(s);
    const snapshot = {
      strings: S,
      documents: [
        {
          nodes: {
            parentIndex: [-1, 0, 1],
            nodeName: [i("html"), i("body"), i("iframe")],
            backendNodeId: [10, 11, 13],
            attributes: [[], [], []],
            contentDocumentIndex: { index: [2], value: [1] },
          },
          layout: {
            nodeIndex: [1, 2],
            styles: [
              [i("static"), i("auto")],
              [i("static"), i("auto")],
            ],
            bounds: [
              [0, 0, 1000, 800],
              [10, 20, 300, 200],
            ],
            paintOrders: [0, 1],
          },
        },
        {
          nodes: {
            parentIndex: [-1, 0, 1],
            nodeName: [i("html"), i("body"), i("iframe")],
            backendNodeId: [20, 21, 23],
            attributes: [[], [], []],
            contentDocumentIndex: { index: [2], value: [2] },
          },
          layout: {
            nodeIndex: [1, 2],
            styles: [
              [i("static"), i("auto")],
              [i("static"), i("auto")],
            ],
            bounds: [
              [0, 0, 300, 200],
              [5, 6, 100, 80],
            ],
            paintOrders: [0, 1],
          },
        },
        {
          nodes: {
            parentIndex: [-1, 0],
            nodeName: [i("body"), i("input")],
            backendNodeId: [30, 31],
            attributes: [[], [i("type"), i("text")]],
          },
          layout: {
            nodeIndex: [1],
            styles: [[i("static"), i("auto")]],
            bounds: [[1, 2, 40, 20]],
            paintOrders: [0],
          },
        },
      ],
    };
    const cdp = {
      send: vi.fn(async (_t: number, method: string) => {
        if (method === "DOMSnapshot.enable") return {};
        if (method === "DOMSnapshot.captureSnapshot") return snapshot;
        if (method === "Page.getLayoutMetrics") {
          return {
            cssLayoutViewport: { clientWidth: 1000, clientHeight: 800, pageX: 0, pageY: 0 },
          };
        }
        throw new Error(method);
      }) as unknown as <T>(tabId: number, method: string, params?: object) => Promise<T>,
    };

    const { iframeNodes } = await captureViewModel(cdp, 4);
    const nestedIframe = iframeNodes.get(13)?.find((n) => n.backendNodeId === 23);
    const input = iframeNodes.get(23)?.find((n) => n.backendNodeId === 31);

    expect(nestedIframe?.localRect).toEqual({ x: 5, y: 6, w: 100, h: 80 });
    expect(nestedIframe?.rect).toEqual({ x: 15, y: 26, w: 100, h: 80 });
    expect(input?.ownerFrameBackendNodeId).toBe(23);
    expect(input?.localRect).toEqual({ x: 1, y: 2, w: 40, h: 20 });
    expect(input?.rect).toEqual({ x: 16, y: 28, w: 40, h: 20 });
  });

  it("normalizes bounds then subtracts CSS scroll at dpr>1", async () => {
    const S = ["html", "body", "div", "position", "fixed", "static", "pointer-events", "auto"];
    const i = (s: string) => S.indexOf(s);
    const snapshot = {
      strings: S,
      documents: [
        {
          nodes: {
            parentIndex: [-1, 0, 1],
            nodeName: [i("html"), i("body"), i("div")],
            backendNodeId: [10, 11, 12],
            attributes: [[], [], []],
          },
          layout: {
            nodeIndex: [1, 2],
            styles: [
              [i("static"), i("auto")],
              [i("fixed"), i("auto")],
            ],
            bounds: [
              [0, 0, 2000, 3200],
              [0, 400, 2000, 1600],
            ],
            paintOrders: [0, 50],
          },
        },
      ],
    };
    const cdp = {
      send: vi.fn(async (_t: number, method: string) => {
        if (method === "DOMSnapshot.enable") return {};
        if (method === "DOMSnapshot.captureSnapshot") return snapshot;
        if (method === "Page.getLayoutMetrics") {
          return {
            cssLayoutViewport: { clientWidth: 1000, clientHeight: 800, pageX: 0, pageY: 100 },
            layoutViewport: { clientWidth: 2000, clientHeight: 1600 },
          };
        }
        throw new Error(method);
      }) as unknown as <T>(tabId: number, method: string, params?: object) => Promise<T>,
    };
    const { nodes } = await captureViewModel(cdp, 4);
    expect(nodes.find((n) => n.backendNodeId === 12)?.rect?.y).toBe(400 / 2 - 100);
  });

  it("collectOverlayExcludedBackendIds walks the pierced overlay host subtree", async () => {
    const cdp = {
      send: vi.fn(async (_t: number, method: string) => {
        if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
        if (method === "DOM.querySelector") return { nodeId: 99 };
        if (method === "DOM.describeNode") {
          return {
            node: {
              backendNodeId: 200,
              shadowRoots: [
                { backendNodeId: 201, children: [{ backendNodeId: 202, children: [] }] },
              ],
            },
          };
        }
        throw new Error(method);
      }) as unknown as <T>(tabId: number, method: string, params?: object) => Promise<T>,
    };
    const excluded = await collectOverlayExcludedBackendIds(cdp, 4);
    expect(excluded).toEqual(new Set([200, 201, 202]));
  });
});
