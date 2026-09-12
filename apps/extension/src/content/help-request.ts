import type { HelpQueryResponse, HelpRequestMessage } from "@/lib/help-bridge";
import type { HelpRequestData } from "./HelpRequestOverlay";

export interface HelpRequestDataDeps {
  finish(requestId: string, outcome: "continued" | "cancelled", note?: string): void;
  query(): Promise<HelpQueryResponse | undefined>;
}

/** Build the content-side representation shared by live delivery and recovery. */
export function createHelpRequestData(
  message: Omit<HelpRequestMessage, "type">,
  deps: HelpRequestDataDeps,
): HelpRequestData {
  return {
    id: message.requestId,
    prompt: message.prompt,
    ...(message.title ? { title: message.title } : {}),
    ...(message.displayMode ? { displayMode: message.displayMode } : {}),
    selectors: message.selectors,
    rects: message.rects,
    refreshRects: async () => {
      const response = await deps.query();
      return response?.active && response.request?.requestId === message.requestId
        ? response.request.rects
        : undefined;
    },
    onContinue: (note: string) =>
      deps.finish(message.requestId, "continued", note.trim() ? note : undefined),
    onCancel: () => deps.finish(message.requestId, "cancelled"),
  };
}
