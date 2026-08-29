// browser_inspect keyed toolview: all inspect actions retain a terminal card;
// screenshot results additionally render the image attachment. Pure function
// of the frozen call/result slice, so live and replay paths stay identical.

import type { ImageAttachmentRef } from "@deepseek-ai/dsh-attachment";
import {
  type ImageLoader,
  MessageImage,
  type MessageImageLabels,
} from "@deepseek-ai/dsh-client-ui-attachment";
import {
  DisclosureRow,
  StateDot,
  type StateDotState,
  TerminalBlock,
  type TerminalBlockLabels,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { ToolCallViewProps } from "@deepseek-ai/dsh-client-ui-tool/client";
import { useState } from "react";
import css from "./BrowserInspectToolView.module.css";

/** Resolved loader bound to the owning session at registration time. */
export type BrowserInspectImageLoader = (attachment: ImageAttachmentRef) => Promise<string>;

export type BrowserInspectToolViewProps = ToolCallViewProps & {
  loadImage: BrowserInspectImageLoader;
};

type ViewState = "running" | "ok" | "error";

interface ViewModel {
  readonly state: ViewState;
  readonly command: string;
  readonly output: string | null;
  readonly image: ImageAttachmentRef | null;
  readonly summary: string;
  readonly title: string;
}

const TERMINAL_LABELS: Partial<TerminalBlockLabels> = {
  running: "Running",
  failed: "Failed",
  done: "Done",
  copy: "Copy",
  copied: "Copied",
  noOutput: "No output",
  collapseAria: "Collapse output",
  collapse: "Collapse",
  expandAria: (hidden) => `Expand the remaining ${hidden} output lines`,
  expand: (hidden) => `… ${hidden} more lines`,
};

const IMAGE_LABELS: MessageImageLabels = {
  image: "screenshot",
  open: "Open the original screenshot",
  openNamed: (label) => `Open screenshot ${label}`,
  loading: "Loading…",
  loadFailed: "Load failed — retry",
  lightbox: { dialog: "Screenshot preview", close: "Close preview" },
};

function firstLine(text: string): string {
  const newline = text.indexOf("\n");
  return newline === -1 ? text : text.slice(0, newline);
}

/** Rebuild the command line from the logged arguments (mirrors the host presenter). */
const INSPECT_COMMANDS: Record<string, string> = {
  observe: "observe",
  snapshot: "snapshot",
  html: "get-html",
  screenshot: "screenshot",
  console: "console",
  network: "network",
};

function titleOf(action: string): string {
  return action === "html" ? "HTML" : `${action.slice(0, 1).toUpperCase()}${action.slice(1)}`;
}

interface InspectArgs {
  action?: unknown;
  session?: unknown;
  tabId?: unknown;
  maxDepth?: unknown;
  maxTokens?: unknown;
  ref?: unknown;
  maxBytes?: unknown;
  since?: unknown;
  limit?: unknown;
  maxTextChars?: unknown;
  includeStack?: unknown;
}

function appendNumber(parts: string[], flag: string, value: unknown): void {
  if (typeof value === "number" && Number.isFinite(value)) parts.push(flag, String(value));
}

function commandOf(argsRaw: string, callId: string): { command: string; title: string } {
  try {
    const args = JSON.parse(argsRaw) as InspectArgs;
    const action = typeof args.action === "string" ? args.action : "inspect";
    const command = INSPECT_COMMANDS[action] ?? action;
    const parts = ["bsk", command, "--session"];
    parts.push(
      typeof args.session === "string" && args.session !== "" ? args.session : "(current)",
    );
    if (action === "observe" || action === "snapshot") {
      appendNumber(parts, "--max-depth", args.maxDepth);
      appendNumber(parts, "--max-tokens", args.maxTokens);
    }
    if (action === "html" || action === "console" || action === "network") {
      appendNumber(parts, "--tab-id", args.tabId);
    }
    if ((action === "html" || action === "screenshot") && typeof args.ref === "string") {
      if (args.ref !== "") parts.push("--ref", args.ref);
    }
    if (action === "html") appendNumber(parts, "--max-bytes", args.maxBytes);
    if (action === "console" || action === "network") {
      appendNumber(parts, "--since", args.since);
      appendNumber(parts, "--limit", args.limit);
      appendNumber(parts, "--max-text-chars", args.maxTextChars);
    }
    if (action === "console" && args.includeStack === true) parts.push("--include-stack");
    return { command: parts.join(" "), title: titleOf(action) };
  } catch {
    // Streaming can expose a truncated JSON prefix; it is still the best label.
    return {
      command:
        argsRaw === "" ? `browser_inspect (${callId})` : `browser_inspect ${firstLine(argsRaw)}`,
      title: "Inspect",
    };
  }
}

/** Derive the display model from the frozen block only. */
export function viewModelOf(block: ToolCallViewProps["block"]): ViewModel {
  const settled = "kind" in block;
  const argsRaw = (settled ? block.call?.argsRaw : block.argsRaw) ?? "";
  const { command, title } = commandOf(argsRaw, block.callId);
  if (!settled) {
    return { state: "running", command, output: null, image: null, summary: command, title };
  }
  const textBlock = block.content.find((item) => item.type === "text");
  const imageBlock = block.content.find((item) => item.type === "image");
  const output = textBlock !== undefined && textBlock.type === "text" ? textBlock.text : null;
  const image =
    imageBlock !== undefined && imageBlock.type === "image" ? imageBlock.attachment : null;
  const state: ViewState = block.isError ? "error" : "ok";
  const summary = output !== null ? firstLine(output) : command;
  return { state, command, output, image, summary, title };
}

function dotState(state: ViewState): StateDotState {
  switch (state) {
    case "running":
      return "ongoing";
    case "error":
      return "error";
    default:
      return "done";
  }
}

/**
 * Render one browser_inspect call: a disclosure row over a terminal block,
 * plus the screenshot image when that action returns an image attachment.
 */
export function BrowserInspectToolView({
  block,
  cwd,
  inspect,
  loadImage,
}: BrowserInspectToolViewProps) {
  const model = viewModelOf(block);
  const [expanded, setExpanded] = useState(false);
  const expandable = model.state === "running" || model.output !== null || model.image !== null;
  const open = expanded && expandable;
  return (
    <div className={css.card} data-tool="browser_inspect" data-state={model.state}>
      <DisclosureRow
        icon={<StateDot state={dotState(model.state)} />}
        title={model.title}
        open={open}
        expandable={expandable}
        onToggle={() => setExpanded((value) => !value)}
        expandOnRowClick
        previewChevron
        collapsedContent={<span className={css.summary}>{model.summary}</span>}
      >
        <div className={css.body}>
          <TerminalBlock
            command={model.command}
            cwd={cwd ?? undefined}
            output={model.output ?? undefined}
            running={model.state === "running"}
            labels={TERMINAL_LABELS}
          />
          {model.image !== null ? (
            <div className={css["image-wrap"]}>
              <MessageImage
                attachment={model.image}
                load={loadImage}
                variant="single"
                labels={IMAGE_LABELS}
              />
            </div>
          ) : null}
          {inspect !== undefined ? (
            <button type="button" className={css["inspect-button"]} onClick={inspect}>
              Inspect
            </button>
          ) : null}
        </div>
      </DisclosureRow>
    </div>
  );
}
