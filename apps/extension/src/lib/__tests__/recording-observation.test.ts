import { describe, expect, it } from "vitest";
import { ObservationNodeIndex } from "../recording/observation-capture";
import { RecordingObservationSession } from "../recording/observation-session";
import { RecordingStateRegistry } from "../recording/state-registry";
import { buildTraceV3 } from "../recording/trace-builder-v3";
import type { RecordingDraftStep } from "../recording/types";

const URL = "https://example.com/login";

function sessionWithInput(redactValues = false): RecordingObservationSession {
  const session = new RecordingObservationSession({ redactValues });
  const state = session.registry.register({
    url: URL,
    vomText: '@vom 1\ntextbox "Password" value="••••••" [ref=e1]',
  });
  session.cursor.lastSettled = {
    stateId: state.id,
    rootFrameId: "root",
    index: new ObservationNodeIndex({
      rootFrameId: "root",
      matchNodes: [
        {
          frameId: "root",
          backendNodeId: 42,
          tag: "input",
          rect: { x: 20, y: 40, w: 200, h: 30 },
          localRect: { x: 20, y: 40, w: 200, h: 30 },
        },
      ],
      refs: [{ ref: "e1", backendNodeId: 42, role: "textbox", name: "Password", line: 1 }],
    }),
    url: URL,
  };
  return session;
}

function finalizedFillTrace(value: string, redactValues: boolean) {
  const session = sessionWithInput(redactValues);
  const draft: RecordingDraftStep = {
    op: "fill",
    captureTarget: { tag: "input", role: "textbox", name: "Password" },
    value,
    targetHint: {
      geometry: { rect: { x: 20, y: 40, w: 200, h: 30 }, tag: "input" },
    },
  };
  session.bindDraft(draft, 1);
  draft.postStateId = draft.preStateId;
  return buildTraceV3({
    registry: session.registry,
    drafts: [draft],
    annotations: session.annotations,
    startedAt: "2026-08-12T00:00:00.000Z",
    stoppedBy: "user_finish",
    bskVersion: "test",
    redactValues,
  });
}

function finalizedFillBody(value: string, redactValues: boolean): string {
  return finalizedFillTrace(value, redactValues).states[0]!.body;
}

describe("record observation annotations", () => {
  it("omits a fill literal when values are redacted", () => {
    const secret = "hunter2-private";
    const dumped = JSON.stringify(finalizedFillTrace(secret, true));
    expect(dumped).toContain("step 1: fill");
    expect(dumped).not.toContain(secret);
  });

  it("keeps ordinary fill details", () => {
    expect(finalizedFillBody("ordinary text", false)).toContain('step 1: fill: "ordinary text"');
  });

  it("encodes title and URL so line breaks cannot corrupt state metadata", () => {
    const registry = new RecordingStateRegistry();
    const state = registry.register({
      url: "https://example.com/a\nb",
      title: "hello\nworld",
      vomText: "@vom 1",
    });
    const trace = buildTraceV3({
      registry,
      drafts: [{ op: "scroll", preStateId: state.id, postStateId: state.id }],
      startedAt: "2026-08-12T00:00:00.000Z",
      stoppedBy: "user_finish",
      bskVersion: "test",
    });
    expect(trace.states[0]?.body).toContain('url: "https://example.com/a\\nb"');
    expect(trace.states[0]?.body).toContain('title: "hello\\nworld"');
  });
});

describe("recording state ownership", () => {
  it("deduplicates within one recording and isolates ids between recordings", () => {
    const first = new RecordingStateRegistry();
    const second = new RecordingStateRegistry();
    expect(first.register({ url: URL, vomText: "same" }).id).toBe("s1");
    expect(first.register({ url: URL, vomText: "same" }).id).toBe("s1");
    expect(second.register({ url: URL, vomText: "other" }).id).toBe("s1");
  });

  it("enriches metadata when a deduplicated observation becomes more complete", () => {
    const registry = new RecordingStateRegistry();
    registry.register({ url: URL, vomText: "same" });
    const state = registry.register({
      url: URL,
      title: "Login",
      vomText: "same",
      truncated: true,
    });
    expect(state).toMatchObject({ id: "s1", title: "Login", truncated: true });
  });
});

describe("draft binding", () => {
  it("keeps capture semantics when no observation exists", () => {
    const session = new RecordingObservationSession();
    const draft: RecordingDraftStep = {
      op: "hover",
      captureTarget: { tag: "button", role: "button", name: "新建" },
    };
    session.bindDraft(draft, 1);
    expect(draft.matchedTarget).toEqual({ role: "button", name: "新建", unmatched: true });
    expect(draft.preStateId).toBeUndefined();
  });

  it("does not bind an unmatched new action to a stale observation", () => {
    const session = sessionWithInput();
    const draft: RecordingDraftStep = {
      op: "click",
      captureTarget: { tag: "button", role: "button", name: "Confirm" },
      targetHint: {
        geometry: { rect: { x: 400, y: 300, w: 80, h: 30 }, tag: "button" },
      },
    };
    session.bindDraft(draft, 2, true);
    expect(draft.preStateId).toBeUndefined();
    expect("matchedTarget" in draft ? draft.matchedTarget : undefined).toEqual({
      role: "button",
      name: "Confirm",
      unmatched: true,
    });
  });
});
