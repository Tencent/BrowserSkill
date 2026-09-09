import { describe, expect, it, vi } from "vitest";
import { type CdpRunner, cdpRunnerForTarget } from "../../shared";
import { captureViewModel } from "../capture";

interface Control {
  id: number;
  value: string;
  type?: string;
}

function snapshot(groups: Control[][]) {
  const strings: string[] = [];
  const str = (value: string) => {
    let index = strings.indexOf(value);
    if (index < 0) index = strings.push(value) - 1;
    return index;
  };
  const documents = groups.map((controls, groupIndex) => ({
    frameId: `frame-${groupIndex}`,
    nodes: {
      parentIndex: [-1, 0, ...controls.map(() => 1)],
      nodeName: [str("html"), str("body"), ...controls.map(() => str("input"))],
      backendNodeId: [8000 + groupIndex * 2, 8001 + groupIndex * 2, ...controls.map((c) => c.id)],
      attributes: [
        [],
        [],
        ...controls.map((c) => [
          str("type"),
          str(c.type ?? "text"),
          str("placeholder"),
          str("snapshot placeholder"),
        ]),
      ],
      inputValue: {
        index: controls.map((_, i) => i + 2),
        value: controls.map((c) => str(c.value)),
      },
      contentDocumentIndex: { index: [] as number[], value: [] as number[] },
    },
  }));
  const root = documents[0].nodes;
  for (let i = 1; i < documents.length; i++) {
    root.contentDocumentIndex.index.push(root.backendNodeId.length);
    root.contentDocumentIndex.value.push(i);
    root.parentIndex.push(1);
    root.nodeName.push(str("iframe"));
    root.backendNodeId.push(9000 + i);
    root.attributes.push([]);
  }
  return { strings, documents };
}

function state(value: string) {
  return {
    value,
    defaultValue: "",
    placeholder: "live placeholder",
    state: value ? "filled" : "empty",
    sensitive: false,
  };
}

function reply(entries: Array<[number, unknown]>) {
  return {
    result: {
      deepSerializedValue: {
        type: "array",
        value: entries.map(([backendNodeId, fields]) => ({
          type: "array",
          value: [
            { type: "node", value: { backendNodeId } },
            { type: "string", value: JSON.stringify(fields) },
          ],
        })),
      },
    },
  };
}

function fakeCdp(groups: Control[][], evaluate: (params: Record<string, unknown>) => unknown) {
  const snap = snapshot(groups);
  const send = vi.fn(async (_tabId: number, method: string, params?: object) => {
    if (method === "DOMSnapshot.captureSnapshot") return snap;
    if (method === "Runtime.evaluate") return evaluate(params as Record<string, unknown>);
    return {};
  });
  return { send, cdp: { send: send as CdpRunner["send"] } };
}

