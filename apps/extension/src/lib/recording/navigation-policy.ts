const REDIRECT_QUALIFIERS = new Set(["client_redirect", "server_redirect"]);

export function hasRedirectQualifier(qualifiers?: readonly string[]): boolean {
  return (qualifiers ?? []).some((qualifier) => REDIRECT_QUALIFIERS.has(qualifier));
}
