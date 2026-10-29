// @vitest-environment happy-dom
// Exercise the shipped Web renderer, which derives state from the settled
// ToolRuntime result rather than the legacy presentResult terminal card.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { ToolResultNode } from "@deepseek-ai/dsh-client-ui-chat/client";
import * as primitives from "@deepseek-ai/dsh-client-ui-primitives";
import { createToolResultMessage, ToolCallId } from "@deepseek-ai/dsh-llm";
import type { ToolExecutionResult } from "@deepseek-ai/dsh-tools";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { afterEach, expect, it } from "vitest";
import {
  createStepRuntime,
  STEP_CANCELLED,
  STEP_PARTIAL,
  STEP_SUCCESS,
  stepReply,
} from "../helpers/step-runtime";

afterEach(cleanup);

/** Load the real DSH plugin boundary and capture its whole-call renderer. */
function webToolTree(): React.ComponentType<Record<string, unknown>> {
  const source = readFileSync(
    createRequire(import.meta.url).resolve("@deepseek-ai/dsh-client-ui-tool/client"),
    "utf8",
  );
  const modules: Record<string, unknown> = {
    react: React,
    "react/jsx-runtime": jsxRuntime,
    "@deepseek-ai/dsh-client-ui-primitives": primitives,
  };
  let client!: { apply(ctx: unknown): void };
  new Function("window", source)({
    __ModuleLoader__: {
      load: ({ factory }: { factory: (require: (id: string) => unknown) => typeof client }) => {
        client = factory((id) => {
          if (!(id in modules)) throw new Error(`Unexpected Web renderer external: ${id}`);
          return modules[id];
        });
      },
    },
  });
  let ToolTree!: React.ComponentType<Record<string, unknown>>;
  client.apply({
    remote: { $host: {} },
    on: () => () => {},
    // Built-in keyed views do not claim bsk_interact; retain the real fallback.
    plugin() {},
    slots: {
      inject: (_name: string, callback: () => void) => callback(),
      register: (
        slot: { name: string; key?: string },
        component: React.ComponentType<Record<string, unknown>>,
      ) => {
        if (slot.name === "conversation.chat.node" && slot.key === "tool-call")
          ToolTree = component;
      },
    },
  });
  if (!ToolTree) throw new Error("DSH Web tool-call renderer was not registered");
  return ToolTree;
}

function renderCard(block: ToolResultNode) {
  const ToolTree = webToolTree();
  const labels: Record<string, string> = {
    "tool.title.generic": "Tool",
    "row.failed": "Failed",
  };
  const view = render(
    <ToolTree
      node={{ data: { root: block } }}
      renderSlot={(_name: string, _owner: unknown, options: { fallback: React.ReactNode }) =>
        options.fallback
      }
      useHostInfo={(selector: (host: object) => unknown) => selector({})}
      t={(key: string) => labels[key] ?? key}
      openFile={() => {}}
      inspectCall={() => {}}
      loadImage={() => Promise.resolve("")}
    />,
  );
  const card = view.container.querySelector<HTMLElement>('[data-tool="bsk_interact"]');
  if (!card) throw new Error("Default Web interaction card was not rendered");
  return {
    ...view,
    card,
    expand: () => fireEvent.click(within(card).getByRole("button", { name: /Tool/ })),
  };
}

it("does not consume the legacy terminal presenter's exit code for Web state", () => {
  const output = '{"ok":false,"action_replayed":false}';
  const { card, expand } = renderCard({
    kind: "tool-result",
    seq: 1,
    time: 0,
    callId: "legacy-step",
    call: { name: "bsk_interact", argsRaw: '{"action":"step"}' },
    callTime: 0,
    content: [{ type: "text", text: output }],
    isError: false,
    callView: null,
    resultView: { card: "terminal", output, exitCode: 1 },
    subCalls: [],
  } as unknown as ToolResultNode);
  // This is the pre-fix wire shape: a failed receipt with successful host state.
  // The following runtime cases must change the host state, not only a presenter.
  expect(card.dataset.state).toBe("ok");
  expand();
  expect(card.textContent).toContain(output);
});

const STEP_ARGS = { action: "step", stepAction: "click", params: '{"ref":"e1"}' };

/** Match the durable result boundary: content/isError plus error.info, without
 * rewriting cancellation codes or consulting host-only presentation callbacks. */
function resultBlock(result: ToolExecutionResult): ToolResultNode {
  const message = createToolResultMessage({
    callId: ToolCallId("web-step"),
    content: result.content,
    isError: result.isError,
  });
  const toolResult = message.content.find((block) => block.type === "tool-result");
  if (!toolResult) throw new Error("DSH did not create a tool result block");
  return {
    kind: "tool-result",
    seq: 1,
    time: 0,
    callId: "web-step",
    call: { name: "bsk_interact", argsRaw: JSON.stringify(STEP_ARGS) },
    callTime: 0,
    content: toolResult.content,
    isError: toolResult.isError,
    ...(result.isError && result.error.info ? { error: result.error.info } : {}),
    callView: null,
    resultView: null,
    subCalls: [],
  } as unknown as ToolResultNode;
}

it.each([
  true,
  false,
])("renders the actual runtime's step ok=%s result and complete receipt", async (ok) => {
  const receipt = ok ? STEP_SUCCESS : STEP_PARTIAL;
  let calls = 0;
  const host = await createStepRuntime(async () => {
    calls += 1;
    return stepReply(receipt, ok ? 0 : 1);
  });
  try {
    const result = await host.execute(undefined, STEP_ARGS, "web-step");
    expect(result.isError).toBe(!ok);
    const { card, expand } = renderCard(resultBlock(result));
    expect(card.dataset.state).toBe(ok ? "ok" : "error");
    if (!ok) expect(within(card).getByText("Failed")).toBeTruthy();
    expand();
    expect(card.textContent).toContain(JSON.stringify(receipt));
    expect(calls).toBe(1);
  } finally {
    await host.dispose();
  }
});

it("keeps a cancelled runtime result visibly failed with its original action receipt", async () => {
  const controller = new AbortController();
  let calls = 0;
  const host = await createStepRuntime(async () => {
    calls += 1;
    controller.abort();
    return stepReply(STEP_CANCELLED, 2, { aborted: true });
  });
  try {
    const result = await host.execute(controller, STEP_ARGS, "web-step");
    expect(result.isError).toBe(true);
    if (!result.isError) throw new Error("Cancelled runtime call unexpectedly succeeded");
    expect(result.error.info?.code).toBe("ABORTED");
    const { card, expand } = renderCard(resultBlock(result));
    // A settled ABORTED result is an error in DSH; "stopped" is reserved for
    // unfinished calls synthesized by the chat projection as interrupted.
    expect(card.dataset.state).toBe("error");
    expect(within(card).getByText("Failed")).toBeTruthy();
    expand();
    expect(card.textContent).toContain(JSON.stringify(STEP_CANCELLED));
    expect(calls).toBe(1);
  } finally {
    await host.dispose();
  }
});
