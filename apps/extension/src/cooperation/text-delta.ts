import { estimateLineTokens } from "@browser-skill/vom";
import type { FrameState } from "./types";

type Frames = ReadonlyMap<number, FrameState>;

/** The page text an agent holds: its last full observation plus every delta since. */
export interface HeldText {
  text: string;
  truncated: boolean;
  maxTokens?: number;
  /** A delta rewrote this text after the capture that published the refs. */
  patched?: boolean;
}

/** One line of the held text, replaced in place. `line` is 1-based. */
export interface LinePatch {
  line: number;
  previous: string;
  text: string;
}

export interface TextDelta {
  text: string;
  lines: LinePatch[];
  changes: {
    frame_id: number;
    kind: "text";
    id: string;
    label: string;
    previous_value: string;
    value: string;
    lines: number[];
  }[];
  focusMoved: boolean;
}

/** Why a full observation was needed instead. Reported to the agent as `baseline_reason`. */
export type TextDeltaRefusal =
  | "no_held_text"
  | "token_budget_changed"
  | "document_replaced"
  | "multiple_frames"
  | "structure_changed"
  | "human_activity"
  | "fields_changed"
  | "focus_changed"
  | "text_log_gap"
  | "unlogged_activity"
  | "text_outside_observation"
  | "text_ambiguous"
  | "text_names_other_content"
  | "text_cut_by_truncation"
  | "token_budget_shift";

/** A name derived from content is cut here without a mark (semantic-graph/resolve.ts). */
const DERIVED_NAME_CAP = 240;
/** Headroom for the header and notice lines, which a capture costs as one block. */
const BUDGET_MARGIN = 64;
/** Inner text of a rendered name: the renderer collapses whitespace and writes JSON strings. */
const rendered = (value: string) => JSON.stringify(value.replace(/\s+/g, " ").trim()).slice(1, -1);
const depth = (line: string) => line.length - line.trimStart().length;
const QUOTED = /"((?:[^"\\]|\\.)*)"/;
/** `role "name"` and nothing else: no ref, state, value or context label. */
const nameOnly = (line: string) => /^ *[A-Za-z][\w-]* "((?:[^"\\]|\\.)*)"$/.exec(line)?.[1];

/**
 * Replaces one text in the held lines. Only two kinds of line may carry it: the
 * line of the text itself, and ancestors whose name is exactly their children's
 * names joined, which is how the renderer derives a name from content. Any other
 * line holding the text is a relation this cannot reproduce, so it refuses.
 */
function replaceText(
  lines: string[],
  touched: Map<number, string>,
  before: string,
  after: string,
): TextDeltaRefusal | number[] {
  const old = rendered(before);
  const next = rendered(after);
  if (old === next) return [];
  const hits = lines.flatMap((line, index) => (line.includes(old) ? [index] : []));
  const leaf = hits[hits.length - 1];
  if (leaf === undefined) return "text_outside_observation";
  if (nameOnly(lines[leaf]!) !== old) return "text_ambiguous";
  const ancestors = new Set<number>();
  for (let index = leaf - 1, limit = depth(lines[leaf]!); index >= 0 && limit > 0; index--) {
    const level = depth(lines[index]!);
    if (level >= limit) continue;
    ancestors.add(index);
    limit = level;
  }
  for (const hit of hits) {
    if (hit === leaf) continue;
    if (!ancestors.has(hit)) return "text_ambiguous";
    const line = lines[hit]!;
    const name = nameOnly(line);
    if (name === undefined || name.endsWith("…")) return "text_names_other_content";
    const level = depth(line);
    const children: string[] = [];
    for (let index = hit + 1; index < lines.length && depth(lines[index]!) > level; index++) {
      if (depth(lines[index]!) !== level + 2) continue;
      const child = QUOTED.exec(lines[index]!)?.[1];
      if (child === undefined) return "text_names_other_content";
      children.push(child);
    }
    if (
      children.join(" ") !== name ||
      name.split(old).length !== 2 ||
      // Escaped lengths are never shorter than the names themselves.
      name.length >= DERIVED_NAME_CAP ||
      name.length - old.length + next.length >= DERIVED_NAME_CAP
    )
      return "text_names_other_content";
  }
  // A label cut short may end inside this text. Then no line holds the whole
  // text, yet a fresh capture would show the cut copy differently.
  let common = 0;
  while (common < old.length && old[common] === next[common]) common++;
  if (common + 1 < old.length) {
    const probe = old.slice(0, common + 1);
    for (const line of lines) {
      const silent = /^ *@context /.test(line) || line.includes(" canvas ");
      for (let at = line.indexOf(probe); at >= 0; at = line.indexOf(probe, at + 1)) {
        let length = probe.length;
        while (length < old.length && line[at + length] === old[length]) length++;
        const end = line[at + length];
        if (length < old.length && (end === "…" || (silent && end === '"')))
          return "text_cut_by_truncation";
      }
    }
  }
  for (const index of hits) {
    if (!touched.has(index)) touched.set(index, lines[index]!);
    lines[index] = lines[index]!.replace(old, () => next);
  }
  return hits.map((index) => index + 1);
}

