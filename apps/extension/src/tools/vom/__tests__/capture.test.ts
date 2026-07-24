import { describe, expect, it, vi } from "vitest";
import { OVERLAY_HOST_MARKER_ATTR, OVERLAY_HOST_NAME } from "../../../lib/overlay-bridge";
import { captureViewModel, collectOverlayExcludedBackendIds } from "../capture";

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
          attributes: [[], [], [], [i("type"), i("password")]],
        },
        layout: {
          nodeIndex: [1, 2, 3],
          // styles columns follow requested computedStyles order: [position, pointer-events]
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

function makeCdp(snapshot: unknown) {
  return {
    send: vi.fn(async (_tab: number, method: string) => {
      if (method === "DOMSnapshot.enable") return {};
      if (method === "DOMSnapshot.captureSnapshot") return snapshot;
      if (method === "Page.getLayoutMetrics") {
        return { cssLayoutViewport: { clientWidth: 1000, clientHeight: 800, pageX: 0, pageY: 0 } };
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
    // overlay div bounds y=0 minus scroll pageY=200 → y=-200
    expect(nodes.find((n) => n.backendNodeId === 12)?.rect?.y).toBe(-200);
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
    const { nodes, iframeNodes } = await captureViewModel(cdp, 4);
    // Main frame has 4 nodes; iframe is included
    expect(nodes.find((n) => n.backendNodeId === 13)?.tag).toBe("iframe");
    // iframeNodes keyed by the <iframe> element's backendNodeId=13
    expect(iframeNodes.size).toBe(1);
    expect(iframeNodes.has(13)).toBe(true);
    const subNodes = iframeNodes.get(13)!;
    expect(subNodes.find((n) => n.backendNodeId === 101)?.tag).toBe("input");
    expect(subNodes.find((n) => n.backendNodeId === 101)?.attrs.type).toBe("text");
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
