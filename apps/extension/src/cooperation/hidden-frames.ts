import { canHostShadowRoot } from "@/content/dom-primitives";
import { COOPERATION_OWNERS } from "./types";

type Frame = chrome.webNavigation.GetAllFrameResultDetails;

/** What a parent document can establish about one of its frame elements. */
export interface FrameOwner {
  /** Not displayed, without area, or invisible, and not on the focus path. */
  hidden: boolean;
  /** The child document's URL when the parent can read it (same origin), otherwise null. */
  url: string | null;
  /** Resolved owner `src`/`data` attribute when requested for cross-origin disambiguation. */
  declaredSrc?: string | null;
}

const OWNER_ELEMENTS = new Set(["iframe", "frame", "object", "embed", "fencedframe"]);
const OWNER_REPLY_MS = 3_000;
const MAX_OWNERS = 4096;

function originOf(raw: string): string | null {
  try {
    const parsed = new URL(raw);
    if (["http:", "https:", "chrome-extension:"].includes(parsed.protocol)) {
      return `${parsed.protocol}//${parsed.host}`;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Runs in the parent document's collector. It reports layout facts and readable
 * child URLs only; it never changes the page or calls page-world functions.
 */
export function describeFrameOwners(
  root: Document,
  shadowRoot: (element: Element) => ShadowRoot | null,
  options?: { includeDeclaredSrc?: boolean },
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
      if (element.shadowRoot || canHostShadowRoot(element.localName)) {
        const nested = shadowRoot(element);
        if (nested) visit(nested);
      }
    }
  };
  visit(root);
  const view = root.defaultView;
  return owners.map((element) => {
    const box = element.getBoundingClientRect();
    const visible =
      typeof element.checkVisibility !== "function" ||
      element.checkVisibility({ visibilityProperty: true });
    const computed =
      view && typeof view.getComputedStyle === "function"
        ? view.getComputedStyle(element)
        : typeof getComputedStyle === "function"
          ? getComputedStyle(element)
          : undefined;
    const untargetable =
      computed?.pointerEvents === "none" ||
      (computed?.position === "fixed" &&
        (box.right <= 0 ||
          box.bottom <= 0 ||
          (view ? box.left >= view.innerWidth || box.top >= view.innerHeight : false)));
    let url: string | null = null;
    try {
      const href = (element as HTMLIFrameElement).contentWindow?.location.href;
      if (typeof href === "string") url = href;
    } catch {
      // A cross-origin document stays unidentified via contentWindow; declaredSrc disambiguates below.
    }
    let declaredSrc: string | null | undefined;
    if (options?.includeDeclaredSrc && url === null) {
      const raw =
        element.localName === "object" ? element.getAttribute("data") : element.getAttribute("src");
      if (typeof raw === "string" && raw.trim().length > 0) {
        try {
          declaredSrc = new URL(raw, root.baseURI || undefined).href;
        } catch {
          declaredSrc = null;
        }
      } else {
        declaredSrc = null;
      }
    }
    return {
      hidden:
        !focusPath.has(element) &&
        (element.getClientRects().length === 0 ||
          box.width <= 0 ||
          box.height <= 0 ||
          !visible ||
          untargetable),
      url,
      ...(declaredSrc !== undefined ? { declaredSrc } : {}),
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
        (owner.url === null || typeof owner.url === "string") &&
        (owner.declaredSrc === undefined ||
          owner.declaredSrc === null ||
          typeof owner.declaredSrc === "string"),
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
 * Every child document has an owner element in `owners`, so when `owners` has at
 * least as many elements as `siblings` and every displayed owner is positively
 * accounted for by a different sibling document, `frame`'s owner must be hidden.
 */
export function ownedByHiddenElement(frame: Frame, owners: FrameOwner[], siblings: Frame[]) {
  if (owners.length < siblings.length || !siblings.some((s) => s.frameId === frame.frameId))
    return false;
  if (!owners.some((owner) => owner.hidden && (owner.url === frame.url || owner.url === null)))
    return false;
  const remaining = siblings.filter((s) => s.frameId !== frame.frameId).map((s) => s.url);
  const displayed = owners.filter((owner) => !owner.hidden);
  for (const owner of displayed) {
    if (owner.url === null) continue;
    if (owner.url === frame.url) return false;
    const index = remaining.indexOf(owner.url);
    if (index < 0) return false;
    remaining.splice(index, 1);
  }
  const displayedCross = displayed.filter((owner) => owner.url === null);
  if (!displayedCross.length) return true;
  const failedOrigin = originOf(frame.url);
  const hiddenCross = owners.filter((owner) => owner.hidden && owner.url === null);
  if (
    !hiddenCross.some(
      (owner) =>
        !owner.declaredSrc ||
        owner.declaredSrc === frame.url ||
        (failedOrigin !== null && originOf(owner.declaredSrc) === failedOrigin),
    )
  )
    return false;
  const unmatchedOriginFallback: string[] = [];
  for (const owner of displayedCross) {
    if (!owner.declaredSrc || owner.declaredSrc === frame.url) return false;
    const exactIndex = remaining.indexOf(owner.declaredSrc);
    if (exactIndex >= 0) {
      remaining.splice(exactIndex, 1);
    } else {
      const declaredOrigin = originOf(owner.declaredSrc);
      if (!declaredOrigin || !failedOrigin || declaredOrigin === failedOrigin) return false;
      unmatchedOriginFallback.push(declaredOrigin);
    }
  }
  if (unmatchedOriginFallback.length) {
    // Do not let a displayed frame that redirected cross-origin steal a healthy
    // sibling whose current URL is the exact `declaredSrc` of a hidden owner.
    for (const owner of hiddenCross) {
      if (!owner.declaredSrc || owner.declaredSrc === frame.url) continue;
      if (failedOrigin !== null && originOf(owner.declaredSrc) === failedOrigin) continue;
      const reserved = remaining.indexOf(owner.declaredSrc);
      if (reserved >= 0) remaining.splice(reserved, 1);
    }
    for (const declaredOrigin of unmatchedOriginFallback) {
      const originIndex = remaining.findIndex(
        (candidate) => originOf(candidate) === declaredOrigin,
      );
      if (originIndex < 0) return false;
      remaining.splice(originIndex, 1);
    }
  }
  return true;
}

async function readOwners(tabId: number, parent: Frame): Promise<FrameOwner[] | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const reply: unknown = await Promise.race([
      chrome.tabs.sendMessage(
        tabId,
        { kind: COOPERATION_OWNERS, includeDeclaredSrc: true },
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
