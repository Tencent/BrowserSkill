import type { Message } from "@deepseek-ai/dsh-llm";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import { describe, expect, it } from "vitest";
import { createStepReceiptHandler } from "../src/step-receipt";

// The public SDK supplies the session on nested calls as well as direct calls.
describe("step receipt source compatibility", () => {
  it.each([3, 4])("preserves receipt evidence for session format %s", (version) => {
    const contexts: Message[] = [];
    const exec = {
      callId: "source-compatibility",
      parent: Symbol("run_code"),
      signal: new AbortController().signal,
      agent: { session: { header: { version } } },
      deferContext: (message: Message) => contexts.push(message),
    } as unknown as ToolRunContext;
    const receipt = { ok: false, action: { performed: true }, action_replayed: false };
    expect(() => createStepReceiptHandler().complete(exec, receipt)).toThrow(
      "Browser step needs attention",
    );
    expect(contexts).toHaveLength(1);
    expect(contexts[0].source).toEqual(
      version < 4
        ? { kind: "plugin", plugin: "@wxg-prc-cpg/browser-skill-dsh-plugin" }
        : { kind: "plugin:@wxg-prc-cpg/browser-skill-dsh-plugin" },
    );
    expect(contexts[0].content.at(-1)).toEqual({ type: "text", text: JSON.stringify(receipt) });
  });
});
