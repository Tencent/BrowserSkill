import type {
  JavaScriptDialogInfo,
  JavaScriptDialogType,
  PendingJavaScriptDialog,
} from "@/transport/types";
import type { CdpDebuggee } from "./chromium-cdp";

const MAX_DIALOG_BUFFER = 32;
const MAX_DIALOG_FIELD_LENGTH = 4096;
const DIALOG_SETTLE_TIMEOUT_MS = 1000;

interface LiveDialog {
  info: PendingJavaScriptDialog;
  target: CdpDebuggee;
  defaultPrompt: string;
  pending: boolean;
  handling: boolean;
}

export class DialogPendingError extends Error {
  constructor(readonly dialog: PendingJavaScriptDialog) {
    super(`JavaScript ${dialog.type} dialog is pending: ${dialog.message}`);
    this.name = "DialogPendingError";
  }
}

/** A native call cannot be cancelled by ending the caller's wait. */
export class DialogExecutionPendingError extends Error {
  constructor() {
    super("An earlier command is still finishing after a JavaScript dialog; do not repeat it");
    this.name = "DialogExecutionPendingError";
  }
}

/** Attachment-local dialog state and bounded history, shared by every CDP tool. */
export class JavaScriptDialogs {
  private readonly live = new Map<number, LiveDialog>();
  private readonly history = new Map<number, JavaScriptDialogInfo[]>();
  private readonly sequences = new Map<number, number>();
  private readonly listeners = new Set<(tabId: number) => void>();
  private readonly interrupted = new Map<number, Set<Promise<unknown>>>();
  private readonly cleanups = new Map<number, Map<string, Promise<unknown>>>();

  constructor(
    private readonly send: (target: CdpDebuggee, params: object) => Promise<unknown>,
    private readonly shouldAutoAccept: (tabId: number) => boolean | Promise<boolean>,
  ) {}

  cursor(tabId: number): number {
    return this.sequences.get(tabId) ?? 0;
  }

  since(tabId: number, cursor: number): JavaScriptDialogInfo[] {
    return (this.history.get(tabId) ?? []).filter((entry) => entry.sequence > cursor);
  }

  pending(tabId: number): PendingJavaScriptDialog | null {
    const live = this.live.get(tabId);
    return live?.pending ? { ...live.info } : null;
  }

  executionPending(tabId: number): boolean {
    return (this.interrupted.get(tabId)?.size ?? 0) > 0;
  }

