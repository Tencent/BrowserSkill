import {
  encodeVomNameContent,
  estimateLineTokens,
  inspectVomLine,
  VOM_DERIVED_NAME_CAP,
  type VomLineMetadata,
} from "@browser-skill/vom";
import type { FrameState } from "./types";

type Frames = ReadonlyMap<number, FrameState>;

/** The page text an agent holds: its last full observation plus every delta since. */
export interface HeldText {
  text: string;
  truncated: boolean;
  maxTokens?: number;
  lineMeta?: readonly VomLineMetadata[];
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
  lineMeta: VomLineMetadata[];
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

/** Headroom for the header and notice lines, which a capture costs as one block. */
const BUDGET_MARGIN = 64;

/**
 * Returns the character index where searchable page content starts on `line`,
 * skipping VOM syntax prefixes (`@vom`, `L1 page`, `@eN`, role, drag hints).
 * Lines inside a `[§ active: ...]` block are raw body text, so their full
 * trimmed text is searchable and never patchable as a plain node.
 */
function contentSearchStart(
  meta: readonly VomLineMetadata[],
  index: number,
  activeScopeBody: readonly boolean[],
): number | undefined {
  const lineMeta = meta[index]!;
  if (activeScopeBody[index]) return lineMeta.indent;
  return lineMeta.contentStart;
}

function activeScopeBodyMask(meta: readonly VomLineMetadata[]): boolean[] {
  const mask = new Array<boolean>(meta.length).fill(false);
  let activeScopeIndent: number | undefined;
  for (let i = 0; i < meta.length; i += 1) {
    const entry = meta[i]!;
    if (entry.kind === "active-scope") {
      activeScopeIndent = entry.indent;
      continue;
    }
    if (activeScopeIndent !== undefined) {
      if (entry.indent > activeScopeIndent) {
        mask[i] = true;
        continue;
      }
      activeScopeIndent = undefined;
    }
  }
  return mask;
}

/**
 * Replaces one text in the held lines. Only two kinds of line may carry it: the
 * line of the text itself, and ancestors whose name is exactly their children's
 * names joined, which is how the renderer derives a name from content. Any other
 * line holding the text is a relation this cannot reproduce, so it refuses.
 */
function replaceText(
  lines: string[],
  meta: VomLineMetadata[],
  touched: Map<number, string>,
  before: string,
  after: string,
): TextDeltaRefusal | number[] {
  const old = encodeVomNameContent(before);
  const next = encodeVomNameContent(after);
  if (old === next) return [];
  if (!old) return "text_outside_observation";
  if (!next) return "structure_changed";
  const rawOld = before.replace(/\s+/g, " ").trim();
  const rawNext = after.replace(/\s+/g, " ").trim();
  const inActiveScope = activeScopeBodyMask(meta);
  const hits: number[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const start = contentSearchStart(meta, index, inActiveScope);
    if (start === undefined) continue;
    const line = lines[index]!;
    if (line.includes(old, start) || (rawOld !== old && line.includes(rawOld, start))) {
      hits.push(index);
    }
  }
  const leaf = hits[hits.length - 1];
  if (leaf === undefined) return "text_outside_observation";
  const leafMeta = meta[leaf]!;
  if (inActiveScope[leaf] || !leafMeta.plainNamedNode || leafMeta.escapedName !== old) {
    return "text_ambiguous";
  }
  const ancestors = new Set<number>();
  for (let index = leaf - 1, limit = leafMeta.indent; index >= 0 && limit > 0; index--) {
    const level = meta[index]!.indent;
    if (level >= limit) continue;
    ancestors.add(index);
    limit = level;
  }
  for (const hit of hits) {
    if (hit === leaf) continue;
    if (!ancestors.has(hit) || inActiveScope[hit]) return "text_ambiguous";
    const ancestorMeta = meta[hit]!;
    const name = ancestorMeta.escapedName;
    if (!ancestorMeta.plainNamedNode || name === undefined || name.endsWith("…"))
      return "text_names_other_content";
    const level = ancestorMeta.indent;
    const children: string[] = [];
    for (let index = hit + 1; index < lines.length && meta[index]!.indent > level; index++) {
      if (meta[index]!.indent !== level + 2) continue;
      if (inActiveScope[index]) return "text_names_other_content";
      const child = meta[index]!.escapedName;
      if (child === undefined) return "text_names_other_content";
      children.push(child);
    }
    if (
      children.join(" ") !== name ||
      name.split(old).length !== 2 ||
      // Escaped lengths are never shorter than the names themselves.
      name.length >= VOM_DERIVED_NAME_CAP ||
      name.length - old.length + next.length >= VOM_DERIVED_NAME_CAP
    )
      return "text_names_other_content";
  }
  // A label cut short may end inside this text. Then no line holds the whole
  // text, yet a fresh capture would show the cut copy differently.
  const hasTruncatedCopy = (sourceOld: string, sourceNext: string): boolean => {
    let common = 0;
    while (common < sourceOld.length && sourceOld[common] === sourceNext[common]) common++;
    if (common + 1 >= sourceOld.length) return false;
    const probe = sourceOld.slice(0, common + 1);
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const start = contentSearchStart(meta, lineIndex, inActiveScope);
      if (start === undefined) continue;
      const line = lines[lineIndex]!;
      const silent = meta[lineIndex]!.silentlyTruncatesLabel;
      const isScopeBody = inActiveScope[lineIndex];
      for (let at = line.indexOf(probe, start); at >= 0; at = line.indexOf(probe, at + 1)) {
        let length = probe.length;
        while (length < sourceOld.length && line[at + length] === sourceOld[length]) length++;
        const end = line[at + length];
        if (
          length < sourceOld.length &&
          (end === "…" || (silent && end === '"') || (isScopeBody && end === undefined))
        ) {
          return true;
        }
      }
    }
    return false;
  };
  if (hasTruncatedCopy(old, next) || (rawOld !== old && hasTruncatedCopy(rawOld, rawNext))) {
    return "text_cut_by_truncation";
  }
  for (const index of hits) {
    const line = lines[index]!;
    const currentMeta =
      meta[index]!.nameStart !== undefined && meta[index]!.nameEnd !== undefined
        ? meta[index]!
        : inspectVomLine(line);
    if (currentMeta.nameStart === undefined || currentMeta.nameEnd === undefined) {
      return "text_ambiguous";
    }
    if (!touched.has(index)) touched.set(index, line);
    const { nameStart, nameEnd } = currentMeta;
    const updatedName =
      index === leaf ? next : line.slice(nameStart, nameEnd).replace(old, () => next);
    lines[index] = `${line.slice(0, nameStart)}${updatedName}${line.slice(nameEnd)}`;
    meta[index] = inspectVomLine(lines[index]!);
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
  const meta =
    held.lineMeta && held.lineMeta.length === lines.length
      ? [...held.lineMeta]
      : lines.map((line) => inspectVomLine(line));
  const touched = new Map<number, string>();
  const changes: TextDelta["changes"] = [];
  for (const change of logged) {
    const result = replaceText(lines, meta, touched, change.previous_value, change.value);
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
    lineMeta: meta,
    lines: patch,
    changes: changes.filter((change) => change.previous_value !== change.value),
    focusMoved,
  };
}
