import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import { describe, expect, it } from "vitest";
import { registerBrowserTools } from "../../src/browser-tools";
import type { ToolDeps } from "../../src/tools";

function interactionTool(): ToolDefinition {
  const tools = new Map<string, ToolDefinition>();
  registerBrowserTools({
    ctx: {
      tools: {
        register(definition: ToolDefinition) {
          tools.set(definition.name, definition);
          return () => tools.delete(definition.name);
        },
      },
    },
    config: { bskPath: "/custom/bsk" },
  } as unknown as ToolDeps);
  return tools.get("bsk_interact")!;
}

describe("gesture cards through the public interaction tool", () => {
  it("shows both range endpoints and the gesture mode on the pending terminal card", () => {
    const card = interactionTool().presentCall?.({
      action: "drag",
      target: "@e3",
      to: "@e8",
      dragMode: "click-move-click",
      session: "owned-session",
    });
    expect(card).toMatchObject({
      card: "terminal",
      title: "/custom/bsk drag @e3 --to @e8 --mode click-move-click --session owned-session",
    });
  });

  it("identifies a relative drag without inventing a destination", () => {
    expect(
      interactionTool().presentCall?.({ action: "drag", target: "@e3", deltaX: -40 }),
    ).toMatchObject({
      card: "terminal",
      title: "/custom/bsk drag @e3 --dx -40 --session (current)",
    });
  });

  it("shows the chosen step action and its readiness condition", () => {
    expect(
      interactionTool().presentCall?.({
        action: "step",
        stepAction: "click",
        params: '{"ref":"e3"}',
        untilVisible: "#details",
      }),
    ).toMatchObject({
      card: "terminal",
      title:
        '/custom/bsk step --action click --params {"ref":"e3"} --session (current) --until-visible #details',
    });
  });

  it.each([true, false])("preserves the full step receipt and its ok=%s status", (ok) => {
    const receipt = {
      ok,
      action: { result: { tab_id: 7 } },
      action_replayed: false,
      readiness: { satisfied: ok },
      post: { context_id: "next", observation: { text: "@vom 1\nL1 page" } },
    };
    const output = JSON.stringify(receipt);
    expect(
      interactionTool().presentResult?.(
        { action: "step", stepAction: "click", params: '{"ref":"e3"}' },
        { content: [{ type: "text", text: output }], isError: false },
      ),
    ).toEqual({ card: "terminal", output, exitCode: ok ? 0 : 1 });
  });

  it("keeps transport errors on the host error path instead of a successful terminal card", () => {
    for (const action of ["drag", "step"]) {
      expect(
        interactionTool().presentResult?.(
          { action },
          { content: [{ type: "text", text: "cancelled before dispatch" }], isError: true },
        ),
      ).toBeUndefined();
    }
  });
});
