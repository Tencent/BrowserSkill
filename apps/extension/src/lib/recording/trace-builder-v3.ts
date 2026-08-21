import {
  type StepV3,
  type StopReason,
  TRACE_VERSION_V3,
  type TraceStateV3,
  type TraceV3,
  VOM_FORMAT_VERSION,
} from "@/transport/types";
import { resolveDraftStartUrl } from "./draft-policy";
import type { RecordedStateEntry, RecordingStateRegistry } from "./state-registry";
import { reduceTraceStepsV3 } from "./trace-reducer-v3";
import { formatTraceStateBody } from "./trace-state-body";
import type { RecordingDraftStep, StepAnnotation } from "./types";

function publishedEntries(registry: RecordingStateRegistry, steps: StepV3[]): RecordedStateEntry[] {
  const entries = registry.values();
  if (steps.length === 0) return entries.slice(0, 1);
  const referenced = new Set(steps.flatMap((step) => [step.state, step.result.state]));
  return entries.filter((entry) => referenced.has(entry.id));
}

function remapDraftIds(draftIds: number[], stepIdByDraftId: Map<number, number>): number[] {
  return [
    ...new Set(
      draftIds.flatMap((id) => {
        const stepId = stepIdByDraftId.get(id);
        return stepId === undefined ? [] : [stepId];
      }),
    ),
  ].sort((a, b) => a - b);
}

export function buildTraceV3(input: {
  registry: RecordingStateRegistry;
  drafts: RecordingDraftStep[];
  annotations?: StepAnnotation[];
  startedAt: string;
  purpose?: string;
  startUrl?: string;
  stoppedBy: StopReason;
  bskVersion: string;
  redactValues?: boolean;
}): TraceV3 {
  const reduced = reduceTraceStepsV3(input.drafts, { redactValues: input.redactValues });
  const entries = publishedEntries(input.registry, reduced.steps);
  const publishedId = new Map(entries.map((entry, index) => [entry.id, `s${index + 1}`]));
  const annotationsByState = new Map<string, StepAnnotation[]>();
  for (const annotation of input.annotations ?? []) {
    const bucket = annotationsByState.get(annotation.stateId) ?? [];
    bucket.push(annotation);
    annotationsByState.set(annotation.stateId, bucket);
  }
  const steps = reduced.steps.map((step) => ({
    ...step,
    state: publishedId.get(step.state) ?? step.state,
    result: { state: publishedId.get(step.result.state) ?? step.result.state },
  }));
  const states: TraceStateV3[] = entries.map((entry) => {
    const id = publishedId.get(entry.id) ?? entry.id;
    return {
      id,
      url: entry.url,
      ...(entry.title ? { title: entry.title } : {}),
      body: formatTraceStateBody({
        stateId: id,
        url: entry.url,
        title: entry.title,
        stepIds: remapDraftIds(entry.stepsHere, reduced.stepIdByDraftId),
        vomText: entry.vomText,
        annotations: annotationsByState.get(entry.id) ?? [],
        stepIdByDraftId: reduced.stepIdByDraftId,
      }),
      ...(entry.truncated ? { truncated: true } : {}),
    };
  });

  return {
    version: TRACE_VERSION_V3,
    ...(input.purpose ? { purpose: input.purpose } : {}),
    recorded_at: new Date().toISOString(),
    started_at: input.startedAt,
    stopped_by: input.stoppedBy,
    entry: { start_url: resolveDraftStartUrl(input.drafts, input.startUrl, states[0]?.url) },
    recorder: { bsk: input.bskVersion, vom: VOM_FORMAT_VERSION },
    states,
    steps,
  };
}
