import { COOPERATION_ARM_FRAME } from "@/cooperation/types";

export const OVERLAY_CONTENT_SCRIPT_FILE = "content-scripts/content.js";
export const COOPERATION_CONTENT_SCRIPT_FILE = "content-scripts/cooperation.js";
export const RECORD_FRAME_CONTENT_SCRIPT_FILE = "content-scripts/record-frame.js";
export const LONG_SCREENSHOT_CONTENT_SCRIPT_FILE = "content-scripts/long-screenshot-page.js";

export const COOPERATION_SCRIPT_ID = "bsk-tier-b-cooperation";
export const RECORD_FRAME_SCRIPT_ID = "bsk-tier-b-record-frame";

const MAX_REMEMBERED_OVERLAY_DOCUMENTS = 256;

const COOPERATION_RUNTIME_SCRIPT: chrome.scripting.RegisteredContentScript = {
  id: COOPERATION_SCRIPT_ID,
  js: [COOPERATION_CONTENT_SCRIPT_FILE],
  matches: ["<all_urls>"],
  runAt: "document_start",
  allFrames: true,
  matchOriginAsFallback: true,
  persistAcrossSessions: false,
};

const RECORD_FRAME_RUNTIME_SCRIPT: chrome.scripting.RegisteredContentScript = {
  id: RECORD_FRAME_SCRIPT_ID,
  js: [RECORD_FRAME_CONTENT_SCRIPT_FILE],
  matches: ["<all_urls>"],
  runAt: "document_start",
  allFrames: true,
  matchOriginAsFallback: true,
  persistAcrossSessions: false,
};

const inflightOverlayInjections = new Map<string, Promise<void>>();
const injectedOverlayDocuments = new Set<string>();

function rememberOverlayDocument(docKey: string): void {
  injectedOverlayDocuments.delete(docKey);
  injectedOverlayDocuments.add(docKey);
  while (injectedOverlayDocuments.size > MAX_REMEMBERED_OVERLAY_DOCUMENTS) {
    const oldest = injectedOverlayDocuments.values().next().value;
    if (oldest === undefined) break;
    injectedOverlayDocuments.delete(oldest);
  }
}

export function forgetOverlayInjectedTab(tabId: number): void {
  const prefix = `doc:${tabId}:`;
  for (const key of injectedOverlayDocuments) {
    if (key.startsWith(prefix)) injectedOverlayDocuments.delete(key);
  }
}

export function resetOverlayInjectionCacheForTests(): void {
  inflightOverlayInjections.clear();
  injectedOverlayDocuments.clear();
}

/**
 * Idempotently injects Tier A (`content-scripts/content.js`) into `tabId`'s
 * outermost document (or a specific `documentId`, such as a prerendered page).
 * Never throws on restricted URLs (`about:blank`, `chrome://`, Web Store, etc.).
 */
export async function ensureOverlayInjected(
  tabId: number,
  options?: { documentId?: string },
): Promise<void> {
  if (typeof chrome === "undefined" || typeof chrome.scripting?.executeScript !== "function") {
    return;
  }
  let documentId = options?.documentId;
  if (!documentId && typeof chrome.webNavigation?.getFrame === "function") {
    try {
      const frame = await chrome.webNavigation.getFrame({ tabId, frameId: 0 });
      if (frame?.documentId && !frame.errorOccurred) {
        documentId = frame.documentId;
      }
    } catch {
      // Fall back to tab-targeted injection if frame metadata is unavailable.
    }
  }
  const key = documentId ? `doc:${tabId}:${documentId}` : `tab:${tabId}`;
  if (documentId && injectedOverlayDocuments.has(key)) {
    return;
  }
  const existing = inflightOverlayInjections.get(key);
  if (existing) {
    await existing;
    return;
  }
  const run = (async () => {
    try {
      const outcome = await executeScriptBounded({
        target: documentId ? { tabId, documentIds: [documentId] } : { tabId },
        files: [OVERLAY_CONTENT_SCRIPT_FILE],
      });
      if (outcome && documentId) rememberOverlayDocument(key);
    } catch {
      // Restricted pages (`about:blank`, `chrome://`, Web Store) or closing tabs
      // reject `executeScript`; callers handle unreachable receivers naturally.
    } finally {
      inflightOverlayInjections.delete(key);
    }
  })();
  inflightOverlayInjections.set(key, run);
  await run;
}