  onPending(handler: (tabId: number) => void): { dispose(): void } {
    const listener = (tabId: number) => {
      if (this.pending(tabId)) handler(tabId);
    };
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  async opened(target: CdpDebuggee & { tabId: number }, params: unknown): Promise<void> {
    const raw = (params ?? {}) as Record<string, unknown>;
    const type = raw.type;
    if (!["alert", "confirm", "prompt", "beforeunload"].includes(String(type))) return;
    const sequence = this.cursor(target.tabId) + 1;
    this.sequences.set(target.tabId, sequence);
    const live: LiveDialog = {
      target,
      defaultPrompt: typeof raw.defaultPrompt === "string" ? raw.defaultPrompt : "",
      pending: false,
      handling: false,
      info: {
        id: crypto.randomUUID(),
        tab_id: target.tabId,
        type: type as JavaScriptDialogType,
        message: field(raw.message) ?? "",
        url: field(raw.url),
        default_prompt: field(raw.defaultPrompt),
        has_browser_handler:
          typeof raw.hasBrowserHandler === "boolean" ? raw.hasBrowserHandler : undefined,
        sequence,
      },
    };
    this.live.set(target.tabId, live);
    try {
      const automatic =
        (type === "alert" || type === "beforeunload") &&
        (await this.shouldAutoAccept(target.tabId));
      if (this.live.get(target.tabId) !== live) return;
      if (automatic) {
        await this.answer(live, true);
        return;
      }
    } catch (error) {
      // A failed policy lookup or auto-answer must leave the decision visible.
      console.debug("[bsk cdp] automatic dialog handling failed", error);
    }
    if (this.live.get(target.tabId) !== live) return;
    live.pending = true;
    this.changed(target.tabId);
  }

  closed(target: CdpDebuggee, params: unknown): void {
    if (target.tabId === undefined) return;
    const live = this.live.get(target.tabId);
    if (!live || live.target.sessionId !== target.sessionId) return;
    this.finish(live, (params as { result?: boolean } | undefined)?.result === true);
  }

  async handle(
    tabId: number,
    id: string,
    accept: boolean,
    text?: string,
  ): Promise<JavaScriptDialogInfo> {
    const live = this.live.get(tabId);
    if (!live?.pending || live.info.id !== id) throw new Error("The pending dialog has changed");
    if (live.handling) throw new Error("The pending dialog is already being handled");
    const result = await this.answer(live, accept, text);
    // Give already-dispatched native input a chance to finish. A script can
    // open another dialog or await a long promise; neither may hang this RPC.
    let timer: ReturnType<typeof setTimeout> | undefined;
    let changed!: (tab: number) => void;
    try {
      await Promise.race([
        Promise.allSettled([...(this.interrupted.get(tabId) ?? [])]),
        new Promise<void>((resolve) => {
          changed = (tab) => {
            if (tab === tabId && this.pending(tabId)) resolve();
          };
          this.listeners.add(changed);
          changed(tabId);
          timer = setTimeout(resolve, DIALOG_SETTLE_TIMEOUT_MS);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      this.listeners.delete(changed);
    }
    return result;
  }

  /** Stop waiting when a decision is needed; never replay the native call. */
  async run<T>(
    target: CdpDebuggee,
    method: string,
    params: object,
    run: () => Promise<T>,
  ): Promise<T> {
    if (target.tabId === undefined) return run();
    const tabId = target.tabId;
    const pending = this.pending(tabId);
    // Releases are cleanup, not new gestures. Queue them once even while the
    // renderer is blocked, without holding the tool RPC open behind a dialog.
    const cleanup =
      method === "Runtime.releaseObject" ||
      (method === "Input.dispatchMouseEvent" &&
        (params as { type?: string }).type === "mouseReleased") ||
      (method === "Input.dispatchKeyEvent" && (params as { type?: string }).type === "keyUp");
    const cleanupKey = cleanup
      ? `${target.sessionId ?? "root"}:${method}:${JSON.stringify(params)}`
      : undefined;
    if (pending) {
      if (cleanupKey && !this.cleanups.get(tabId)?.has(cleanupKey))
        this.retain(tabId, run(), cleanupKey);
      throw new DialogPendingError(pending);
    }
    if (this.executionPending(tabId) && !cleanup) throw new DialogExecutionPendingError();
    let listener!: (tab: number) => void;
    let native: Promise<T> | undefined;
    const decision = new Promise<never>((_, reject) => {
      listener = (tab) => {
        const dialog = tab === tabId ? this.pending(tabId) : null;
        if (!dialog) return;
        if (native) this.retain(tabId, native, cleanupKey);
        reject(new DialogPendingError(dialog));
      };
      this.listeners.add(listener);
    });
    try {
      native = run();
      listener(tabId);
      return await Promise.race([native, decision]);
    } finally {
      this.listeners.delete(listener);
    }
  }

  clear(tabId: number): void {
    this.live.delete(tabId);
    this.history.delete(tabId);
    this.sequences.delete(tabId);
    this.interrupted.delete(tabId);
    this.cleanups.delete(tabId);
    this.changed(tabId);
  }

  clearAll(): void {
    for (const tabId of new Set([
      ...this.live.keys(),
      ...this.history.keys(),
      ...this.interrupted.keys(),
    ]))
      this.clear(tabId);
  }

  private async answer(
    live: LiveDialog,
    accept: boolean,
    text?: string,
  ): Promise<JavaScriptDialogInfo> {
    live.handling = true;
    try {
      await this.send(live.target, {
        accept,
        ...(accept && live.info.type === "prompt"
          ? { promptText: text ?? live.defaultPrompt }
          : {}),
      });
      return this.finish(live, accept);
    } finally {
      live.handling = false;
    }
  }

  private finish(live: LiveDialog, accept: boolean): JavaScriptDialogInfo {
    const { id: _id, ...info } = live.info;
    const entry: JavaScriptDialogInfo = { ...info, handled: accept ? "accepted" : "dismissed" };
    const tabId = info.tab_id;
    // A closed event may beat the command response, or a new attachment/dialog
    // may already exist. Late replies must not delete it or duplicate history.
    if (this.live.get(tabId) === live) {
      this.live.delete(tabId);
      const history = this.history.get(tabId) ?? [];
      history.push(entry);
      if (history.length > MAX_DIALOG_BUFFER) history.shift();
      this.history.set(tabId, history);
      this.changed(tabId);
    }
    return entry;
  }

  private retain(tabId: number, native: Promise<unknown>, cleanupKey?: string): void {
    const calls = this.interrupted.get(tabId) ?? new Set<Promise<unknown>>();
    this.interrupted.set(tabId, calls);
    calls.add(native);
    const cleanups = this.cleanups.get(tabId) ?? new Map<string, Promise<unknown>>();
    if (cleanupKey) {
      this.cleanups.set(tabId, cleanups);
      cleanups.set(cleanupKey, native);
    }
    void native
      .catch(() => {})
      .finally(() => {
        calls.delete(native);
        if (cleanupKey && cleanups.get(cleanupKey) === native) cleanups.delete(cleanupKey);
      });
  }

  private changed(tabId: number): void {
    for (const listener of this.listeners) listener(tabId);
  }
}

function field(value: unknown): string | undefined {
  return typeof value === "string"
    ? value.length > MAX_DIALOG_FIELD_LENGTH
      ? `${value.slice(0, MAX_DIALOG_FIELD_LENGTH)}... [truncated]`
      : value
    : undefined;
}
