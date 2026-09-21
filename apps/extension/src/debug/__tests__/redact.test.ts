import { describe, expect, it } from "vitest";
import { jsonPointer, parseJsonSource } from "../json-source";
import { BODY_CHARS, redactBody, redactRequestUrl } from "../redact";

describe("source-preserving evidence redaction", () => {
  it.each([
    '{"orderId":9007199254740993,"action":"cancel"}',
    ' { "id":18446744073709551615, "small":-9007199254740993, "n":1.234567890123456789 } ',
    '[1e400,1e-400,-0,1.00,true,false,null,"a\\u002fb",{"x":[]} ]',
    '{"id":1,"id":9007199254740993,"__proto__":{"value":1}}',
  ])("preserves every untouched byte: %s", (text) => {
    expect(redactBody(text, "application/json")).toEqual({
      text,
      redacted: false,
      truncated: false,
      replay_safe: true,
    });
  });

  it("replaces all secret values without rounding neighbors or normalizing escaped strings", () => {
    const text =
      '{ "id":9007199254740993, "pass\\u0077ord":{"nested":42}, "password":"second", "label":"a\\u002fb", "data":[{"token":123}] }';
    const result = redactBody(text, "application/json");
    expect(result.text).toBe(
      '{ "id":9007199254740993, "pass\\u0077ord":"[redacted]", "password":"[redacted]", "label":"a\\u002fb", "data":[{"token":"[redacted]"}] }',
    );
    expect(result).toMatchObject({ redacted: true, truncated: false, replay_safe: false });
    expect(jsonPointer(result.text, "/id")).toBe("9007199254740993");
  });

  it.each([
    "password",
    "user[password]",
    "credentials.password",
    "password_confirmation",
    "user[0][newPassword]",
    "confirmPassword",
    "old_password",
    "user[access_token]",
  ])("redacts common form, query and JSON field names: %s", (key) => {
    const field = `${encodeURIComponent(key)}=example-secret`;
    const body = redactBody(
      `${field}&${field}&name=Alice%20Smith`,
      "application/x-www-form-urlencoded",
    );
    expect(body).toMatchObject({ redacted: true, truncated: false, replay_safe: false });
    expect(body.text).not.toContain("example-secret");
    expect(new URLSearchParams(body.text).getAll(key)).toEqual(["[redacted]", "[redacted]"]);
    expect(body.text).toContain("name=Alice%20Smith");
    expect(redactRequestUrl(`https://site.test/?${field}`).text).not.toContain("example-secret");
    expect(
      redactBody(JSON.stringify({ [key]: "example-secret" }), "application/json").text,
    ).not.toContain("example-secret");
  });

  it("preserves non-secret form encoding, ordering and duplicates for replay", () => {
    const text = "name=Alice%20Smith&label=a%2fb&v=1&v=2&flag&empty=";
    expect(redactBody(text, "application/x-www-form-urlencoded")).toMatchObject({
      text,
      replay_safe: true,
      redacted: false,
    });
  });

  it("omits malformed or over-deep JSON instead of retaining unparsed secrets", () => {
    for (const text of [
      '{"user[password]":"private"',
      '{"password":"private",}',
      "[".repeat(100) + '"private"' + "]".repeat(100),
    ]) {
      expect(redactBody(text, "application/json")).toEqual({
        text: "",
        truncated: true,
        redacted: true,
        replay_safe: false,
        reason: "unparsed_json",
      });
    }
    expect(
      redactBody('{"password":"' + "x".repeat(BODY_CHARS) + '"}', "application/json").text,
    ).toBe("");
    expect(() => parseJsonSource('{"a":1,}')).toThrow();
  });

  it("preserves numeric tokens in JSON pointer projections, including nested and duplicate keys", () => {
    const text = '{"a/b":[{"~":9007199254740993}],"id":1,"id":1e400}';
    expect(jsonPointer(text, "/a~1b/0/~0")).toBe("9007199254740993");
    expect(jsonPointer(text, "/id")).toBe("1e400");
    expect(jsonPointer(text, "")).toBe(text);
    expect(() => jsonPointer(text, "/constructor")).toThrow("not found");
  });
});
