import { ChromiumCdp } from "@/browser-driver/chromium-cdp";
import type { CdpFrame, CdpTarget } from "@/browser-driver/frame-graph";
import type { SessionContext, SessionManager } from "@/session-manager/manager";
import type { RpcError } from "@/transport/types";
import { collectExtractDom } from "./extract/collector";
import { fitExtractBudget, normalizeExtract } from "./extract/normalize";
import type { CollectorOptions, ExtractParams, ExtractResult, RawCapture } from "./extract/types";
import { ExtractionFailure, extractionFailure, validateExtract } from "./extract/validation";
import {
  type CdpRunner,
  type ChromeTabsApi,
  chromeTabsApi,
  isRpcError,
  lookupSession,
  resolveCdpAccessibleTargetTab,
  sendToCdpTarget,
} from "./shared";
import { resolveSnapshotRef } from "./snapshot-ref";
import { isCaptureTerminalError, throwIfAborted } from "./vom/capture-abort";
import { resolveVerifiedNode, verifyDocumentIdentity } from "./vom/document-identity";
import type { DocumentIdentity } from "./vom/facts";

interface RetainedTarget {
  identity: DocumentIdentity;
  backendNodeId: number;
  expires: number;
}
// Targets contain identities only, never remote JS handles or page contents.
// Weak ownership releases all entries when the session context is discarded.
const targets = new WeakMap<SessionContext, Map<string, RetainedTarget>>();
const TARGET_TTL_MS = 300_000;
const SERIALIZATION = {
  serialization: "deep",
  additionalParameters: { maxNodeDepth: 0, includeShadowTree: "none" },
};
interface DeepValue {
  type: string;
  value?: unknown;
}
interface RuntimeReply {
  result?: { value?: unknown; deepSerializedValue?: DeepValue };
  exceptionDetails?: { text?: string; exception?: { description?: string } };
}
function decode(value: DeepValue, depth = 0): unknown {
  if (depth > 32) throw new Error("Extraction serialization exceeded nesting limit");
  if (value.type === "node") return value.value;
  if (value.type === "null" || value.type === "undefined") return null;
  if (value.type === "array")
    return (value.value as DeepValue[]).map((item) => decode(item, depth + 1));
  if (value.type === "object")
    return Object.fromEntries(
      (value.value as [string, DeepValue][]).map(([key, item]) => [key, decode(item, depth + 1)]),
    );
  if (["string", "boolean", "number"].includes(value.type)) return value.value;
  throw new Error(`Unsupported extraction serialization: ${value.type}`);
}
function unwrap(reply: RuntimeReply): unknown {
  if (reply.exceptionDetails)
    throw new Error(
      reply.exceptionDetails.exception?.description ??
        reply.exceptionDetails.text ??
        "DOM extraction failed",
    );
  return reply.result?.deepSerializedValue
    ? decode(reply.result.deepSerializedValue)
    : reply.result?.value;
}
function stale(): never {
  throw new ExtractionFailure(
    "extract_target_stale",
    "The document or target changed; discover it again",
  );
}
function registry(ctx: SessionContext): Map<string, RetainedTarget> {
  let retained = targets.get(ctx);
  if (!retained) {
    retained = new Map();
    targets.set(ctx, retained);
  }
  for (const [id, target] of retained) if (target.expires <= Date.now()) retained.delete(id);
  return retained;
}
async function documentIdentity(
  cdp: CdpRunner,
  frame: CdpFrame,
  attachmentId: string,
): Promise<{ identity: DocumentIdentity; contextId: number }> {
  const world = await sendToCdpTarget<{ executionContextId: number }>(
    cdp,
    frame.target,
    "Page.createIsolatedWorld",
    {
      frameId: frame.frameId,
      worldName: "bsk-extract",
    },
  );
  const group = `bsk-extract-root-${crypto.randomUUID()}`;
  try {
    const root = unwrap(
      await sendToCdpTarget<RuntimeReply>(cdp, frame.target, "Runtime.evaluate", {
        expression: "document.documentElement",
        contextId: world.executionContextId,
        objectGroup: group,
        serializationOptions: SERIALIZATION,
      }),
    ) as { backendNodeId?: number } | null;
    if (!root?.backendNodeId) stale();
    return {
      identity: {
        attachmentId,
        target: frame.target,
        frameId: frame.frameId,
        documentElementBackendNodeId: root.backendNodeId,
      },
      contextId: world.executionContextId,
    };
  } finally {
    await sendToCdpTarget(cdp, frame.target, "Runtime.releaseObjectGroup", {
      objectGroup: group,
    }).catch(() => {});
  }
}
async function capture(
  cdp: CdpRunner,
  identity: DocumentIdentity,
  contextId: number,
  options: CollectorOptions,
  backendNodeId: number | undefined,
  signal?: AbortSignal,
): Promise<RawCapture> {
  const group = `bsk-extract-${crypto.randomUUID()}`;
  let node: Awaited<ReturnType<typeof resolveVerifiedNode>> | undefined;
  try {
    if (backendNodeId !== undefined) {
      node = await resolveVerifiedNode(cdp, identity, backendNodeId, signal);
      if (node.status !== "current") stale();
    }
    const reply = await sendToCdpTarget<RuntimeReply>(
      cdp,
      identity.target,
      "Runtime.callFunctionOn",
      {
        ...(node?.status === "current"
          ? { objectId: node.objectId }
          : { executionContextId: contextId }),
        functionDeclaration: collectExtractDom.toString(),
        arguments: [{ value: options }],
        objectGroup: group,
        ...(options.action === "discover"
          ? { serializationOptions: SERIALIZATION }
          : { returnByValue: true }),
      },
    );
    throwIfAborted(signal);
    const result = unwrap(reply) as RawCapture | undefined;
    if (!result || !Array.isArray(result.rows) || !Array.isArray(result.targets))
      throw new Error("Invalid extraction response");
    if (result.error) throw new ExtractionFailure(result.error.reason, result.error.message);
    if ((await verifyDocumentIdentity(cdp, identity, signal)) !== "current") stale();
    return result;
  } finally {
    await sendToCdpTarget(cdp, identity.target, "Runtime.releaseObjectGroup", {
      objectGroup: group,
    }).catch(() => {});
    if (node?.status === "current")
      await sendToCdpTarget(cdp, identity.target, "Runtime.releaseObjectGroup", {
        objectGroup: node.objectGroup,
      }).catch(() => {});
  }
}

