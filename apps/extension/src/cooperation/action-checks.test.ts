import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionContext } from "@/session-manager/manager";
import { resolveActionTarget } from "@/tools/interaction";
import type { CdpRunner } from "@/tools/shared";
import {
  type ActionExpectation,
  checkActionTarget,
  checkExpectations,
  parseExpectations,
} from "./action-checks";

vi.mock("@/tools/interaction", () => ({ resolveActionTarget: vi.fn() }));
const tab = { tabId: 7, windowId: 100, active: true };
const target = {
  tab,
  backendNodeId: 4,
  cdpTarget: { tabId: 7, sessionId: "child" },
  usedRef: "e1",
};
const session = {} as SessionContext;

function fixture(html = '<button id="buy">Buy</button>') {
  document.body.innerHTML = html;
  const element = document.body.firstElementChild!;
  vi.spyOn(element, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
  const sendToTarget = vi.fn(async (_target, method, params) => {
    if (method === "DOM.resolveNode") return { object: { objectId: "node" } };
    if (method === "Runtime.callFunctionOn") {
      const read = new Function(`return (${params.functionDeclaration})`)();
      return {
        result: {
          value: read.apply(
            element,
            params.arguments.map((arg: { value: unknown }) => arg.value),
          ),
        },
      };
    }
    return {};
  });
  const cdp = { send: vi.fn(), sendToTarget } as unknown as CdpRunner;
  vi.mocked(resolveActionTarget).mockResolvedValue(target);
  return { cdp, element, sendToTarget };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("explicit action conditions", () => {
  it.each([
    null,
    {},
    [null],
    [{ target: "#a", field: "value", equals: true }],
    [{ target: "#a", field: "checked", equals: "true" }],
    [{ target: "#a", field: "attribute", equals: "42" }],
    [{ target: "#a", field: "attribute", attribute: "", equals: null }],
    [{ target: "#a", field: "text", equals: "ok", attribute: "id" }],
    [{ target: "#a", field: "text", equals: "ok", script: "submit()" }],
    [{ target: " ", field: "exists", equals: false }],
    Array.from({ length: 17 }, () => ({ target: "#a", field: "exists", equals: true })),
  ])("rejects malformed conditions before inspecting the page: %j", (value) => {
    expect(parseExpectations(value)).toMatchObject({
      code: "invalid_params",
      data: { reason: "precondition_invalid", effect_state: "none" },
    });
  });

  it("reports exact changed facts, releases its object group and checks the correct frame", async () => {
    const f = fixture('<span id="price">$200</span>');
    expect(
      await checkExpectations(f.cdp, session, tab, [
        { target: "#price", field: "text", equals: "$100" },
      ]),
    ).toMatchObject({
      code: "permission_denied",
      data: {
        reason: "precondition_failed",
        phase: "precondition",
        effect_state: "none",
        target: "#price",
        field: "text",
        expected: "$100",
        actual: "$200",
      },
    });
    expect(resolveActionTarget).toHaveBeenCalledWith(
      f.cdp,
      session,
      tab,
      { selector: "#price" },
      "precondition",
      true,
    );
    expect(f.sendToTarget.mock.calls.every(([node]) => node.sessionId === "child")).toBe(true);
    expect(f.sendToTarget.mock.calls.at(-1)?.[1]).toBe("Runtime.releaseObjectGroup");
  });

  it("checks a virtualized row's explicit record identity even when the DOM node persists", async () => {
    const f = fixture('<button data-record-id="B">Delete</button>');
    expect(
      await checkExpectations(f.cdp, session, tab, [
        { target: "@e1", field: "attribute", attribute: "data-record-id", equals: "A" },
      ]),
    ).toMatchObject({
      data: { field: "attribute", attribute: "data-record-id", expected: "A", actual: "B" },
    });
  });

  it("keeps literal text exact and never evaluates expected values", async () => {
    const f = fixture();
    const literal = "${window.submit()} `quoted`\n trailing ";
    f.element.textContent = literal;
    expect(
      await checkExpectations(f.cdp, session, tab, [
        { target: "@e1", field: "text", equals: literal },
      ]),
    ).toBeUndefined();
    expect(
      await checkExpectations(f.cdp, session, tab, [
        { target: "@e1", field: "text", equals: literal.trim() },
      ]),
    ).toMatchObject({ data: { actual: literal } });
  });

  it("reads live input properties, checked state and missing attributes", async () => {
    const f = fixture('<input type="checkbox" value="old">');
    const input = f.element as HTMLInputElement;
    input.checked = true;
    input.value = "new";
    expect(
      await checkExpectations(f.cdp, session, tab, [
        { target: "@e1", field: "value", equals: "new" },
        { target: "@e1", field: "checked", equals: true },
        { target: "@e1", field: "attribute", attribute: "data-absent", equals: null },
      ]),
    ).toBeUndefined();
  });

  it("distinguishes a missing selector from a stale ref or an ambiguous selector", async () => {
    const f = fixture();
    vi.mocked(resolveActionTarget).mockResolvedValueOnce({
      code: "not_found",
      message: "missing",
      data: { reason: "selector_not_found" },
    });
    expect(
      await checkExpectations(f.cdp, session, tab, [
        { target: "#removed", field: "exists", equals: false },
      ]),
    ).toBeUndefined();
    vi.mocked(resolveActionTarget).mockResolvedValueOnce({
      code: "not_found",
      message: "stale",
      data: { reason: "ref_not_found" },
    });
    expect(
      await checkExpectations(f.cdp, session, tab, [
        { target: "@e100", field: "exists", equals: false },
      ]),
    ).toMatchObject({ data: { reason: "ref_not_found", phase: "precondition" } });
    vi.mocked(resolveActionTarget).mockResolvedValueOnce({
      code: "invalid_params",
      message: "ambiguous",
    });
    expect(
      await checkExpectations(f.cdp, session, tab, [
        { target: "button", field: "exists", equals: true },
      ]),
    ).toMatchObject({ code: "invalid_params" });
  });
});

describe("target actionability", () => {
  it.each<ActionExpectation>([
    { target: "@e1", field: "value", equals: "old-value" },
    ...["value", "VALUE", "Value"].map((attribute) => ({
      target: "@e1",
      field: "attribute" as const,
      attribute,
      equals: "old-value",
    })),
  ])("does not expose sensitive control values in condition failures: %j", async (check) => {
    const f = fixture('<input type="password" value="private-value">');
    const result = await checkExpectations(f.cdp, session, tab, [check]);
    expect(result).toMatchObject({
      data: { reason: "precondition_failed", redacted: true, expected: "•••", actual: "•••" },
    });
    expect(JSON.stringify(result)).not.toContain("private-value");
    expect(JSON.stringify(result)).not.toContain("old-value");
  });
  it.each([
    ["detached", "target_detached"],
    ["hidden", "target_hidden"],
    ["disabled", "target_disabled"],
  ])("reports %s without examining neighbouring content", async (kind, reason) => {
    const f = fixture();
    if (kind === "detached") f.element.remove();
    if (kind === "hidden") (f.element as HTMLElement).style.visibility = "hidden";
    if (kind === "disabled") f.element.setAttribute("disabled", "");
    expect(await checkActionTarget(f.cdp, target, "tool.click")).toMatchObject({
      data: { reason, phase: "target", target: "@e1", effect_state: "none" },
    });
  });

  it("still allows hovering a disabled control and rejects filling a readonly input", async () => {
    let f = fixture("<button disabled>Help</button>");
    expect(await checkActionTarget(f.cdp, target, "tool.hover")).toBeUndefined();
    f = fixture('<input readonly value="locked">');
    expect(await checkActionTarget(f.cdp, target, "tool.fill")).toMatchObject({
      data: { reason: "target_readonly" },
    });
    expect(await checkActionTarget(f.cdp, target, "tool.focus")).toBeUndefined();
  });
});
