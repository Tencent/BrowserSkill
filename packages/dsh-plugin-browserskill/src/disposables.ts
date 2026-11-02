/** Release every owned resource in reverse order, including after a release fails. */
export function disposeAll(disposers: (() => void)[]): void {
  const errors: unknown[] = [];
  for (const dispose of disposers.splice(0).reverse()) {
    try {
      dispose();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, "BrowserSkill cleanup failed");
}
