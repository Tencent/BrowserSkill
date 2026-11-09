/** Local authentication v1. Keys remain in extension-owned storage. */
export function encodeBytes(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export function decodeBytes(value: string, length: number): Uint8Array<ArrayBuffer> {
  if (value.length !== Math.ceil((length * 8) / 6) || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("Invalid authentication field");
  }
  const bytes = Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (c) =>
    c.charCodeAt(0),
  );
  if (bytes.length !== length || encodeBytes(bytes) !== value)
    throw new Error("Invalid authentication field");
  return bytes;
}

const utf8 = (value: string) => new TextEncoder().encode(value);
export function uint32(value: number): Uint8Array<ArrayBuffer> {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff)
    throw new Error("Invalid authentication generation");
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value);
  return bytes;
}

export function fields(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(parts.reduce((length, part) => length + 4 + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(uint32(part.length), offset);
    result.set(part, offset + 4);
    offset += 4 + part.length;
  }
  return result;
}

export interface Transcript {
  daemon_id: string;
  device_id: string;
  gen: number;
  instance_id: string;
  origin: string;
  client_nonce: string;
  server_nonce: string;
}
export function transcript(value: Transcript): Uint8Array<ArrayBuffer> {
  return fields([
    utf8("bsk-local-auth-v1"),
    decodeBytes(value.daemon_id, 16),
    decodeBytes(value.device_id, 16),
    uint32(value.gen),
    utf8(value.instance_id),
    utf8(value.origin),
    decodeBytes(value.client_nonce, 32),
    decodeBytes(value.server_nonce, 32),
  ]);
}

export type Purpose = "server" | "client" | "rotate" | "confirm" | "committed";
function proofInput(purpose: Purpose, value: Uint8Array, txn?: string): Uint8Array<ArrayBuffer> {
  if ((purpose === "server" || purpose === "client") !== (txn === undefined)) {
    throw new Error("Invalid authentication purpose");
  }
  return fields(
    txn === undefined ? [utf8(purpose), value] : [utf8(purpose), value, decodeBytes(txn, 16)],
  );
}
function importKey(key: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    decodeBytes(key, 32),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}
export async function prove(
  key: string,
  purpose: Purpose,
  value: Uint8Array,
  txn?: string,
): Promise<string> {
  return encodeBytes(
    new Uint8Array(
      await crypto.subtle.sign("HMAC", await importKey(key), proofInput(purpose, value, txn)),
    ),
  );
}
export async function verify(
  key: string,
  purpose: Purpose,
  value: Uint8Array,
  proof: string,
  txn?: string,
): Promise<boolean> {
  return crypto.subtle.verify(
    "HMAC",
    await importKey(key),
    decodeBytes(proof, 32),
    proofInput(purpose, value, txn),
  );
}
export function randomBytes(length: 16 | 32): string {
  return encodeBytes(crypto.getRandomValues(new Uint8Array(length)));
}