export interface ExtractDeps {
  cdp: CdpRunner;
  tabsApi: ChromeTabsApi;
}
export async function handleExtract(
  manager: SessionManager,
  params: ExtractParams,
  deps: ExtractDeps = { cdp: new ChromiumCdp(), tabsApi: chromeTabsApi },
  signal?: AbortSignal,
): Promise<ExtractResult | RpcError> {
  try {
    throwIfAborted(signal);
    const options = validateExtract(params);
    const ctx = lookupSession(manager, params, "extract");
    if (isRpcError(ctx)) return ctx;
    const tab = await resolveCdpAccessibleTargetTab(
      manager,
      ctx,
      params.tab_id,
      deps.tabsApi,
      "extract",
    );
    if (isRpcError(tab)) return tab;
    deps.cdp.trackSessionTab?.(ctx.sessionId, tab.tabId);
    await deps.cdp.ensureAttachedToUrl?.(tab.tabId, tab.url);
    throwIfAborted(signal);
    const attachmentId = deps.cdp.getAttachmentId?.(tab.tabId);
    if (!attachmentId)
      return { code: "unsupported", message: "extract requires document identity support" };
    const check = () => {
      throwIfAborted(signal);
      if (
        manager.get(ctx.sessionId) !== ctx ||
        deps.cdp.getAttachmentId?.(tab.tabId) !== attachmentId
      )
        stale();
    };
    // Guard each native dispatch, including those in shared identity helpers.
    const send = async <T>(target: CdpTarget, method: string, args?: object): Promise<T> => {
      if (method === "Runtime.releaseObjectGroup") {
        if (deps.cdp.getAttachmentId?.(tab.tabId) !== attachmentId) return undefined as T;
        return deps.cdp.sendGuarded
          ? deps.cdp.sendGuarded<T>(target, method, args, { attachmentId })
          : sendToCdpTarget<T>(deps.cdp, target, method, args);
      }
      check();
      return deps.cdp.sendGuarded
        ? deps.cdp.sendGuarded<T>(target, method, args, { signal, attachmentId })
        : sendToCdpTarget<T>(deps.cdp, target, method, args);
    };
    const cdp: CdpRunner = {
      send: <T>(tabId: number, method: string, args?: object) => send<T>({ tabId }, method, args),
      sendToTarget: send,
      getAttachmentId: (tabId) => deps.cdp.getAttachmentId?.(tabId),
    };
    const graph = await deps.cdp.getFrameGraph?.(tab.tabId);
    check();
    const root = graph?.frames.find((frame) => frame.frameId === graph.rootFrameId);
    if (!root)
      return {
        code: "unsupported",
        message: "Could not establish the target document's frame identity",
      };
    const rootDoc = await documentIdentity(cdp, root, attachmentId);
    const retained = registry(ctx);
    let selectedFrame = root;
    let backendNodeId: number | undefined;
    let expectedIdentity: DocumentIdentity | undefined;
    if (params.target_id) {
      const saved = retained.get(params.target_id);
      if (!saved || saved.identity.target.tabId !== tab.tabId) stale();
      expectedIdentity = saved.identity;
      backendNodeId = saved.backendNodeId;
      const frame = graph!.frames.find((frame) => frame.frameId === saved.identity.frameId);
      if (!frame || frame.target.sessionId !== saved.identity.target.sessionId) stale();
      selectedFrame = frame;
    } else if (params.ref) {
      const ref = resolveSnapshotRef(ctx, params.ref, tab.tabId);
      if (isRpcError(ref)) return ref;
      const frame = graph!.frames.find(
        (frame) => frame.frameId === (ref.frameId ?? graph!.rootFrameId),
      );
      if (!frame || frame.target.sessionId !== ref.cdpSessionId) stale();
      selectedFrame = frame;
      backendNodeId = ref.backendNodeId;
    }
    const frames =
      options.action === "discover" && !options.selector
        ? [root, ...graph!.frames.filter((frame) => frame.frameId !== root.frameId)].slice(0, 16)
        : [selectedFrame];
    let output: ExtractResult | undefined;
    const pendingTargets: [string, RetainedTarget][] = [];
    const started = performance.now();
    for (const frame of frames) {
      check();
      try {
        const remaining = options.timeout_ms - (performance.now() - started);
        if (remaining <= 0)
          throw new ExtractionFailure("extract_limit", "Extraction deadline exceeded");
        const current =
          frame.frameId === root.frameId
            ? rootDoc
            : await documentIdentity(cdp, frame, attachmentId);
        if (
          expectedIdentity &&
          (await verifyDocumentIdentity(cdp, expectedIdentity, signal)) !== "current"
        )
          stale();
        const raw = await capture(
          cdp,
          current.identity,
          current.contextId,
          { ...options, timeout_ms: remaining },
          backendNodeId,
          signal,
        );
        check();
        const source = {
          page_url: root.url ?? tab.url ?? "",
          frame_url: raw.frame_url,
          frame_id: frame.frameId,
          title: raw.title,
          captured_at: raw.captured_at,
          ...(params.selector ? { selector: params.selector } : {}),
          ...(params.target_id ? { target_id: params.target_id } : {}),
        };
        const normalized = normalizeExtract(raw, options, tab.tabId, source);
        if (options.action !== "discover") {
          output = normalized;
          break;
        }
        if (!output) output = { ...normalized, targets: [] };
        output.warnings.push(...raw.warnings);
        if (raw.truncated) {
          output.coverage.truncated = true;
          output.coverage.stop_reason = raw.stop_reason;
        }
        for (const candidate of raw.targets) {
          if (output.targets!.length === 32) {
            output.coverage.truncated = true;
            output.coverage.stop_reason = "target_limit";
            break;
          }
          if (!Number.isSafeInteger(candidate.node?.backendNodeId))
            throw new Error("Discovery did not return a DOM node identity");
          const id = `xt_${crypto.randomUUID()}`;
          pendingTargets.push([
            id,
            {
              identity: current.identity,
              backendNodeId: candidate.node.backendNodeId,
              expires: Date.now() + TARGET_TTL_MS,
            },
          ]);
          output.targets!.push({
            target_id: id,
            kind: candidate.kind,
            name: candidate.name,
            columns: candidate.columns,
            frame_id: frame.frameId,
            frame_url: raw.frame_url,
          });
        }
      } catch (error) {
        if (
          options.action !== "discover" ||
          frame.frameId === root.frameId ||
          isCaptureTerminalError(error) ||
          signal?.aborted
        )
          throw error;
        if (output) {
          output.warnings.push(`frame_unavailable:${frame.frameId}`);
          output.coverage.dataset_complete = "incomplete";
        }
      }
    }
    if (!output) throw new Error("No extraction result");
    if (options.action === "discover") {
      if (graph!.frames.length > frames.length && !options.selector) {
        output.coverage.truncated = true;
        output.coverage.stop_reason = "frame_limit";
      }
      for (const frame of graph!.unavailableFrames ?? [])
        output.warnings.push(`frame_unavailable:${frame.frameId}`);
      if (output.coverage.truncated || graph!.unavailableFrames?.length)
        output.coverage.dataset_complete = "incomplete";
      while (
        output.targets!.length > 0 &&
        new TextEncoder().encode(JSON.stringify(output)).length > options.max_bytes
      ) {
        output.targets!.pop();
        output.coverage.truncated = true;
        output.coverage.dataset_complete = "incomplete";
        output.coverage.stop_reason = "byte_limit";
      }
    }
    if ((await verifyDocumentIdentity(cdp, rootDoc.identity, signal)) !== "current") stale();
    check();
    output.warnings = [...new Set(output.warnings)];
    output = fitExtractBudget(output, options.max_bytes);
    const publishedIds = new Set(output.targets?.map((item) => item.target_id));
    for (const [id, target] of pendingTargets) {
      if (!publishedIds.has(id)) continue;
      while (retained.size >= 128) retained.delete(retained.keys().next().value!);
      retained.set(id, target);
    }
    return output;
  } catch (error) {
    if (signal?.aborted || (error instanceof Error && error.name === "AbortError"))
      return { code: "cancelled", message: "extract aborted" };
    if (error instanceof ExtractionFailure) return extractionFailure(error);
    return { code: "cdp_failed", message: error instanceof Error ? error.message : String(error) };
  }
}
