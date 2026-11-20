// @vitest-environment node
import { readFileSync } from "node:fs";
import { renderVom, type VomNode, type VomScene } from "@browser-skill/vom";
import { describe, expect, it } from "vitest";
import { markHitThroughLayers } from "../layer-hit-check";

// Geometry, paint order and hit-test answers recorded from real Chrome for the
// "responsive navigation" and "CSS backdrop" pages of
// observation-layers.browser.test.ts. Text-only accessibility leaves are left out.
const recorded = JSON.parse(
  readFileSync(new URL("./layer-hit-scenes.json", import.meta.url), "utf8"),
) as Record<string, { scene: VomScene; reached: number[] }>;

const render = (scene: VomScene) => renderVom(scene, { activeRegionPolicy: true }).text;

async function observe(name: string) {
  const { scene, reached } = structuredClone(recorded[name]);
  const probed: number[] = [];
  await markHitThroughLayers(scene, async (node) => {
    probed.push(node.backendNodeId!);
    return reached.includes(node.backendNodeId!);
  });
  return { scene, probed, text: render(scene) };
}

const marked = (scene: VomScene) =>
  scene.nodes.filter((node) => node.hitThrough).map((node) => node.attrs?.id);

function node(id: number, fields: Partial<VomNode>): VomNode {
  return {
    id,
    parentId: null,
    backendNodeId: id,
    tag: "div",
    rect: { x: 0, y: 0, w: 1000, h: 800 },
    paintOrder: 0,
    position: "static",
    pointerEvents: "auto",
    ...fields,
  };
}

describe("markHitThroughLayers", () => {
  it("keeps a hit-testable button that geometry alone calls covered", async () => {
    const before = render(structuredClone(recorded["responsive navigation"].scene));
    expect(before).toContain("L1 mask cover=100%");
    expect(before).not.toContain('button "Main action"');

    const { scene, text } = await observe("responsive navigation");
    expect(marked(scene)).toEqual(["background", "drawer"]);
    expect(text).toContain("@layers 1");
    expect(text).toMatch(/@e\d+ button "Main action"/);
    expect(text).toMatch(/@e\d+ button "Menu"/);
    // The sidebar still covers what is under it.
    expect(text).not.toContain('button "Covered action"');
  });

  it("keeps folding the page under a real backdrop", async () => {
    const { scene, probed, text } = await observe("CSS backdrop");
    expect(probed.length).toBeGreaterThan(0);
    expect(marked(scene)).toEqual([]);
    expect(text).toContain("L1 mask cover=100%");
    expect(text).not.toContain('button "Main action"');
  });

  it("leaves modal layers and pages without a cover unprobed", async () => {
    const modal = structuredClone(recorded["CSS backdrop"].scene);
    modal.nodes.find((n) => n.attrs?.id === "backdrop")!.modal = true;
    const plain = structuredClone(recorded["CSS backdrop"].scene);
    plain.nodes = plain.nodes.filter((n) => n.attrs?.id !== "backdrop");
    for (const scene of [modal, plain]) {
      let entered = false;
      await markHitThroughLayers(
        scene,
        async () => {
          throw new Error("unexpected probe");
        },
        async (body) => {
          entered = true;
          await body();
        },
      );
      expect(entered).toBe(false);
      expect(marked(scene)).toEqual([]);
    }
  });

  it("treats a failed probe as not reached", async () => {
    const { scene } = structuredClone(recorded["responsive navigation"]);
    await markHitThroughLayers(scene, () => Promise.reject(new Error("detached")));
    expect(marked(scene)).toEqual([]);
  });

  it("does not let a container vouch for itself through the layer inside it", async () => {
    const scene: VomScene = {
      viewport: { width: 1000, height: 800 },
      nodes: [
        node(1, { attrs: { id: "app" } }),
        node(2, { parentId: 1, domAncestorIds: [1], position: "fixed", paintOrder: 5 }),
        node(3, {
          parentId: 1,
          domAncestorIds: [1],
          tag: "button",
          rect: { x: 10, y: 10, w: 80, h: 30 },
        }),
      ],
    };
    const probed: number[] = [];
    // The hit at the container's centre lands on the cover, its own descendant.
    await markHitThroughLayers(scene, async (target) => {
      probed.push(target.id);
      return target.id === 1;
    });
    expect(probed).toEqual([3]);
    expect(scene.nodes[1].hitThrough).toBeUndefined();
  });
});