describe("form state identity", () => {
  it("matches reordered controls by identity and preserves controls missing from the batch", async () => {
    // The snapshot includes a shadow input. The runtime query skips it,
    // encounters a new input, and sees the remaining inputs in a new order.
    const { cdp } = fakeCdp(
      [
        [
          { id: 10, value: "" },
          { id: 11, value: "old email" },
          { id: 12, value: "old city" },
        ],
      ],
      () =>
        reply([
          [99, state("new control")],
          [12, state("上海")],
          [11, state("alice@example.com")],
        ]),
    );
    const captured = await captureViewModel(cdp, 7);
    expect(captured.nodes.find((n) => n.backendNodeId === 10)).toMatchObject({
      formValue: "",
      formState: "empty",
      formPlaceholder: "snapshot placeholder",
    });
    expect(captured.nodes.find((n) => n.backendNodeId === 11)).toMatchObject({
      formValue: "alice@example.com",
    });
    expect(captured.nodes.find((n) => n.backendNodeId === 12)).toMatchObject({ formValue: "上海" });
    expect(captured.nodes.some((n) => n.backendNodeId === 99)).toBe(false);
  });

  it("does not shift state between frames when one frame is absent from the runtime batch", async () => {
    const { cdp } = fakeCdp(
      [
        [],
        [{ id: 11, value: "inaccessible frame" }],
        [{ id: 21, value: "old second" }],
        [{ id: 31, value: "old third" }],
      ],
      () =>
        reply([
          [31, state("third frame")],
          [21, state("second frame")],
        ]),
    );
    const captured = await captureViewModel(cdp, 7);
    const controls = [...captured.iframeNodes.values()].flat();
    expect(controls.find((n) => n.backendNodeId === 11)?.formValue).toBe("inaccessible frame");
    expect(controls.find((n) => n.backendNodeId === 21)?.formValue).toBe("second frame");
    expect(controls.find((n) => n.backendNodeId === 31)?.formValue).toBe("third frame");
  });

  it("keeps identical backend ids in different OOPIF targets separate", async () => {
    const sendToTarget = vi.fn(async (target, method) => {
      if (method === "DOMSnapshot.captureSnapshot") return snapshot([[{ id: 11, value: "old" }]]);
      if (method === "Runtime.evaluate") return reply([[11, state(target.sessionId)]]);
      return {};
    });
    const send = vi.fn(async () => {
      throw new Error("unexpected top-level target");
    });
    const cdp = { send, sendToTarget } as unknown as CdpRunner;
    for (const sessionId of ["left-frame", "right-frame"]) {
      const captured = await captureViewModel(cdpRunnerForTarget(cdp, { tabId: 7, sessionId }), 7);
      expect(captured.nodes.find((n) => n.backendNodeId === 11)?.formValue).toBe(sessionId);
      expect(sendToTarget).toHaveBeenCalledWith(
        { tabId: 7, sessionId },
        "Runtime.releaseObjectGroup",
        expect.anything(),
      );
    }
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    "unsupported",
    "legacy",
    "malformed",
    "invalid-state",
  ])("preserves snapshot data when enrichment is %s", async (mode) => {
    const { cdp, send } = fakeCdp([[{ id: 11, value: "snapshot value" }]], () => {
      if (mode === "unsupported") throw new Error("serialization unsupported");
      if (mode === "legacy") return { result: { value: { controls: [state("wrong value")] } } };
      const result = reply([
        [11, mode === "invalid-state" ? { value: "wrong value" } : state("wrong value")],
      ]);
      if (mode === "malformed")
        result.result.deepSerializedValue.value[0].value[1].value = "not json";
      return result;
    });
    const captured = await captureViewModel(cdp, 7);
    expect(captured.nodes.find((n) => n.backendNodeId === 11)).toMatchObject({
      formValue: "snapshot value",
      formPlaceholder: "snapshot placeholder",
    });
    expect(send).toHaveBeenCalledWith(7, "Runtime.releaseObjectGroup", expect.anything());
  });

  it("releases the batch's remote objects when capture is cancelled", async () => {
    const controller = new AbortController();
    const { cdp, send } = fakeCdp([[{ id: 11, value: "old" }]], () => {
      controller.abort();
      return reply([[11, state("new")]]);
    });
    await expect(captureViewModel(cdp, 7, { signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(send).toHaveBeenCalledWith(7, "Runtime.releaseObjectGroup", expect.anything());
  });

  it("skips entries without node identity while still applying valid entries", async () => {
    const { cdp } = fakeCdp(
      [
        [
          { id: 11, value: "snapshot value" },
          { id: 12, value: "old value" },
        ],
      ],
      () => {
        const result = reply([
          [11, state("wrong value")],
          [12, state("live value")],
        ]);
        const element = result.result.deepSerializedValue.value[0].value[0];
        delete (element.value as { backendNodeId?: number }).backendNodeId;
        return result;
      },
    );
    const captured = await captureViewModel(cdp, 7);
    expect(captured.nodes.find((n) => n.backendNodeId === 11)?.formValue).toBe("snapshot value");
    expect(captured.nodes.find((n) => n.backendNodeId === 12)?.formValue).toBe("live value");
  });

  it.each([
    "password",
    "text",
  ])("redacts a sensitive %s control after identity matching", async (type) => {
    const { cdp } = fakeCdp([[{ id: 11, value: "secret", type }]], () =>
      reply([[11, { ...state("secret"), sensitive: true }]]),
    );
    const captured = await captureViewModel(cdp, 7);
    const control = captured.nodes.find((n) => n.backendNodeId === 11);
    expect(control?.formState).toBe("filled");
    expect(control?.formValue).toBeUndefined();
    expect(control?.formDefaultValue).toBeUndefined();
    expect(control?.attrs.value).toBeUndefined();
  });

  it("keeps one bounded batch without per-control CDP queries", async () => {
    const controls = Array.from({ length: 251 }, (_, i) => ({ id: i + 1, value: "old" }));
    const elements = controls.map((c) => ({
      backendNodeId: c.id,
      tagName: "INPUT",
      type: "text",
      value: `live ${c.id}`,
      defaultValue: "",
      placeholder: "",
    }));
    const { cdp, send } = fakeCdp([controls], (params) => {
      const doc = {
        querySelectorAll: (selector: string) =>
          selector === "input,textarea,select" ? elements : [],
      };
      const entries = new Function("document", `return ${params.expression}`)(doc) as Array<
        [{ backendNodeId: number }, string]
      >;
      expect(entries).toHaveLength(250);
      return reply(entries.map(([element, json]) => [element.backendNodeId, JSON.parse(json)]));
    });
    const captured = await captureViewModel(cdp, 7);
    expect(captured.nodes.find((n) => n.backendNodeId === 250)?.formValue).toBe("live 250");
    expect(captured.nodes.find((n) => n.backendNodeId === 251)?.formValue).toBe("old");
    expect(send.mock.calls.filter(([, method]) => method === "Runtime.evaluate")).toHaveLength(1);
    expect(
      send.mock.calls.filter(([, method]) => method === "Runtime.releaseObjectGroup"),
    ).toHaveLength(1);
    expect(send).not.toHaveBeenCalledWith(7, "DOM.resolveNode", expect.anything());
    expect(send).not.toHaveBeenCalledWith(7, "Runtime.callFunctionOn", expect.anything());
  });
});