/**
 * Decides whether everything that happened since `old` is a set of logged text
 * replacements that can be applied to the held text, and applies them. Returns
 * the reason when it cannot: the caller then captures the page afresh.
 */
export function textDelta(
  held: HeldText | undefined,
  maxTokens: number | undefined,
  old: Frames,
  now: Frames,
): TextDelta | TextDeltaRefusal {
  if (!held) return "no_held_text";
  if (held.maxTokens !== maxTokens) return "token_budget_changed";
  if (old.size !== now.size) return "document_replaced";
  // ponytail: a frame vouches that a text is unique in its own document only, and
  // lines carry no frame. Pages with child frames re-capture; map lines to frames
  // when such pages need deltas.
  if (now.size !== 1) return "multiple_frames";
  const logged: Omit<TextDelta["changes"][number], "lines">[] = [];
  let focusMoved = false;
  for (const [frameId, frame] of now) {
    const before = old.get(frameId);
    if (before?.document !== frame.document) return "document_replaced";
    const seen = before.textual ?? 0;
    if (frame.structure - before.structure !== (frame.textual ?? 0) - seen)
      return "structure_changed";
    if (frame.human !== before.human) return "human_activity";
    if (JSON.stringify(frame.fields) !== JSON.stringify(before.fields)) return "fields_changed";
    if (frame.focus !== before.focus || frame.focusIsDocument !== before.focusIsDocument) {
      if (!before.focusNeutral || !frame.focusNeutral) return "focus_changed";
      focusMoved = true;
    }
    if ((frame.textFloor ?? 0) > seen) return "text_log_gap";
    for (const { sequence, ...text } of frame.texts ?? [])
      if (sequence > seen) logged.push({ frame_id: frameId, kind: "text", ...text });
  }
  // Activity that no frame can account for keeps requiring a fresh observation.
  if (!logged.length) return "unlogged_activity";
  const lines = held.text.split("\n");
  const touched = new Map<number, string>();
  const changes: TextDelta["changes"] = [];
  for (const change of logged) {
    const result = replaceText(lines, touched, change.previous_value, change.value);
    if (typeof result === "string") return result;
    if (!result.length) continue;
    // Report an element that changed twice once, from its first text to its last.
    const earlier = changes.find(
      (entry) => entry.id === change.id && entry.value === change.previous_value,
    );
    if (earlier) earlier.value = change.value;
    else changes.push({ ...change, lines: result });
  }
  const patch = [...touched]
    .filter(([index, previous]) => lines[index] !== previous)
    .sort(([a], [b]) => a - b)
    .map(([index, previous]) => ({ line: index + 1, previous, text: lines[index]! }));
  // A capture stops at the first line that exceeds the token budget. The
  // patched text must stop at the same line, or it is not what a capture shows.
  const cost = (side: "previous" | "text") =>
    patch.reduce((sum, line) => sum + estimateLineTokens(line[side]), 0);
  const grown = cost("text") - cost("previous");
  if (
    held.truncated
      ? grown !== 0
      : grown > 0 &&
        maxTokens !== undefined &&
        lines.reduce((sum, line) => sum + estimateLineTokens(line), BUDGET_MARGIN) > maxTokens
  )
    return "token_budget_shift";
  return {
    text: lines.join("\n"),
    lines: patch,
    changes: changes.filter((change) => change.previous_value !== change.value),
    focusMoved,
  };
}
