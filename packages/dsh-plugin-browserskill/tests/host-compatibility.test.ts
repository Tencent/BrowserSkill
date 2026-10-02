import { readFileSync } from "node:fs";
import { satisfies } from "semver";
import { describe, expect, it } from "vitest";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  peerDependencies: Record<string, string>;
};
const dshPeers = Object.entries(manifest.peerDependencies).filter(
  ([name]) => name === "@deepseek-ai/dsh" || name.startsWith("@deepseek-ai/dsh-"),
);

// DSH checks every DSH peer against its runtime version before loading the
// bundle, including optional peers. Its preflight includes prereleases.
describe("DSH host admission", () => {
  it("declares host peer requirements", () => {
    expect(dshPeers.length).toBeGreaterThan(0);
  });

  describe.each(dshPeers)("%s (%s)", (_name, range) => {
    it.each([
      "0.1.5-rc.3",
      "0.1.5",
      "0.1.7-rc.2",
      "0.2.0-rc.1",
      "0.2.0",
      "0.2.1",
    ])("admits supported host %s", (version) => {
      expect(satisfies(version, range, { includePrerelease: true })).toBe(true);
    });

    it.each([
      "0.1.0",
      "0.1.5-rc.2",
      "0.2.0-rc.0",
      "0.3.0-rc.1",
      "0.3.0",
      "1.0.0",
    ])("keeps unsupported host %s outside the declared range", (version) => {
      expect(satisfies(version, range, { includePrerelease: true })).toBe(false);
    });
  });
});
