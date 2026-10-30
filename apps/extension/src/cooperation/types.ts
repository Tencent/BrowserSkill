/** The collector reports facts, never instructions or inferred user intent. */
export interface InputExpectation {
  type: "pointerdown" | "keydown" | "wheel";
  x?: number;
  y?: number;
  key?: string;
  /** Native event time in epoch milliseconds, shared across frame coordinate spaces. */
  timestamp?: number;
}

export interface FieldChange {
  id?: string;
  label: string;
  value: string;
  /** A positively identified, non-submitted media timeline. */
  kind?: "media_progress";
}

export interface HumanActivity {
  sequence: number;
  type: string;
  label: string;
  at?: number;
  target_id?: string;
  attribution?: {
    expected_time?: number;
    event_time: number;
    expected_type: string;
    expected_event_time?: { earliest: number; latest: number };
    event_timestamp?: number;
  };
  context?: string;
}

/** Media identity and source selection, excluding ordinary playback progress. */
export interface MediaState {
  id: string;
  src: string | null;
  currentSrc: string;
  srcObject: string | null;
  tracks?: string[];
  sources: { id: string; src: string; type: string; media: string }[];
}

export interface FrameState {
  document: string;
  /** Collector-local identity of the deep active element in this document. */
  focus?: string;
  /** True only for the ordinary document focus, without a specific recipient. */
  focusIsDocument?: boolean;
  media?: MediaState[];
  revision: number;
  structure: number;
  human: number;
  busy: boolean;
  editing: boolean;
  lastInput: number;
  fields: FieldChange[];
  fieldsComplete?: boolean;
  events: HumanActivity[];
}

export interface CooperationView {
  target?: { x: number; y: number; expires: number };
  revision: number;
  mode: "ready" | "human" | "held" | "yielding" | "syncing" | "acting" | "unavailable";
  editing: boolean;
  detail?: string;
}

export interface CooperationParams {
  session_id: string;
  tab_id?: number;
  action: "enable" | "status" | "sync" | "wait";
  timeout_ms?: number;
  max_tokens?: number;
  control_policy?: "auto" | "strict" | "target";
}

export const COOPERATION_READY = "cooperation.ready";
export const COOPERATION_MESSAGE = "cooperation.frame";
export const COOPERATION_CONTROL = "cooperation.control";
export const COOPERATION_READ = "cooperation.read";
export const COOPERATION_ARM = "cooperation.arm";
export const COOPERATION_RESUME = "cooperation.resume";
export const COOPERATION_DISABLE = "cooperation.disable";
