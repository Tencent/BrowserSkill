import { ChromiumCdp } from "@/browser-driver/chromium-cdp";
import type { CdpFrame, CdpTarget } from "@/browser-driver/frame-graph";
import type { SessionManager } from "@/session-manager/manager";
import type { RpcError } from "@/transport/types";
import { documentIdentity, type RuntimeReply, SERIALIZATION, unwrap } from "./dom-read-runtime";
import { collectDomRead } from "./read/collector";
import type { RawRead, ReadParams, ReadResult } from "./read/types";
import { ReadFailure, readError, validateRead } from "./read/validation";
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
import { throwIfAborted } from "./vom/capture-abort";
import { resolveVerifiedNode, verifyDocumentIdentity } from "./vom/document-identity";

export async function handleRead(
  manager: SessionManager,
  params: ReadParams,
  deps: { cdp: CdpRunner; tabsApi: ChromeTabsApi } = {
    cdp: new ChromiumCdp(),
    tabsApi: chromeTabsApi,
  },
  signal?: AbortSignal,
): Promise<ReadResult | RpcError> {
  const stale = (): never => {
    throw new ReadFailure(
      "read_target_stale",
      "The read document or target changed; inspect it again",
    );
  };
  try {
    throwIfAborted(signal);
    const options = validateRead(params);
    const ctx = lookupSession(manager, params, "read");
    if (isRpcError(ctx)) return ctx;
    const tab = await resolveCdpAccessibleTargetTab(
      manager,
      ctx,
      params.tab_id,
      deps.tabsApi,
      "read",
    );
    if (isRpcError(tab)) return tab;
    deps.cdp.trackSessionTab?.(ctx.sessionId, tab.tabId);
    await deps.cdp.ensureAttachedToUrl?.(tab.tabId, tab.url);
    const documentRevision = ctx.refStore.documentRevision(tab.tabId);
    const attachmentId = deps.cdp.getAttachmentId?.(tab.tabId);
    if (!attachmentId)
      return {
        code: "unsupported",
        message: "read requires document identity support",
        data: { effect_state: "none" },
      };
    const check = () => {
      throwIfAborted(signal);
      if (
        manager.get(ctx.sessionId) !== ctx ||
        deps.cdp.getAttachmentId?.(tab.tabId) !== attachmentId ||
        ctx.refStore.documentRevision(tab.tabId) !== documentRevision
      )
        stale();
    };
    const cdp: CdpRunner = {
      send: (tabId, method, args) => send({ tabId }, method, args),
      sendToTarget: (target, method, args) => send(target, method, args),
      getAttachmentId: (id) => deps.cdp.getAttachmentId?.(id),
    };
    const send = async <T>(target: CdpTarget, method: string, args?: object): Promise<T> => {
      if (method !== "Runtime.releaseObjectGroup") check();
      else if (deps.cdp.getAttachmentId?.(tab.tabId) !== attachmentId) return undefined as T;
      return deps.cdp.sendGuarded
        ? deps.cdp.sendGuarded<T>(target, method, args, {
            attachmentId,
            ...(method === "Runtime.releaseObjectGroup" ? {} : { signal }),
          })
        : sendToCdpTarget<T>(deps.cdp, target, method, args);
    };
    // A main-document query must not collect unrelated OOPIF documents or wait
    // for their renderers. Only a ref in a child needs the complete frame graph.
    const tree = await send<{ frameTree?: { frame: { id: string; url?: string } } }>(
      { tabId: tab.tabId },
      "Page.getFrameTree",
      {},
    );
    if (!tree.frameTree?.frame.id) return stale();
    const root: CdpFrame = {
      frameId: tree.frameTree.frame.id,
      url: tree.frameTree.frame.url,
      target: { tabId: tab.tabId },
    };
    check();
    const rootDoc = await documentIdentity(cdp, root, attachmentId, stale);
    let frame = root;
    let backendNodeId: number | undefined;
    if (params.ref) {
      const ref = resolveSnapshotRef(ctx, params.ref, tab.tabId);
      if (isRpcError(ref)) return ref;
      if (ref.cdpSessionId || (ref.frameId && ref.frameId !== root.frameId)) {
        const graph = await deps.cdp.getFrameGraph?.(tab.tabId);
        check();
        const selected = graph?.frames.find(
          (f) => f.frameId === ref.frameId && f.target.sessionId === ref.cdpSessionId,
        );
        if (!selected) return stale();
        frame = selected;
      }
      backendNodeId = ref.backendNodeId;
    }
    const current =
      frame === root ? rootDoc : await documentIdentity(cdp, frame, attachmentId, stale);
    const group = `bsk-read-${crypto.randomUUID()}`;
    let node: Awaited<ReturnType<typeof resolveVerifiedNode>> | undefined;
    try {
      if (backendNodeId !== undefined) {
        node = await resolveVerifiedNode(cdp, current.identity, backendNodeId, signal);
        if (node.status !== "current") stale();
      }
      const reply = await send<RuntimeReply>(frame.target, "Runtime.callFunctionOn", {
        ...(node?.status === "current"
          ? { objectId: node.objectId }
          : { executionContextId: current.contextId }),
        functionDeclaration: collectDomRead.toString(),
        arguments: [{ value: options }],
        objectGroup: group,
        serializationOptions: SERIALIZATION,
        // Never await page promises or invoke page-world serialization hooks.
        awaitPromise: false,
      });
      check();
      const raw = unwrap(reply) as RawRead;
      if (!raw || !Array.isArray(raw.items)) throw new Error("Invalid DOM read response");
      if (raw.error) throw new ReadFailure(raw.error.reason, raw.error.message);
      for (const identity of frame === root
        ? [rootDoc.identity]
        : [rootDoc.identity, current.identity])
        if ((await verifyDocumentIdentity(cdp, identity, signal)) !== "current") stale();
      const settledTab = await deps.tabsApi.get(tab.tabId);
      if (settledTab.url !== tab.url || (frame === root && raw.frame_url !== tab.url)) stale();
      check();
      // Stage refs until the entire result, its identity and byte bound pass.
      const identities = raw.items.map(({ node: item }) => {
        if (!Number.isSafeInteger(item?.backendNodeId))
          throw new Error("DOM read returned no node identity");
        return {
          tabId: tab.tabId,
          backendNodeId: item.backendNodeId,
          frameId: frame.frameId,
          cdpSessionId: frame.target.sessionId,
        };
      });
      const result: ReadResult = {
        tab_id: tab.tabId,
        page_url: frame === root ? raw.frame_url : (root.url ?? tab.url ?? ""),
        frame_id: frame.frameId,
        frame_url: raw.frame_url,
        title: raw.title,
        captured_at: raw.captured_at,
        scope: "current_dom",
        truncated: raw.truncated,
        items: raw.items.map((item, i) => ({
          ref: `@${ctx.refStore.allocateRef(identities[i])}`,
          values: item.values,
          redacted: item.redacted,
        })),
      };
      if (new TextEncoder().encode(JSON.stringify(result)).length > options.max_bytes)
        throw new ReadFailure(
          "read_limit",
          "DOM read response exceeds max_bytes; narrow fields or max_nodes",
        );
      check();
      identities.forEach((identity, i) =>
        ctx.refStore.set(result.items[i].ref, identity.backendNodeId, identity),
      );
      return result;
    } finally {
      await send(frame.target, "Runtime.releaseObjectGroup", { objectGroup: group }).catch(
        () => {},
      );
      if (node?.status === "current")
        await send(frame.target, "Runtime.releaseObjectGroup", {
          objectGroup: node.objectGroup,
        }).catch(() => {});
    }
  } catch (error) {
    if (signal?.aborted || (error instanceof Error && error.name === "AbortError"))
      return { code: "cancelled", message: "DOM read cancelled", data: { effect_state: "none" } };
    if (error instanceof ReadFailure) return readError(error);
    return {
      code: "cdp_failed",
      message: error instanceof Error ? error.message : String(error),
      data: { phase: "read", effect_state: "none" },
    };
  }
}
