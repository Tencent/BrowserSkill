// dsh 0.1 keys the client graph and Node import by `export const name`.
// That string must stay identical to the published package name (and therefore
// the client.cjs __ModuleLoader__ id, which tsdown reads from package.json).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { name } from "../src/index";

const pkg = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"),
) as {
  name: string;
  dsh: { client: { external?: string[] } };
};

describe("plugin identity", () => {
  it("uses the published package name as the Cordis plugin id", () => {
    expect(name).toBe("@wxg-prc-cpg/browser-skill-dsh-plugin");
    expect(name).toBe(pkg.name);
  });

  it("declares client require()s so dsh arrives them before materialize", () => {
    expect(pkg.dsh.client.external).toEqual(
      expect.arrayContaining([
        "@deepseek-ai/dsh-client-ui-attachment",
        "@deepseek-ai/dsh-client-ui-primitives",
      ]),
    );
  });
});
