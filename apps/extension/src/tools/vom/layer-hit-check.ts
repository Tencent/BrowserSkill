import { detectBlockingLayer, type VomNode, type VomScene } from "@browser-skill/vom";

/** Does the browser deliver a pointer at this viewport point to the node? */
export type LayerHitProbe = (node: VomNode, point: { x: number; y: number }) => Promise<boolean>;

// ponytail: four evenly spread samples per candidate and four candidates per
// capture bound the extra CDP round trips. Raise them if real pages keep their
// reachable content behind more unrelated layers than that.
const MAX_SAMPLES = 4;
const MAX_CANDIDATES = 4;

function unverifiedBlocker(scene: VomScene): { node: VomNode; members: Set<number> } | null {
  const layer = detectBlockingLayer(scene.nodes, scene.viewport, scene.rootFrameId);
  const node = layer && scene.nodes.find((candidate) => candidate.id === layer.rootId);
  // Modality is a statement about the page, not about geometry: leave it alone.
  return layer && node && node.modal !== true ? { node, members: layer.members } : null;
}

function foldedSamples(scene: VomScene, members: Set<number>): VomNode[] {
  // A hit on a descendant counts for its ancestor, so a node that contains the
  // layer would vouch for itself through the layer.
  const owners = new Set<number>();
  for (const node of scene.nodes)
    if (members.has(node.id)) for (const id of node.domAncestorIds ?? []) owners.add(id);
  const { width, height } = scene.viewport;
  const usable = scene.nodes.filter((node) => {
    if (members.has(node.id) || owners.has(node.id) || node.visualKey !== undefined) return false;
    if (node.backendNodeId === undefined || node.referenceable === false) return false;
    if (scene.rootFrameId !== undefined && node.frameId !== scene.rootFrameId) return false;
    if (node.domAncestorIds?.some((id) => members.has(id))) return false;
    const rect = node.rect;
    if (!rect || rect.w <= 0 || rect.h <= 0) return false;
    const x = rect.x + rect.w / 2;
    const y = rect.y + rect.h / 2;
    return x >= 0 && y >= 0 && x < width && y < height;
  });
  const step = Math.max(1, Math.floor(usable.length / MAX_SAMPLES));
  return usable.filter((_, index) => index % step === 0).slice(0, MAX_SAMPLES);
}

/**
 * Mark viewport-spanning boxes that do not actually block the page.
 *
 * DOMSnapshot paint order is assigned per paint layer, so in-flow content
 * always sorts below a positioned box: a real backdrop, a `z-index:-1`
 * background and a fully clipped drawer look the same to the layer detector.
 * Hit testing is the browser's own answer. When a node the candidate would
 * fold still receives a pointer at its own centre, the candidate is no cover.
 * A failed probe counts as "not reached", which keeps the candidate.
 *
 * `within` wraps the probing only when there is something to probe.
 */
export async function markHitThroughLayers(
  scene: VomScene,
  probe: LayerHitProbe,
  within: (body: () => Promise<void>) => Promise<void> = (body) => body(),
): Promise<void> {
  if (!unverifiedBlocker(scene)) return;
  await within(async () => {
    for (let attempt = 0; attempt < MAX_CANDIDATES; attempt++) {
      const blocker = unverifiedBlocker(scene);
      if (!blocker) return;
      const reached = await Promise.all(
        foldedSamples(scene, blocker.members).map((node) => {
          const rect = node.rect!;
          return probe(node, { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 }).catch(() => false);
        }),
      );
      if (!reached.includes(true)) return;
      blocker.node.hitThrough = true;
    }
  });
}
