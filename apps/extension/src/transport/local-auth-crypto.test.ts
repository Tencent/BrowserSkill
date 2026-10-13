import { describe, expect, it } from "vitest";
import v from "../../../../crates/bsk-protocol/tests/fixtures/local-auth-v1.json";
import type { Purpose } from "./local-auth-crypto";
import { decodeBytes, encodeBytes, fields, prove, transcript, verify } from "./local-auth-crypto";
import { parseAuthJson, parseAuthMessage, parseChallenge } from "./local-auth-protocol";

describe("local authentication protocol", () => {
  it("L22: matches the Rust vectors for every proof and field encoding", async () => {
    const t = transcript(v);
    expect(encodeBytes(t)).toBe(v.transcript);
    expect(encodeBytes(fields([new Uint8Array([1, 2]), new Uint8Array([3])]))).toBe(
      "AAAAAgECAAAAAQM",
    );
    for (const purpose of ["server", "client"] as const)
      expect(await prove(v.key, purpose, t)).toBe(v[purpose]);
    const candidate = await prove(v.key, "rotate", t, v.txn);
    expect(candidate).toBe(v.candidate);
    for (const purpose of ["confirm", "committed"] as const)
      expect(await prove(candidate, purpose, t, v.txn)).toBe(v[purpose]);
  });
  it("L08b: recovers using the saved candidate and the new transcript", async () => {
    const t = transcript({
      ...v,
      gen: 1,
      client_nonce: v.recovery_client_nonce,
      server_nonce: v.recovery_server_nonce,
    });
    expect(encodeBytes(t)).toBe(v.recovery_transcript);
    expect(await verify(v.candidate, "committed", t, v.commit_proof, v.txn)).toBe(true);
    expect(
      await verify(await prove(v.key, "rotate", t, v.txn), "committed", t, v.commit_proof, v.txn),
    ).toBe(false);
  });
  it("L06: rejects reflected proofs across every role", async () => {
    const roles: Purpose[] = ["server", "client", "confirm", "committed"];
    for (const role of roles) {
      const proof = await prove(
        v.key,
        role,
        transcript(v),
        roles.indexOf(role) > 1 ? v.txn : undefined,
      );
      for (const other of roles)
        expect(
          await verify(
            v.key,
            other,
            transcript(v),
            proof,
            roles.indexOf(other) > 1 ? v.txn : undefined,
          ),
        ).toBe(role === other);
    }
  });
  it("L15: rejects duplicate (including escaped), unknown, oversized and malformed messages", () => {
    const valid = JSON.stringify({ type: "local.auth.prove", v: 1, client_proof: v.client });
    expect(parseAuthMessage(valid).type).toBe("local.auth.prove");
    for (const text of [
      valid.replace('"v":1', '"v":1,"v":1'),
      valid.replace('"v":1', '"v":1,"\\u0076":1'),
      valid.replace('"v":1', '"v":1,"extra":true'),
      valid.replace('"v":1', '"v":2'),
      `${valid}${" ".repeat(4096)}`,
      '{"x":[{"x":1,"x":2}]}',
      '{"x":1,}',
      "[1 2]",
    ])
      expect(() => parseAuthMessage(text)).toThrow();
    expect(() =>
      parseAuthMessage(
        JSON.stringify({
          type: "local.auth.ready",
          v: 1,
          rotation: { txn: v.txn, gen: 1 },
          commit: { txn: v.txn, gen: 1, proof: v.committed },
        }),
      ),
    ).toThrow();
    expect(() =>
      parseChallenge({
        type: "pairing_required",
        daemon_id: v.daemon_id,
        legacy_accepted: true,
        extra: 1,
      }),
    ).toThrow();
    expect(() => decodeBytes(`${v.key}=`, 32)).toThrow();
    expect(() => decodeBytes("a".repeat(43), 32)).toThrow();
    expect(parseAuthJson('{"a":[null,true,false,{"a":1}],"b":"c"}')).toEqual({
      a: [null, true, false, { a: 1 }],
      b: "c",
    });
  });
});
