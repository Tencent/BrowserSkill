import { describe, expect, it } from "vitest";
import { buildFrameGraph, type CdpFrameTreeNode, type CdpFrameTreeSource } from "../frame-graph";

describe("buildFrameGraph", () => {
  it("keeps sibling frames distinct and routes nested OOPIFs to their child sessions", () => {
    const graph = buildFrameGraph([
      {
        target: { tabId: 4 },
        tree: {
          frame: { id: "main", url: "https://app.test" },
          childFrames: [
            { frame: { id: "left", parentId: "main", url: "https://left.test" } },
            {
              frame: { id: "right", parentId: "main", url: "https://right.test" },
              childFrames: [
                { frame: { id: "nested", parentId: "right", url: "https://nested.test" } },
              ],
            },
          ],
        },
      },
      {
        target: { tabId: 4, sessionId: "right-session" },
        tree: {
          frame: { id: "right", url: "https://right.test" },
          childFrames: [{ frame: { id: "nested", parentId: "right", url: "https://nested.test" } }],
        },
      },
      {
        target: { tabId: 4, sessionId: "nested-session" },
        tree: { frame: { id: "nested", url: "https://nested.test" } },
      },
    ]);

    expect(graph?.frames).toHaveLength(4);
    expect(graph?.frames.find((frame) => frame.frameId === "left")?.target).toEqual({ tabId: 4 });
    expect(graph?.frames.find((frame) => frame.frameId === "right")).toMatchObject({
      parentFrameId: "main",
      target: { tabId: 4, sessionId: "right-session" },
    });
    expect(graph?.frames.find((frame) => frame.frameId === "nested")).toMatchObject({
      parentFrameId: "right",
      target: { tabId: 4, sessionId: "nested-session" },
    });
  });

  it("propagates each target boundary to its same-process descendants", () => {
    const sources: CdpFrameTreeSource[] = [
      {
        target: { tabId: 4 },
        tree: {
          frame: { id: "main" },
          childFrames: [
            {
              frame: { id: "oopif-a", parentId: "main" },
              childFrames: [
                {
                  frame: { id: "same-process-b", parentId: "oopif-a" },
                  childFrames: [
                    {
                      frame: { id: "oopif-c", parentId: "same-process-b" },
                      childFrames: [{ frame: { id: "same-process-d", parentId: "oopif-c" } }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
      {
        target: { tabId: 4, sessionId: "session-a" },
        tree: {
          frame: { id: "oopif-a" },
          childFrames: [
            {
              frame: { id: "same-process-b", parentId: "oopif-a" },
              childFrames: [{ frame: { id: "oopif-c", parentId: "same-process-b" } }],
            },
          ],
        },
      },
      {
        target: { tabId: 4, sessionId: "session-c" },
        tree: {
          frame: { id: "oopif-c" },
          childFrames: [{ frame: { id: "same-process-d", parentId: "oopif-c" } }],
        },
      },
    ];

    const graph = buildFrameGraph(sources);

    expect(graph?.frames.map((frame) => [frame.frameId, frame.target.sessionId])).toEqual([
      ["main", undefined],
      ["oopif-a", "session-a"],
      ["same-process-b", "session-a"],
      ["oopif-c", "session-c"],
      ["same-process-d", "session-c"],
    ]);
    expect(graph?.frames.find((frame) => frame.frameId === "oopif-a")?.parentFrameId).toBe("main");
    expect(graph?.frames.find((frame) => frame.frameId === "oopif-c")?.parentFrameId).toBe(
      "same-process-b",
    );

    const reordered = buildFrameGraph([sources[2], sources[1], sources[0]]);
    expect(reordered).toEqual(graph);
  });

  it("walks deeply nested frame trees without consuming the JavaScript call stack", () => {
    const depth = 5_000;
    const root: CdpFrameTreeNode = { frame: { id: "frame-0" } };
    let parent = root;
    for (let index = 1; index <= depth; index += 1) {
      const child: CdpFrameTreeNode = {
        frame: { id: `frame-${index}`, parentId: `frame-${index - 1}` },
      };
      parent.childFrames = [child];
      parent = child;
    }

    const graph = buildFrameGraph([{ target: { tabId: 4 }, tree: root }]);

    expect(graph?.frames).toHaveLength(depth + 1);
    expect(graph?.frames.at(-1)?.frameId).toBe(`frame-${depth}`);
  });

  it("does not loop when an in-memory frame tree contains an object cycle", () => {
    const root: CdpFrameTreeNode = { frame: { id: "main" } };
    root.childFrames = [root];

    expect(buildFrameGraph([{ target: { tabId: 4 }, tree: root }])?.frames).toEqual([
      { frameId: "main", target: { tabId: 4 } },
    ]);
  });
});
