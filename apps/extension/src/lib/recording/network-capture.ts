import type { CdpDebuggee } from "@/browser-driver/chromium-cdp";
import { redactUrl } from "@/debug/redact";
import type { CdpRunner } from "@/tools/shared";
import type { TraceRequest } from "@/transport/types";

const MAX_REQUESTS = 1_000;
// Prefer leaving delayed or ambiguous traffic unassigned.
const ACTION_WINDOW_MS = 500;

export type DraftRequest = Omit<TraceRequest, "step_id"> & { draftId: number | null };

interface RequestOrigin {
  tabId: number;
  frameId?: string;
  startedAt: number;
  documentUrl?: string;
  type?: string;
}

interface RequestCapture extends Omit<DraftRequest, "draftId"> {
  origin: RequestOrigin;
}

interface Action {
  draftId: number;
  capturedAt: number;
  pageUrl?: string;
}

export class RecordingNetworkCapture {
  readonly #tabs = new Map<number, () => void>();
  readonly #requests: RequestCapture[] = [];
  readonly #pending = new Map<string, RequestCapture>();
  readonly #actions = new Map<number, Map<string, Action[]>>();
  readonly #subscription: { dispose(): void };
  #disposed = false;

  constructor(
    private readonly cdp: CdpRunner,
    private readonly isTabAllowed: (tabId: number) => boolean,
  ) {
    if (!cdp.onEvent || !cdp.ensureNetworkCapture) {
      throw new Error("recording network capture requires CDP network events");
    }
    this.#subscription = cdp.onEvent((source, method, params) =>
      this.#onEvent(source, method, params),
    );
  }

  async armTab(tabId: number): Promise<void> {
    if (this.#disposed || !this.isTabAllowed(tabId)) return;
    if (!this.#tabs.has(tabId)) {
      this.#tabs.set(tabId, this.cdp.retainTabAttachment?.(tabId) ?? (() => {}));
    }
    await this.cdp.ensureNetworkCapture?.(tabId);
  }

  noteAction(tabId: number, frameId: string, action: Action): void {
    if (!Number.isFinite(action.capturedAt)) return;
    const frames = this.#actions.get(tabId) ?? new Map<string, Action[]>();
    const actions = frames.get(frameId) ?? [];
    actions.push({ ...action, pageUrl: action.pageUrl ? redactUrl(action.pageUrl) : undefined });
    frames.set(frameId, actions);
    this.#actions.set(tabId, frames);
  }

  snapshot(): DraftRequest[] {
    for (const frames of this.#actions.values()) {
      for (const actions of frames.values()) {
        actions.sort((a, b) => a.capturedAt - b.capturedAt || a.draftId - b.draftId);
      }
    }
    return this.#requests.map((request) => ({
      draftId: this.#draftFor(request.origin),
      method: request.method,
      url: request.url,
      status: request.status,
    }));
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#subscription.dispose();
    for (const release of this.#tabs.values()) release();
    this.#tabs.clear();
    this.#pending.clear();
  }

  #draftFor(request: RequestOrigin): number | null {
    if (!request.frameId) return null;
    const actions = this.#actions.get(request.tabId)?.get(request.frameId);
    if (!actions) return null;
    const index = actions.findLastIndex((action) => action.capturedAt <= request.startedAt);
    const action = actions[index];
    if (!action || request.startedAt - action.capturedAt > ACTION_WINDOW_MS) return null;
    if (request.type !== "Document" && (!action.pageUrl || action.pageUrl !== request.documentUrl))
      return null;
    return action.draftId;
  }

  #onEvent(source: CdpDebuggee, method: string, params: unknown): void {
    if (!method.startsWith("Network.")) return;
    const tabId = source.tabId;
    if (tabId === undefined || !this.#tabs.has(tabId) || !this.isTabAllowed(tabId)) return;
    if (!params || typeof params !== "object") return;
    const event = params as Record<string, unknown>;
    if (typeof event.requestId !== "string") return;
    const key = JSON.stringify([tabId, source.sessionId, event.requestId]);
    const pending = this.#pending.get(key);
    switch (method) {
      case "Network.requestWillBeSent": {
        const redirect = event.redirectResponse as { status?: number } | undefined;
        const previousHop = redirect ? pending : undefined;
        if (previousHop && Number.isInteger(redirect?.status))
          previousHop.status = redirect?.status ?? null;
        this.#pending.delete(key);
        const request = event.request as { method?: unknown; url?: unknown } | undefined;
        if (
          this.#requests.length >= MAX_REQUESTS ||
          typeof request?.method !== "string" ||
          typeof request.url !== "string" ||
          !/^https?:\/\//i.test(request.url) ||
          typeof event.wallTime !== "number" ||
          !Number.isFinite(event.wallTime)
        )
          return;
        const captured: RequestCapture = {
          origin: previousHop?.origin ?? {
            tabId,
            frameId: typeof event.frameId === "string" ? event.frameId : undefined,
            startedAt: event.wallTime * 1_000,
            documentUrl:
              typeof event.documentURL === "string" ? redactUrl(event.documentURL) : undefined,
            type: typeof event.type === "string" ? event.type : undefined,
          },
          method: request.method.slice(0, 32),
          url: redactUrl(request.url),
          status: null,
        };
        this.#requests.push(captured);
        this.#pending.set(key, captured);
        break;
      }
      case "Network.responseReceived": {
        const response = event.response as { status?: number } | undefined;
        if (pending && Number.isInteger(response?.status))
          pending.status = response?.status ?? null;
        break;
      }
      case "Network.loadingFinished":
      case "Network.loadingFailed":
        this.#pending.delete(key);
        break;
    }
  }
}
