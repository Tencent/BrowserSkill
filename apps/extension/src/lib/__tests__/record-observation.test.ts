import { beforeEach, describe, expect, it } from "vitest";
import type { CapturedNode } from "@/tools/vom/capture";
import type { DraftTraceStep } from "@/transport/types";
import { resetStateIdCounterForTests } from "../record-constants";
import {
  applyTargetMatching,
  buildTraceV3,
  createObservationState,
  rememberStepOnPage,
} from "../record-observation";
import { registerObservation } from "../trace-reducer";

const URL = "https://example.com/login";

function capturedInput(): CapturedNode {
  return {
    backendNodeId: 42,
    parentBackendNodeId: null,
    tag: "input",
    attrs: {},
    rect: { x: 20, y: 40, w: 200, h: 30 },
    localRect: { x: 20, y: 40, w: 200, h: 30 },
    paintOrder: 1,
    position: "static",
    pointerEvents: "auto",
  };
}

function finalizedFillBody(value: string, redactValues: boolean): string {
  const obs = createObservationState({ redactValues });
  const rawVomText = '@vom 1\ntextbox "Password" value="••••••" [ref=e1]';
  const stateId = registerObservation(obs.stateRegistry, { url: URL, rawVomText });
  obs.lastSettled = {
    stateId,
    captured: [capturedInput()],
    matchNodes: [capturedInput()],
    documentTokenOwners: new Map(),
    refs: [{ ref: "e1", backendNodeId: 42, role: "textbox", name: "Password", line: 1 }],
    url: URL,
    vomText: rawVomText,
  };

  const draft: DraftTraceStep = {
    op: "fill",
    target: { unmatched: true },
    value,
    geometry: {
      rect: { x: 20, y: 40, w: 200, h: 30 },
      scrollX: 0,
      scrollY: 0,
      position: "static",
      tag: "input",
    },
  };
  applyTargetMatching(obs, draft, 1);
  draft.postStateId = stateId;
  rememberStepOnPage(obs, draft, 1);

  return (
    buildTraceV3({
      obs,
      steps: [draft],
      startedAt: "2026-08-12T00:00:00.000Z",
      stoppedBy: "user_finish",
      bskVersion: "test",
    }).states[0]?.body ?? ""
  );
}

describe("record observation annotations", () => {
  beforeEach(() => {
    resetStateIdCounterForTests();
  });

  it("omits a fill literal from finalized state bodies when values are redacted", () => {
    const secret = "hunter2-private";
    const body = finalizedFillBody(secret, true);

    expect(body).toContain("step 1: fill");
    expect(body).not.toContain(secret);
  });

  it("keeps fill details in ordinary recording annotations", () => {
    const value = "ordinary text";
    const body = finalizedFillBody(value, false);

    expect(body).toContain(`step 1: fill: ${JSON.stringify(value)}`);
  });
});

describe("applyTargetMatching without a settled observation", () => {
  it("keeps the capture role/name instead of a bare unmatched target", () => {
    const obs = createObservationState();
    const draft: DraftTraceStep = {
      op: "hover",
      target: { unmatched: true },
      captureTarget: { tag: "button", role: "button", name: "新建" },
      geometry: {
        rect: { x: 900, y: 8, w: 60, h: 32 },
        scrollX: 0,
        scrollY: 0,
        position: "static",
        tag: "button",
      },
    };

    applyTargetMatching(obs, draft, 1);

    expect(draft.preStateId).toBeUndefined();
    expect(draft.target).toEqual({
      role: "button",
      name: "新建",
      unmatched: true,
    });
  });
});
