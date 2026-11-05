/** Bundle a test entry only; the installed background remains unchanged. */
export async function buildPairingFixture(directory: string, version: string): Promise<string> {
  const fixture = await import(
    new URL("../../../../evals/browser/local-pairing.mjs", import.meta.url).href
  );
  return fixture.buildPairingFixture(directory, version);
}
