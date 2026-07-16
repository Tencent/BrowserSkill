import { describe, expect, it } from "vitest";
import {
  canonicalizeUrl,
  inferPageRole,
  siteFromUrl,
  summarizeNavigateShort,
  urlPatternFromUrl,
} from "../url-pattern";

describe("url-pattern", () => {
  it("strips tracking query params and keeps business keys", () => {
    const url =
      "https://www.google.com/search?q=browser+skill&oq=browser&sourceid=chrome&ie=UTF-8&utm_source=x";
    expect(canonicalizeUrl(url)).toBe("https://www.google.com/search?q=browser+skill");
  });

  it("collapses numeric and hex path segments", () => {
    expect(urlPatternFromUrl("https://iwiki.woa.com/p/4001234567/edit")).toBe(
      "https://iwiki.woa.com/p/*/edit",
    );
    expect(urlPatternFromUrl("https://example.com/doc/abcdef0123456789")).toBe(
      "https://example.com/doc/*",
    );
  });

  it("infers page role and short navigate summary", () => {
    expect(inferPageRole("https://example.com/p/1/edit")).toBe("editor");
    expect(inferPageRole("https://example.com/")).toBe("home");
    expect(siteFromUrl("https://iwiki.woa.com/x")).toBe("iwiki.woa.com");
    expect(summarizeNavigateShort("https://iwiki.woa.com/p/1/edit")).toBe(
      "打开 iwiki.woa.com/p/*/edit",
    );
  });
});
