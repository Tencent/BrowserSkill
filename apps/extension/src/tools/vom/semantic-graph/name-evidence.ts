const IDENTIFIER_ATTRS = ["data-testid", "data-test-id", "id"] as const;
const GENERIC_TOKENS = new Set(["btn", "button", "control", "icon", "item", "test", "tool"]);
const GENERATED_PREFIXES = new Set(["ember", "headlessui", "mui", "radix", "react", "rc"]);

function identifierTokens(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^a-zA-Z0-9]+/)
    .map((token) => token.toLowerCase())
    .filter(Boolean);
}

function readableIdentifier(value: string | undefined): string | undefined {
  const raw = value?.trim();
  if (!raw || raw.length < 3 || raw.length > 80) return undefined;
  if (/^[a-f0-9]{8,}$/i.test(raw)) return undefined;

  const tokens = identifierTokens(raw);
  if (GENERATED_PREFIXES.has(tokens[0])) return undefined;
  while (tokens.length > 1 && GENERIC_TOKENS.has(tokens[0])) tokens.shift();
  while (tokens.length > 1 && GENERIC_TOKENS.has(tokens[tokens.length - 1])) tokens.pop();
  if (tokens.length === 0 || !tokens.some((token) => /[a-z]{3,}/.test(token))) return undefined;
  return tokens
    .map((token, index) => (index === 0 ? `${token[0].toUpperCase()}${token.slice(1)}` : token))
    .join(" ");
}

export function stableIdentifierName(attrs: Readonly<Record<string, string>>): string | undefined {
  for (const name of IDENTIFIER_ATTRS) {
    const label = readableIdentifier(attrs[name]);
    if (label) return label;
  }
  return undefined;
}
