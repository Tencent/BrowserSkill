import type { CaptureTargetDescriptor } from "@/lib/describe-target";
import type {
  FillCommit,
  KeyModifier,
  NavigationCause,
  StepV3,
  TargetDescriptorV3,
} from "@/transport/types";

export interface TargetGeometry {
  /** Top-level viewport-relative CSS pixels, as defined by the geometry module. */
  rect: { x: number; y: number; w: number; h: number };
  tag: string;
}

export interface TargetMatchHint {
  geometry?: TargetGeometry;
  /** Missing means the current top frame, never an unrestricted frame search. */
  frameId?: string;
}

export interface StepAnnotation {
  draftId: number;
  op: StepV3["op"];
  line: number;
  stateId: string;
  detail?: string;
}

interface DraftStateLink {
  pageUrl?: string;
  preStateId?: string;
  postStateId?: string;
}

interface DraftTarget {
  captureTarget?: CaptureTargetDescriptor;
  targetHint?: TargetMatchHint;
  matchedTarget?: TargetDescriptorV3;
}

interface DraftNavigationEffect {
  navigatedTo?: string;
}

export type RecordingDraftStep =
  | ({ op: "click" } & DraftStateLink & DraftTarget & DraftNavigationEffect)
  | ({ op: "hover" } & DraftStateLink & DraftTarget)
  | ({
      op: "fill";
      value: string;
      commit?: FillCommit;
      redacted?: boolean;
    } & DraftStateLink &
      DraftTarget &
      DraftNavigationEffect)
  | ({
      op: "press";
      key: string;
      modifiers?: KeyModifier[];
    } & DraftStateLink &
      DraftTarget &
      DraftNavigationEffect)
  | ({
      op: "select";
      values: string[];
      labels?: string[];
    } & DraftStateLink &
      DraftTarget &
      DraftNavigationEffect)
  | ({ op: "scroll" } & DraftStateLink)
  | ({
      op: "navigate";
      url: string;
      cause?: NavigationCause;
      transitionType?: string;
      transitionQualifiers?: string[];
    } & DraftStateLink);

export type TargetedRecordingDraft = Extract<
  RecordingDraftStep,
  { op: "click" | "hover" | "fill" | "press" | "select" }
>;
