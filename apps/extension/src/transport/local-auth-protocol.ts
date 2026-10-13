import { decodeBytes, uint32 } from "./local-auth-crypto";

export const MAX_AUTH_MESSAGE_BYTES = 4096;
export interface Rotation {
  txn: string;
  gen: number;
}
export interface Commit extends Rotation {
  proof: string;
}
export interface CredentialOffer {
  role: "active" | "staged";
  device_id: string;
  gen: number;
  pending: Rotation | null;
}
export interface Hello {
  v: 1;
  client_nonce: string;
  instance_id: string;
  credentials: CredentialOffer[];
}
export type ChallengeResponse =
  | {
      type: "challenge";
      daemon_id: string;
      device_id: string;
      gen: number;
      server_nonce: string;
      server_proof: string;
    }
  | { type: "pairing_required"; daemon_id: string; legacy_accepted: boolean }
  | { type: "busy"; retry_after_ms: number };
export type AuthMessage =
  | { type: "local.auth.prove"; v: 1; client_proof: string }
  | { type: "local.auth.ready"; v: 1; commit: Commit | null; rotation: Rotation | null }
  | {
      type: "local.auth.rejected";
      v: 1;
      reason: "already_paired" | "replace_mismatch";
      browser_id: string;
    }
  | { type: "local.auth.rotate_confirm"; v: 1; txn: string; proof: string }
  | { type: "local.auth.committed"; v: 1; gen: number; proof: string };

function invalid(): never {
  throw new Error("Invalid local authentication message");
}

/** JSON.parse alone discards duplicate fields. Scan bounded JSON first so a
 * peer cannot make our schema checks and another implementation disagree. */
export function parseAuthJson(text: string): unknown {
  if (new TextEncoder().encode(text).length > MAX_AUTH_MESSAGE_BYTES) invalid();
  const tokens =
    text.match(
      /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[\da-fA-F]{4}))*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}\[\]:,]|[^\s]/g,
    ) ?? [];
  let cursor = 0;
  function visit(depth: number): void {
    if (depth > 16) invalid();
    const token = tokens[cursor++];
    if (token === "{") {
      const keys = new Set<string>();
      if (tokens[cursor] !== "}") {
        for (;;) {
          const keyToken = tokens[cursor++];
          if (!keyToken?.startsWith('"')) invalid();
          const key = JSON.parse(keyToken) as string;
          if (keys.has(key) || tokens[cursor++] !== ":") invalid();
          keys.add(key);
          visit(depth + 1);
          if (tokens[cursor] !== ",") break;
          cursor++;
        }
      }
      if (tokens[cursor++] !== "}") invalid();
    } else if (token === "[") {
      if (tokens[cursor] !== "]") {
        for (;;) {
          visit(depth + 1);
          if (tokens[cursor] !== ",") break;
          cursor++;
        }
      }
      if (tokens[cursor++] !== "]") invalid();
    } else if (!token || !/^(?:"|-?\d|true$|false$|null$)/.test(token)) invalid();
  }
  try {
    visit(0);
    if (cursor !== tokens.length) invalid();
    return JSON.parse(text);
  } catch {
    return invalid();
  }
}

function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const result = value as Record<string, unknown>;
  if (Object.keys(result).length !== keys.length || keys.some((key) => !Object.hasOwn(result, key)))
    invalid();
  return result;
}
function bytes(value: unknown, length: number): void {
  if (typeof value !== "string") invalid();
  decodeBytes(value, length);
}
function generation(value: unknown): void {
  if (typeof value !== "number") invalid();
  uint32(value);
}
function rotation(value: unknown, commit = false): void {
  const record = object(value, commit ? ["txn", "gen", "proof"] : ["txn", "gen"]);
  bytes(record.txn, 16);
  generation(record.gen);
  if (commit) bytes(record.proof, 32);
}
export function parseChallenge(value: unknown): ChallengeResponse {
  if (!value || typeof value !== "object") invalid();
  switch ((value as { type?: unknown }).type) {
    case "challenge": {
      const record = object(value, [
        "type",
        "daemon_id",
        "device_id",
        "gen",
        "server_nonce",
        "server_proof",
      ]);
      bytes(record.daemon_id, 16);
      bytes(record.device_id, 16);
      generation(record.gen);
      bytes(record.server_nonce, 32);
      bytes(record.server_proof, 32);
      break;
    }
    case "pairing_required": {
      const record = object(value, ["type", "daemon_id", "legacy_accepted"]);
      bytes(record.daemon_id, 16);
      if (typeof record.legacy_accepted !== "boolean") invalid();
      break;
    }
    case "busy":
      generation(object(value, ["type", "retry_after_ms"]).retry_after_ms);
      break;
    default:
      invalid();
  }
  return value as ChallengeResponse;
}
export function parseAuthMessage(text: string): AuthMessage {
  const value = parseAuthJson(text);
  if (!value || typeof value !== "object") invalid();
  const header = value as { type?: unknown; v?: unknown };
  if (header.v !== 1) invalid();
  switch (header.type) {
    case "local.auth.prove":
      bytes(object(value, ["type", "v", "client_proof"]).client_proof, 32);
      break;
    case "local.auth.ready": {
      const record = object(value, ["type", "v", "commit", "rotation"]);
      if (record.commit !== null && record.rotation !== null) invalid();
      if (record.commit !== null) rotation(record.commit, true);
      if (record.rotation !== null) rotation(record.rotation);
      break;
    }
    case "local.auth.rejected": {
      const record = object(value, ["type", "v", "reason", "browser_id"]);
      if (
        !["already_paired", "replace_mismatch"].includes(String(record.reason)) ||
        typeof record.browser_id !== "string" ||
        !/^[\da-fA-F]{8}$/.test(record.browser_id)
      )
        invalid();
      break;
    }
    case "local.auth.rotate_confirm": {
      const record = object(value, ["type", "v", "txn", "proof"]);
      bytes(record.txn, 16);
      bytes(record.proof, 32);
      break;
    }
    case "local.auth.committed": {
      const record = object(value, ["type", "v", "gen", "proof"]);
      generation(record.gen);
      bytes(record.proof, 32);
      break;
    }
    default:
      invalid();
  }
  return value as AuthMessage;
}
