function hashSeed(value) {
  const text = String(value);
  let hash = 2166136261;
  for (const character of text) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function normalizeSeed(value) {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) ? numeric : hashSeed(value);
}

export function describeSeed(value) {
  const seed = normalizeSeed(value);
  const random = mulberry32(seed);
  const choose = (values) => values[Math.floor(random() * values.length)];
  return {
    seed,
    labelMode: choose(["wrapped", "for", "aria"]),
    nestingDepth: 1 + Math.floor(random() * 4),
    hydrationDelayMs: choose([0, 40, 120, 250]),
    decoy: choose(["none", "disabled-input", "duplicate-text"]),
    fieldOrder: choose(["text-first", "select-first"]),
    idSuffix: hashSeed(`${seed}:id`).toString(36).slice(0, 6),
  };
}
