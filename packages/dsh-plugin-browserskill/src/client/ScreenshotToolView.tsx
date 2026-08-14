// browser_screenshot keyed toolview: the terminal card's command line and
// output stay exactly as the host renders them, and a result carrying an
// image block additionally renders the screenshot itself (thumbnail with the
// shared click-to-open lightbox). Pure function of the frozen call/result
// slice — live and replay paths render identically.

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
import css from "./ScreenshotToolView.module.css";

/** Resolved loader bound to the owning session at registration time. */
export type ScreenshotImageLoader = (attachment: ImageAttachmentRef) => Promise<string>;

export type ScreenshotToolViewProps = ToolCallViewProps & {
  loadImage: ScreenshotImageLoader;
};

type ViewState = "running" | "ok" | "error";

interface ViewModel {
  readonly state: ViewState;
  readonly command: string;
  readonly output: string | null;
  readonly image: ImageAttachmentRef | null;
  readonly summary: string;
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
function commandOf(argsRaw: string, callId: string): string {
  try {
    const args = JSON.parse(argsRaw) as { session?: unknown; ref?: unknown };
    const parts = ["bsk", "screenshot", "--session"];
    parts.push(
      typeof args.session === "string" && args.session !== "" ? args.session : "(current)",
    );
    if (typeof args.ref === "string" && args.ref !== "") parts.push("--ref", args.ref);
    return parts.join(" ");
  } catch {
    // Streaming can expose a truncated JSON prefix; it is still the best label.
    return argsRaw === "" ? `bsk screenshot (${callId})` : `bsk screenshot ${firstLine(argsRaw)}`;
  }
}

/** Derive the display model from the frozen block only. */
export function viewModelOf(block: ToolCallViewProps["block"]): ViewModel {
  const settled = "kind" in block;
  const argsRaw = (settled ? block.call?.argsRaw : block.argsRaw) ?? "";
  const command = commandOf(argsRaw, block.callId);
  if (!settled) {
    return { state: "running", command, output: null, image: null, summary: command };
  }
  const textBlock = block.content.find((item) => item.type === "text");
  const imageBlock = block.content.find((item) => item.type === "image");
  const output = textBlock !== undefined && textBlock.type === "text" ? textBlock.text : null;
  const image =
    imageBlock !== undefined && imageBlock.type === "image" ? imageBlock.attachment : null;
  const state: ViewState = block.isError ? "error" : "ok";
  const summary = output !== null ? firstLine(output) : command;
  return { state, command, output, image, summary };
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
 * Render one browser_screenshot call: a disclosure row over a terminal block
 * (command + output) plus the screenshot image when the result carries one.
 */
export function ScreenshotToolView({ block, cwd, inspect, loadImage }: ScreenshotToolViewProps) {
  const model = viewModelOf(block);
  const [expanded, setExpanded] = useState(false);
  const expandable = model.state === "running" || model.output !== null || model.image !== null;
  const open = expanded && expandable;
  return (
    <div className={css.card} data-tool="browser_screenshot" data-state={model.state}>
      <DisclosureRow
        icon={<StateDot state={dotState(model.state)} />}
        title="Screenshot"
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
