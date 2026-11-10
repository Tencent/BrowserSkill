import { COOPERATION_OWNERS } from "./types";

type Frame = chrome.webNavigation.GetAllFrameResultDetails;

/** What a parent document can establish about one of its frame elements. */
export interface FrameOwner {
  /** Not displayed, without area, or invisible, and not on the focus path. */
  hidden: boolean;
  /** The child document's URL when the parent can read it (same origin), otherwise null. */
  url: string | null;
}

const OWNER_ELEMENTS = new Set(["iframe", "frame", "object", "embed", "fencedframe"]);
const OWNER_REPLY_MS = 1200;
const MAX_OWNERS = 4096;

/**
 * Runs in the parent document's collector. It reports layout facts and readable
 * child URLs only; it never changes the page or calls page-world functions.
 */
export function describeFrameOwners(
  root: Document,
  shadowRoot: (element: Element) => ShadowRoot | null,
): FrameOwner[] {
  // A focused frame element can receive keys even without area.
  const focusPath = new Set<Element>();
  for (
    let active = root.activeElement;
    active && !focusPath.has(active);
    active = shadowRoot(active)?.activeElement ?? null
  )
    focusPath.add(active);
  const owners: Element[] = [];
  const visit = (scope: Document | ShadowRoot) => {
    for (const element of scope.querySelectorAll("*")) {
      if (OWNER_ELEMENTS.has(element.localName)) owners.push(element);
      const nested = shadowRoot(element);
      if (nested) visit(nested);
    }
  };
  visit(root);
  return owners.map((element) => {
    const box = element.getBoundingClientRect();
    const visible =
      typeof element.checkVisibility !== "function" ||
      element.checkVisibility({ visibilityProperty: true });
    let url: string | null = null;
    try {
      const href = (element as HTMLIFrameElement).contentWindow?.location.href;
      if (typeof href === "string") url = href;
    } catch {
      // A cross-origin document stays unidentified; the caller treats it as possibly any frame.
    }
    return {
      hidden:
        !focusPath.has(element) &&
        (element.getClientRects().length === 0 || box.width <= 0 || box.height <= 0 || !visible),
      url,
    };
  });
}

function validOwners(value: unknown): value is FrameOwner[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_OWNERS &&
    value.every(
      (owner) =>
        !!owner &&
        typeof owner === "object" &&
        typeof owner.hidden === "boolean" &&
        (owner.url === null || typeof owner.url === "string"),
    )
  );
}

/** Child documents of `parent`, excluding documents left over from a replaced parent. */
function children(inventory: Frame[], parent: Frame): Frame[] {
  return inventory.filter(
    (frame) =>
      frame.parentFrameId === parent.frameId &&
      (frame.parentDocumentId === undefined || frame.parentDocumentId === parent.documentId),
  );
}

const signature = (frames: Frame[]) =>
  frames
    .map((frame) => `${frame.frameId}\n${frame.documentId}\n${frame.url}`)
    .sort()
    .join("\n\n");

/**
 * True only when `frame`'s element in its parent must be one of the hidden ones.
 * Every child document has exactly one element, so with matching counts it is
 * enough that each displayed element is identified as a different document.
 */
export function ownedByHiddenElement(frame: Frame, owners: FrameOwner[], siblings: Frame[]) {
  if (owners.length !== siblings.length || !siblings.some((s) => s.frameId === frame.frameId))
    return false;
  const others = new Map<string, number>();
  for (const sibling of siblings)
    if (sibling.frameId !== frame.frameId)
      others.set(sibling.url, (others.get(sibling.url) ?? 0) + 1);
  for (const owner of owners) {
    if (owner.hidden) continue;
    if (owner.url === null || owner.url === frame.url) return false;
    const count = others.get(owner.url) ?? 0;
    if (!count) return false;
    others.set(owner.url, count - 1);
  }
  return true;
}

async function readOwners(tabId: number, parent: Frame): Promise<FrameOwner[] | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const reply: unknown = await Promise.race([
      chrome.tabs.sendMessage(
        tabId,
        { kind: COOPERATION_OWNERS },
        { documentId: parent.documentId },
      ),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), OWNER_REPLY_MS);
      }),
    ]);
    return validOwners(reply) ? reply : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Of `candidates` (child frames without a working collector), returns the frame
 * ids whose element is proven hidden in its parent, or that are nested in a
 * hidden frame (`known` or proven here). People cannot point at or type into
 * these documents, so their missing collector cannot conceal human input. Any
 * doubt keeps a frame required: an unreadable or unresponsive parent, an
 * unidentified displayed element, a count mismatch, or a frame inventory that
 * changed while the parents were read.
 */
export async function provenHiddenFrames(
  tabId: number,
  inventory: Frame[],
  candidates: Frame[],
  known: ReadonlySet<number> = new Set(),
): Promise<Set<number>> {
  const proven = new Set<number>();
  const byId = new Map(inventory.map((frame) => [frame.frameId, frame]));
  const failing = new Set(candidates.map((frame) => frame.frameId));
  const depth = (frame: Frame) => {
    let count = 0;
    for (
      let parent = byId.get(frame.parentFrameId);
      parent && count <= inventory.length;
      parent = byId.get(parent.parentFrameId)
    )
      count++;
    return count;
  };
  const queried = new Map<number, Promise<FrameOwner[] | undefined>>();
  for (const frame of [...candidates].sort((a, b) => depth(a) - depth(b))) {
    const parent = byId.get(frame.parentFrameId);
    if (frame.frameId === 0 || !parent) continue;
    if (known.has(parent.frameId) || proven.has(parent.frameId)) {
      proven.add(frame.frameId);
      continue;
    }
    // A failing parent that is not proven hidden has no working collector to ask.
    if (failing.has(parent.frameId)) continue;
    let owners = queried.get(parent.frameId);
    if (!owners) {
      owners = readOwners(tabId, parent);
      queried.set(parent.frameId, owners);
    }
    const facts = await owners;
    if (facts && ownedByHiddenElement(frame, facts, children(inventory, parent)))
      proven.add(frame.frameId);
  }
  if (!queried.size || !proven.size) return proven;
  // Element facts identify documents only against the inventory they were read for.
  const current = await chrome.webNavigation.getAllFrames({ tabId }).catch(() => undefined);
  for (const parentId of queried.keys()) {
    const parent = byId.get(parentId)!;
    const now = current?.find((frame) => frame.frameId === parentId);
    if (
      !current ||
      now?.documentId !== parent.documentId ||
      signature(children(current, parent)) !== signature(children(inventory, parent))
    )
      return new Set();
  }
  return proven;
}
