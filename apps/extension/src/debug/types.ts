import type { DebugRun } from "@/transport/types";

export type {
  DebugAction,
  DebugAnalysis,
  DebugBody,
  DebugConsole,
  DebugDuplicate,
  DebugEndpoint,
  DebugEvidence,
  DebugField,
  DebugFieldTrace,
  DebugIntervention,
  DebugMetric,
  DebugOperation,
  DebugPage,
  DebugParams,
  DebugPerformance,
  DebugRecording,
  DebugReplay,
  DebugReplaySpec,
  DebugRequest,
  DebugResult,
  DebugRule,
  DebugRuleSpec,
  DebugRun,
  DebugValue,
} from "@/transport/types";

export type DebugRequestEdit = Omit<
  Extract<import("@/transport/types").DebugRuleEffect, { type: "modify" }>,
  "type"
>;

export interface DebugTask {
  session_id: string;
  created_at: number;
  tab_id?: number;
  title?: string;
  url?: string;
  run?: DebugRun;
}
