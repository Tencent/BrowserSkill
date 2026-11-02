import { describe, expect, it } from "vitest";
import { estimateLineTokens, estimateTokens } from "../tokens";

// Reference counts come from the o200k tokenizer (gpt-tokenizer 2.9.0). They
// are recorded here so the test does not depend on a tokenizer package.
const FIXTURES: { name: string; text: string; reference: number }[] = [
  {
    name: "English VOM",
    text: [
      "@vom 1",
      "@view 1280x720",
      "@layers 1 focus=L1",
      "L1 page",
      '  RootWebArea "Shop"',
      '    navigation "Main menu"',
      '      @e1 link "Home"',
      "    main",
      '      heading "Today\'s picks"',
      '      @e2 button "Add to cart"',
    ].join("\n"),
    reference: 66,
  },
  {
    name: "English prose",
    text: "This page explains the return policy: customers may return items within thirty days without giving a reason, provided the packaging is intact and proof of purchase is supplied.",
    reference: 31,
  },
  {
    name: "Chinese VOM",
    text: [
      "@vom 1",
      "@view 1280x720",
      "@layers 1 focus=L1",
      "L1 page",
      '  RootWebArea "Shop"',
      '    navigation "主菜单"',
      '      @e1 link "首页"',
      "    main",
      '      heading "今日推荐"',
      '      @e2 button "加入购物车"',
    ].join("\n"),
    reference: 65,
  },
  {
    name: "Simplified Chinese body text",
    text: "这是一个关于商品退货政策的说明页面，用户可以在三十天内申请无理由退货，但需要保持商品包装完整并提供购买凭证。",
    reference: 35,
  },
  {
    name: "Traditional Chinese body text",
    text: "這是一個關於商品退貨政策的說明頁面，使用者可以在三十天內申請無理由退貨，但需要保持商品包裝完整並提供購買憑證。",
    reference: 44,
  },
  {
    name: "Japanese VOM",
    text: '@e3 button "カートに追加"\n@e4 link "注文履歴を見る"',
    reference: 20,
  },
  {
    name: "Korean VOM",
    text: '@e5 button "장바구니에 담기"\n@e6 link "주문 내역 보기"',
    reference: 24,
  },
  {
    name: "Italian prose",
    text: "Il salvataggio termina le attività correnti e si riconnette se l'interruttore di connessione è attivo.",
    reference: 27,
  },
  {
    name: "URL with an opaque id",
    text: "https://chromewebstore.google.com/detail/hhcmgoofomhgciiibhipgmgkgnoenaoi",
    reference: 24,
  },
  {
    name: "English sentence with a short opaque id",
    text: "Click here to download the qwertyuiopasdfghjklzxcvbnm file",
    reference: 20,
  },
];

// o200k: 80 tokens for the smileys, 1 for the heart and its U+FE0F.
const SMILEYS = "😀".repeat(80);

describe("estimateTokens", () => {
  it.each(FIXTURES)("stays within -10%/+30% of the reference for $name", ({ text, reference }) => {
    const ratio = estimateTokens(text) / reference;
    expect(ratio).toBeGreaterThanOrEqual(0.9);
    expect(ratio).toBeLessThanOrEqual(1.3);
  });

  it("is tight for English prose and VOM structure", () => {
    for (const name of ["English VOM", "English prose"]) {
      const { text, reference } = FIXTURES.find((fixture) => fixture.name === name) ?? FIXTURES[0];
      expect(Math.abs(estimateTokens(text) - reference) / reference).toBeLessThanOrEqual(0.12);
    }
  });

  it("does not undercount like ceil(chars / 4) did", () => {
    for (const name of ["English VOM", "Chinese VOM", "Japanese VOM", "Korean VOM"]) {
      const { text, reference } = FIXTURES.find((fixture) => fixture.name === name) ?? FIXTURES[0];
      expect(Math.ceil(text.length / 4)).toBeLessThan(reference * 0.85);
      expect(estimateTokens(text)).toBeGreaterThanOrEqual(reference * 0.9);
    }
  });

  it("costs long non-English words more than English ones of the same length", () => {
    expect(estimateTokens("the configuration of the interrupter")).toBeLessThan(
      estimateTokens("la configurazione dell interruttore"),
    );
  });

  it("costs VOM role words by their real token count", () => {
    expect(estimateLineTokens(" navigation")).toBeLessThan(estimateLineTokens(" menuitemcheckbox"));
    expect(estimateTokens("    @e1 navigation")).toBe(estimateTokens("    @e1 button"));
  });

  it("counts empty text as zero and every line break", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("\n")).toBeGreaterThanOrEqual(1);
    expect(estimateLineTokens("")).toBe(1);
  });

  it("counts a surrogate pair as one symbol, not two", () => {
    expect(estimateLineTokens("😀") - 1).toBeLessThan(2);
  });

  it("keeps the cost of every emoji when a variation selector follows one", () => {
    expect(estimateTokens(`${SMILEYS}❤️`)).toBeGreaterThanOrEqual(81);
    expect(estimateTokens(`${SMILEYS}❤️`)).toBeGreaterThan(estimateTokens(SMILEYS));
    expect(estimateTokens(`Saved ${SMILEYS}❤️`)).toBeGreaterThan(estimateTokens(`Saved ${SMILEYS}`));
  });

  it("never lowers the estimate when a symbol is appended", () => {
    for (const text of [SMILEYS, "Home", '"首页', "장바구니", "→ next", "a\u0301"]) {
      for (const symbol of ["❤️", "\ufe0f", "\u0301", "👍🏽", "!", "，"]) {
        expect(estimateTokens(text + symbol)).toBeGreaterThanOrEqual(estimateTokens(text));
      }
    }
  });

  it("treats a combining accent after a letter as part of the word", () => {
    expect(estimateTokens("cafe\u0301")).toBeLessThanOrEqual(estimateTokens("café") + 1);
  });

  it("costs short opaque ids by their letters, not as English words", () => {
    // o200k: the 26-letter id alone is 13 tokens.
    expect(estimateTokens(" qwertyuiopasdfghjklzxcvbnm")).toBeGreaterThanOrEqual(12);
    expect(estimateTokens("Your order hzqxkvbtmw ships")).toBeGreaterThan(
      estimateTokens("Your order successfully ships"),
    );
  });

  it("does not mistake long English words for ids", () => {
    // o200k: 4 and 8 tokens.
    expect(estimateTokens("Download the configuration file")).toBeLessThanOrEqual(5);
    expect(estimateTokens("Read about the internationalization of the app")).toBeLessThanOrEqual(9);
  });

  it("sums per-line costs without rounding each line", () => {
    const lines = ["  main", '    @e1 link "Home"', '    @e2 link "Docs"'];
    const summed = lines.reduce((total, line) => total + estimateLineTokens(line), 0);
    expect(Number.isInteger(summed)).toBe(false);
    expect(summed).toBeLessThan(lines.reduce((total, line) => total + estimateTokens(line) + 1, 0));
  });
});
