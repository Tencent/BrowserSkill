import { expect, it } from "vitest";
import contract from "../../../../crates/bsk-cli/tests/fixtures/vom_contract.json";
import type { RenderRow } from "../render";
import { prepareObservationRender, renderVom } from "../render";
import type { VomNode, VomScene } from "../types";

/**
 * `bsk recipe run` reads this text to find elements by role, name and context, and
 * crates/bsk-cli/src/cli/recipe/vom.rs parses these same cases. A change to the
 * format must fail here, not silently stop saved recipes from matching.
 */
const fixture = contract as unknown as {
  cases: Array<{
    name: string;
    scene: Omit<VomScene, "nodes"> & { nodes: Partial<VomNode>[] };
    text: string;
  }>;
};

function completed(scene: (typeof fixture.cases)[number]["scene"]): VomScene {
  return {
    ...scene,
    nodes: scene.nodes.map(
      (node) =>
        ({
          rect: null,
          paintOrder: 0,
          position: "static",
          pointerEvents: "auto",
          ...node,
        }) as VomNode,
    ),
  };
}

for (const { name, scene, text } of fixture.cases) {
  it(`renders the recipe contract case "${name}"`, () => {
    expect(renderVom(completed(scene)).text).toBe(text);
  });

  it(`renders "${name}" the same way for observations`, () => {
    const prepared = prepareObservationRender(completed(scene));
    const rows = Array.from({ [Symbol.iterator]: () => prepared.rows }) as RenderRow[];
    expect([...prepared.headers, ...rows.map((row) => row.text)].join("\n")).toBe(text);
  });
}
