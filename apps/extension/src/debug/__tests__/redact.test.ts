// @vitest-environment node

import { describe, expect, it } from "vitest";
import { jsonPointer, parseJsonSource } from "../json-source";
import { BODY_CHARS, redactBody, redactHeaders, redactRequestUrl } from "../redact";

describe("source-preserving evidence redaction", () => {
  it.each([
    "PRIVATE-TOKEN",
    "x-goog-api-key",
    "X-Amz-Security-Token",
    "Ocp-Apim-Subscription-Key",
    "X-Vault-Token",
    "X-Access-Token",
    "X-CSRFToken",
    "X-Shopify-Access-Token",
    "X-Hasura-Admin-Secret",
  ])("redacts the vendor credential header %s", (name) => {
    expect(redactHeaders({ [name]: "BSK_SYNTHETIC_SECRET_7264" })).toEqual({
      [name.toLowerCase()]: "[redacted]",
    });
  });

  it("matches vendor credential names exactly, not by a token suffix", () => {
    // A generic `*token` rule would also hide pagination cursors (#555).
    expect(redactHeaders({ "x-page-token": "cursor-2", "x-request-id": "r1" })).toEqual({
      "x-page-token": "cursor-2",
      "x-request-id": "r1",
    });
    const json =
      '{"nextPageToken":"cursor-2","pageToken":"cursor-1","private_token":"BSK_SYNTHETIC_SECRET_7264"}';
    expect(redactBody(json, "application/json").text).toBe(
      '{"nextPageToken":"cursor-2","pageToken":"cursor-1","private_token":"[redacted]"}',
    );
  });

  it.each([
    'type="password"',
    'type="pass&#x77;ord"',
    'name="pass&#119;ord"',
    "id='pass&#000119;ord'",
    "autocomplete=current-pass&#x77;ord",
    'TYPE="PaSs&#X57;OrD"',
    "name='PaSs&#87;OrD'",
    "ID=PaSs&#x57;OrD",
    'AUTOCOMPLETE="CURRENT-PaSs&#X57;OrD"',
    "type=pass&#119ord",
    "type='pass&#x77ord'",
    'type="&#112;&#x61;ss&#x77;ord"',
    'type="&#0000000000000000000000000000000000000000000112;assword"',
    'name="user&#91;pass&#119;ord&#93;"',
    'name="confirmPass&#x77;ord"',
    'id="user&lowbar;pass&#119;ord"',
    'name="user&UnderBar;password"',
    'name="credentials&period;password"',
    'name="user&lbrack;password&rbrack;"',
    'name="user&lsqb;password&rsqb;"',
    'name="access&lowbar;token"',
    'autocomplete="one&#45;time&#x2d;code"',
    "autocomplete='cc&#45;number'",
    'autocomplete="new-pass&#119;ord"',
    'autocomplete=" current-password "',
    'autocomplete="section-login one-time-code"',
    'autocomplete="section-checkout billing cc-number"',
    'autocomplete="section-login current-password "',
  ])("redacts HTML-encoded sensitive input attributes: %s", (attribute) => {
    const before = "<p>Keep &amp;</p>";
    const after = '<input name="nickname" value="Alice &amp; Bob">';
    const text = `${before}<input value="BSK_SYNTHETIC_SECRET_7264" ${attribute}>${after}`;
    expect(redactBody(text, "text/html")).toEqual({
      text: `${before}<input data-bsk-redacted="true">${after}`,
      redacted: true,
      truncated: false,
      replay_safe: false,
    });
  });

  it.each([
    'name="nick&#110;ame"',
    'name="display&period;name"',
    'autocomplete="section-login email"',
    'autocomplete=" shipping street-address "',
    'id="user&lsqb;label&rsqb;"',
    'name="label&#x1F600;"',
    'type="pass&amp;#119;ord"',
    'type="pass&#38;#119;ord"',
    'name="user&amp;lowbar;password"',
    'name="user&#38;lowbar;password"',
    'name="user&unknown;password"',
    'name="user&LOWBAR;password"',
    'name="user&lowbarpassword"',
    'type="pass&#;word"',
    'type="pass&#x;word"',
    'type="pass&#0;word"',
    'type="pass&#xD800;word"',
    'type="pass&#x110000;word"',
    `type="pass&#${"9".repeat(400)};word"`,
    'type="pass&#1191;ord"',
    'type="pass&#x77a;ord"',
  ])("preserves non-sensitive HTML bytes without recursive decoding: %s", (attribute) => {
    const text = `<input ${attribute} value="Alice &amp; Bob">`;
    expect(redactBody(text, "text/html")).toEqual({
      text,
      redacted: false,
      truncated: false,
      replay_safe: true,
    });
  });

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

  it("preserves plain text logs, NDJSON, JavaScript, and HTML starting with [ or { without unparsed_json wipes", () => {
    const log = "[2026-11-21 10:00:00] INFO Server started token=secret123 user=alice";
    expect(redactBody(log, "text/plain")).toEqual({
      text: "[2026-11-21 10:00:00] INFO Server started token=[redacted] user=alice",
      redacted: true,
      truncated: false,
      replay_safe: false,
    });

    const cleanLog = "[2026-11-21 10:00:00] INFO Health check ok";
    expect(redactBody(cleanLog, "text/plain")).toEqual({
      text: cleanLog,
      redacted: false,
      truncated: false,
      replay_safe: true,
    });

    const ndjson = '{"id":1,"status":"ok"}\n{"id":2,"password":"secret"}\n';
    for (const mime of ["application/x-ndjson", "application/jsonl", "text/plain"]) {
      const res = redactBody(ndjson, mime);
      expect(res.reason).toBeUndefined();
      expect(res.text).toContain('{"id":1,"status":"ok"}');
      expect(res.text).not.toContain("secret");
      expect(res.redacted).toBe(true);
    }

    const script = "{ const items = [1, 2, 3]; console.log(items); }";
    expect(redactBody(script, "application/javascript")).toEqual({
      text: script,
      redacted: false,
      truncated: false,
      replay_safe: true,
    });

    const html = '[Notice] <input type="password" value="s3cr3t"><p>Visible</p>';
    expect(redactBody(html, "text/html")).toEqual({
      text: '[Notice] <input data-bsk-redacted="true"><p>Visible</p>',
      redacted: true,
      truncated: false,
      replay_safe: false,
    });

    // Oversized plain-text log starting with `[` truncates cleanly rather than wiping to empty.
    const bigLog = `[INFO] ${"a".repeat(BODY_CHARS + 50)}`;
    const bigRes = redactBody(bigLog, "text/plain");
    expect(bigRes.reason).toBeUndefined();
    expect(bigRes.truncated).toBe(true);
    expect(bigRes.text.length).toBe(BODY_CHARS);
    expect(bigRes.text.startsWith("[INFO] ")).toBe(true);

    // Valid JSON returned with text/plain or empty Content-Type is still JSON-redacted.
    expect(redactBody('{"user[password]":"secret","ok":true}', "text/plain").text).toBe(
      '{"user[password]":"[redacted]","ok":true}',
    );
  });

  it("redacts JSON-only secret fields in NDJSON records and omits oversized text/plain JSON prefixes", () => {
    const ndjson = '{"id":1,"session_id":"sess-alpha-1"}\n{"id":2,"credentials":"cred-beta-2"}\n';
    for (const mime of ["application/x-ndjson", "application/jsonl", "text/plain"]) {
      const res = redactBody(ndjson, mime);
      expect(res).toEqual({
        text: '{"id":1,"session_id":"[redacted]"}\n{"id":2,"credentials":"[redacted]"}\n',
        redacted: true,
        truncated: false,
        replay_safe: false,
      });
    }

    // Malformed declared NDJSON must still fail closed rather than leaking unparsed lines.
    expect(redactBody('{"id":1}\n{"session_id":"leak"', "application/x-ndjson")).toEqual({
      text: "",
      redacted: true,
      truncated: true,
      replay_safe: false,
      reason: "unparsed_json",
    });

    // Oversized JSON served as text/plain is omitted instead of retaining an unredacted prefix.
    const bigTextPlainJson = `{"session_id":"sess-secret-99","pad":"${"x".repeat(BODY_CHARS)}"}`;
    expect(redactBody(bigTextPlainJson, "text/plain")).toEqual({
      text: "",
      redacted: true,
      truncated: true,
      replay_safe: false,
    });

    // Oversized plain-text logs with timestamp brackets still truncate without wiping.
    const bigTimestampLog = `[2026-11-21 10:00:00] INFO ${"a".repeat(BODY_CHARS)}`;
    const logRes = redactBody(bigTimestampLog, "text/plain");
    expect(logRes.truncated).toBe(true);
    expect(logRes.text.startsWith("[2026-11-21 10:00:00] INFO ")).toBe(true);
    expect(logRes.text.length).toBe(BODY_CHARS);

    // Valid JSON served under form, HTML, or JavaScript MIME types still runs JSON secret redaction.
    const mislabeledJson = '{"session_id":"sess-leak-1","password":"pw-secret","ok":true}';
    for (const mime of [
      "application/x-www-form-urlencoded",
      "text/html",
      "application/javascript",
    ]) {
      expect(redactBody(mislabeledJson, mime)).toEqual({
        text: '{"session_id":"[redacted]","password":"[redacted]","ok":true}',
        redacted: true,
        truncated: false,
        replay_safe: false,
      });
    }

    // Incomplete trailing NDJSON record under text/plain fails closed rather than leaking earlier records via redactText.
    expect(redactBody('{"session_id":"sess-leak-2"}\n{"partial":', "text/plain")).toEqual({
      text: "",
      redacted: true,
      truncated: true,
      replay_safe: false,
      reason: "unparsed_json",
    });
  });

  it("preserves numeric tokens in JSON pointer projections, including nested and duplicate keys", () => {
    const text = '{"a/b":[{"~":9007199254740993}],"id":1,"id":1e400}';
    expect(jsonPointer(text, "/a~1b/0/~0")).toBe("9007199254740993");
    expect(jsonPointer(text, "/id")).toBe("1e400");
    expect(jsonPointer(text, "")).toBe(text);
    expect(() => jsonPointer(text, "/constructor")).toThrow("not found");
  });
});