const ARM_INJECT_TIMEOUT_MS = 3_000;
const ARM_INJECT_TIMED_OUT = Symbol("arm_inject_timed_out");

export async function executeScriptBounded(
  injection: chrome.scripting.ScriptInjection<unknown[], unknown>,
  timeoutMs = ARM_INJECT_TIMEOUT_MS,
): Promise<boolean> {
  if (typeof chrome === "undefined" || typeof chrome.scripting?.executeScript !== "function") {
    return false;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const pending = chrome.scripting.executeScript(injection);
    void pending?.catch?.(() => {});
    return await Promise.race([
      pending.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function sendTabMessageBounded(
  tabId: number,
  message: unknown,
  timeoutMs = ARM_INJECT_TIMEOUT_MS,
): Promise<void> {
  if (typeof chrome === "undefined" || typeof chrome.tabs?.sendMessage !== "function") {
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const pending = chrome.tabs.sendMessage(tabId, message);
    void pending?.catch?.(() => {});
    await Promise.race([
      pending,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function sendArmMessageBounded(
  tabId: number,
  target: { documentId: string } | { frameId: number },
): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    chrome.tabs.sendMessage(tabId, { kind: COOPERATION_ARM_FRAME }, target),
    new Promise<typeof ARM_INJECT_TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(ARM_INJECT_TIMED_OUT), ARM_INJECT_TIMEOUT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
}

function isMissingReceiverError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("Receiving end does not exist");
}

export async function injectCooperationAllFrames(tabId: number): Promise<void> {
  if (typeof chrome === "undefined" || typeof chrome.scripting?.executeScript !== "function") {
    return;
  }
  if (
    typeof chrome.webNavigation?.getAllFrames === "function" &&
    typeof chrome.tabs?.sendMessage === "function"
  ) {
    let frames: chrome.webNavigation.GetAllFrameResultDetails[] | null = null;
    try {
      frames = await chrome.webNavigation.getAllFrames({ tabId });
    } catch {
      frames = null;
    }
    if (frames && frames.length > 0) {
      await Promise.all(
        frames.map(async (frame) => {
          if (frame.errorOccurred) return;
          if (frame.documentLifecycle && frame.documentLifecycle !== "active") return;
          const msgTarget = frame.documentId
            ? { documentId: frame.documentId }
            : { frameId: frame.frameId };
          try {
            const ack = await sendArmMessageBounded(tabId, msgTarget);
            if (
              ack === ARM_INJECT_TIMED_OUT ||
              (ack && typeof ack === "object" && (ack as { ok?: unknown }).ok === true)
            ) {
              return;
            }
          } catch (error) {
            if (!isMissingReceiverError(error)) return;
          }
          try {
            const injected = await executeScriptBounded({
              target: frame.documentId
                ? { tabId, documentIds: [frame.documentId] }
                : { tabId, frameIds: [frame.frameId] },
              files: [COOPERATION_CONTENT_SCRIPT_FILE],
              injectImmediately: true,
            });
            if (injected) await sendArmMessageBounded(tabId, msgTarget);
          } catch {
            // Restricted pages or closing frames cannot receive scripts.
          }
        }),
      );
      return;
    }
  }
  try {
    await executeScriptBounded({
      target: { tabId, allFrames: true },
      files: [COOPERATION_CONTENT_SCRIPT_FILE],
      injectImmediately: true,
    });
  } catch {
    // Restricted pages or closing tabs cannot receive scripts.
  }
}

export async function injectRecordFrameAllFrames(tabId: number): Promise<void> {
  if (typeof chrome === "undefined" || typeof chrome.scripting?.executeScript !== "function") {
    return;
  }
  try {
    // Co-inject `cooperation.js` alongside `record-frame.js` across all frames so
    // no synchronous `about:blank` child/grandchild frame or rearmed navigation
    // ever hosts `record-frame.js`'s `onMessage` listener (`undefined` reply)
    // without `cooperation.js` already mounted. `claimIdempotentContentScript`
    // makes repeated execution on already-mounted frames a zero-cost no-op.
    await executeScriptBounded({
      target: { tabId, allFrames: true },
      files: [COOPERATION_CONTENT_SCRIPT_FILE, RECORD_FRAME_CONTENT_SCRIPT_FILE],
      injectImmediately: true,
    });
  } catch {
    // Restricted pages or closing tabs cannot receive scripts.
  }
}

export interface RuntimeContentScriptCounts {
  liveSessions: () => number;
  activeRecordings: () => number;
}

export interface ScriptingRegistrationApi {
  getRegisteredContentScripts(
    filter?: chrome.scripting.ContentScriptFilter,
  ): Promise<chrome.scripting.RegisteredContentScript[]>;
  registerContentScripts(scripts: chrome.scripting.RegisteredContentScript[]): Promise<void>;
  unregisterContentScripts(filter?: chrome.scripting.ContentScriptFilter): Promise<void>;
}

function defaultScriptingRegistrationApi(): ScriptingRegistrationApi | null {
  if (
    typeof chrome === "undefined" ||
    typeof chrome.scripting?.registerContentScripts !== "function" ||
    typeof chrome.scripting?.unregisterContentScripts !== "function" ||
    typeof chrome.scripting?.getRegisteredContentScripts !== "function"
  ) {
    return null;
  }
  return {
    getRegisteredContentScripts: (filter) =>
      filter
        ? chrome.scripting.getRegisteredContentScripts(filter)
        : chrome.scripting.getRegisteredContentScripts(),
    registerContentScripts: (scripts) => chrome.scripting.registerContentScripts(scripts),
    unregisterContentScripts: (filter) =>
      filter
        ? chrome.scripting.unregisterContentScripts(filter)
        : chrome.scripting.unregisterContentScripts(),
  };
}

/**
 * Serialized coordinator for Tier B dynamic `document_start` content scripts.
 *
 * - When `liveSessions + activeRecordings === 0`, unregisters all dynamic
 *   content scripts so regular browsing incurs zero content-script execution.
 * - Registers Tier B scripts with `persistAcrossSessions: false` so an unclean
 *   browser exit never leaves orphaned `<all_urls>` registrations behind.
 */
export class RuntimeContentScriptCoordinator {
  readonly #counts: RuntimeContentScriptCounts;
  readonly #api: () => ScriptingRegistrationApi | null;
  #queue: Promise<void> = Promise.resolve();

  constructor(
    counts: RuntimeContentScriptCounts,
    api: () => ScriptingRegistrationApi | null = defaultScriptingRegistrationApi,
  ) {
    this.#counts = counts;
    this.#api = api;
  }

  sync(): Promise<void> {
    const run = async () => {
      const scripting = this.#api();
      if (!scripting) return;
      const wantCooperation = this.#counts.liveSessions() > 0;
      const wantRecordFrame = this.#counts.activeRecordings() > 0;
      if (!wantCooperation && !wantRecordFrame) {
        await scripting.unregisterContentScripts();
        return;
      }
      const existing = await scripting.getRegisteredContentScripts();
      const existingIds = new Set(existing.map((script) => script.id));
      const toUnregister: string[] = [];
      for (const script of existing) {
        const keep =
          (script.id === COOPERATION_SCRIPT_ID && wantCooperation) ||
          (script.id === RECORD_FRAME_SCRIPT_ID && wantRecordFrame);
        if (!keep) toUnregister.push(script.id);
      }
      if (toUnregister.length > 0) {
        await scripting.unregisterContentScripts({ ids: toUnregister });
      }
      const toRegister: chrome.scripting.RegisteredContentScript[] = [];
      if (wantCooperation && !existingIds.has(COOPERATION_SCRIPT_ID)) {
        toRegister.push(COOPERATION_RUNTIME_SCRIPT);
      }
      if (wantRecordFrame && !existingIds.has(RECORD_FRAME_SCRIPT_ID)) {
        toRegister.push(RECORD_FRAME_RUNTIME_SCRIPT);
      }
      if (toRegister.length > 0) {
        await scripting.registerContentScripts(toRegister);
      }
    };
    const next = this.#queue.then(run, run).catch((error) => {
      console.warn("[bsk runtime-scripts] failed to reconcile dynamic content scripts", error);
    });
    this.#queue = next;
    return next;
  }
}
