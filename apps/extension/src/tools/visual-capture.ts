import { normaliseRef, type RefStore, type VisualRefInput } from "@/session-manager/ref-store";
import type { ClickParams, RpcError } from "@/transport/types";
import { rpcError } from "./errors";
import type { VisualTargetState } from "./visual-target";

const TTL_MS = 120_000;
const MAX_CAPTURES = 32;
interface Capture {
  id: string;
  ref: string;
  generation: number;
  entry: VisualRefInput;
  mapping: VisualTargetState;
  width: number;
  height: number;
  expiresAt: number;
}
const stores = new WeakMap<RefStore, Map<string, Capture>>();
function captures(store: RefStore): Map<string, Capture> {
  let result = stores.get(store);
  if (!result) stores.set(store, (result = new Map()));
  for (const [ref, capture] of result)
    if (capture.expiresAt <= Date.now() || capture.generation !== store.revision)
      result.delete(ref);
  return result;
}
export function clearVisualCapture(store: RefStore, ref: string): void {
  captures(store).delete(normaliseRef(ref));
}
export function issueVisualCapture(
  store: RefStore,
  ref: string,
  entry: VisualRefInput & { generation: number },
  mapping: VisualTargetState,
  width: number,
  height: number,
): string | undefined {
  ref = normaliseRef(ref);
  if (store.resolveEntry(ref) !== entry || entry.generation !== store.revision) return undefined;
  const items = captures(store);
  items.delete(ref);
  if (items.size >= MAX_CAPTURES) items.delete(items.keys().next().value!);
  const id = crypto.randomUUID();
  items.set(ref, {
    id,
    ref,
    entry,
    generation: store.revision,
    mapping,
    width,
    height,
    expiresAt: Date.now() + TTL_MS,
  });
  return id;
}
export function isVisualPointRequest(params: ClickParams): boolean {
  return (
    params.capture_id !== undefined || params.image_x !== undefined || params.image_y !== undefined
  );
}
export function consumeVisualCapture(
  store: RefStore,
  tabId: number,
  params: ClickParams,
): { capture: Capture; point: { x: number; y: number } } | RpcError {
  if (
    !params.ref ||
    params.selector ||
    typeof params.capture_id !== "string" ||
    !params.capture_id ||
    !Number.isFinite(params.image_x) ||
    !Number.isFinite(params.image_y) ||
    ![1, 2].includes(params.click_count ?? 1)
  )
    return rpcError(
      "invalid_params",
      "visual_capture_invalid",
      "Canvas point clicks require a visual ref, capture_id, finite image_x/image_y and click_count 1 or 2",
    );
  const ref = normaliseRef(params.ref);
  const entry = store.resolveEntry(ref);
  const items = captures(store);
  const capture = items.get(ref);
  if (
    !capture ||
    capture.id !== params.capture_id ||
    entry !== capture.entry ||
    entry.kind !== "visual-region" ||
    entry.candidate.document.target.tabId !== tabId
  )
    return rpcError(
      "not_found",
      "visual_capture_stale",
      "capture expired, consumed or does not match the current visual ref; observe and screenshot again",
    );
  const x = params.image_x!,
    y = params.image_y!;
  if (x < 0 || y < 0 || x >= capture.width || y >= capture.height)
    return rpcError(
      "invalid_params",
      "visual_coordinate_invalid",
      "image coordinates must be inside the original PNG dimensions",
    );
  items.delete(ref); // Before the first await or input: never dispatch twice with this image.
  return {
    capture,
    point: {
      x: capture.mapping.crop.x + (x / capture.width) * capture.mapping.crop.width,
      y: capture.mapping.crop.y + (y / capture.height) * capture.mapping.crop.height,
    },
  };
}
