import { i18n } from "@browser-skill/i18n";
import { I18nextProvider } from "@browser-skill/i18n/react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type HelpRequestData, HelpRequestOverlay } from "../HelpRequestOverlay";

function renderOverlay(req: HelpRequestData) {
  return render(
    createElement(I18nextProvider, { i18n }, createElement(HelpRequestOverlay, { request: req })),
  );
}

function baseRequest(overrides: Partial<HelpRequestData> = {}): HelpRequestData {
  return {
    id: "r1",
    prompt: "Please complete the captcha",
    selectors: [],
    onContinue: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  };
}

function overlayStyles(container: HTMLElement): string {
  return Array.from(container.querySelectorAll("style"))
    .map((style) => style.textContent ?? "")
    .join("\n");
}

describe("HelpRequestOverlay", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders the prompt", () => {
    renderOverlay(baseRequest());
    expect(screen.getByText("Please complete the captcha")).toBeTruthy();
  });

  it("renders a custom title when provided", () => {
    renderOverlay(baseRequest({ title: "Verify your identity" }));
    expect(screen.getByText("Verify your identity")).toBeTruthy();
  });

  it("falls back to the default i18n title when title is omitted", () => {
    renderOverlay(baseRequest());
    expect(screen.getByText(i18n.t("helpRequest.title", { ns: "extension" }))).toBeTruthy();
  });

  it("calls onContinue with the typed note", () => {
    const onContinue = vi.fn();
    const { container } = renderOverlay(baseRequest({ onContinue }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "did it" } });
    const continueBtn = container.querySelector(
      "[data-slot='help-continue-button']",
    ) as HTMLButtonElement;
    fireEvent.click(continueBtn);
    expect(onContinue).toHaveBeenCalledWith("did it");
  });

  it("calls onCancel when cancel clicked", () => {
    const onCancel = vi.fn();
    const { container } = renderOverlay(baseRequest({ onCancel }));
    const cancelBtn = container.querySelector(
      "[data-slot='help-cancel-button']",
    ) as HTMLButtonElement;
    fireEvent.click(cancelBtn);
    expect(onCancel).toHaveBeenCalled();
  });

  it("highlights a matched selector and reports a missing one", () => {
    const el = document.createElement("div");
    el.id = "login";
    el.getBoundingClientRect = () =>
      ({ top: 10, left: 10, width: 100, height: 40, right: 110, bottom: 50 }) as DOMRect;
    el.scrollIntoView = vi.fn();
    document.body.append(el);
    renderOverlay(baseRequest({ selectors: ["#login", "#missing"] }));
    // One highlight box rendered for the matched selector.
    expect(document.querySelectorAll("[data-slot='help-highlight']").length).toBe(1);
    expect(el.scrollIntoView as ReturnType<typeof vi.fn>).toHaveBeenCalled();
    el.remove();
  });

  it("scrolls into view for each distinct request when switching A→B directly", () => {
    const makeTarget = (id: string) => {
      const el = document.createElement("div");
      el.id = id;
      el.getBoundingClientRect = () =>
        ({ top: 10, left: 10, width: 100, height: 40, right: 110, bottom: 50 }) as DOMRect;
      el.scrollIntoView = vi.fn();
      document.body.append(el);
      return el;
    };
    const elA = makeTarget("a-target");
    const elB = makeTarget("b-target");

    const { rerender } = render(
      createElement(
        I18nextProvider,
        { i18n },
        createElement(HelpRequestOverlay, {
          request: baseRequest({ id: "a", selectors: ["#a-target"] }),
        }),
      ),
    );
    rerender(
      createElement(
        I18nextProvider,
        { i18n },
        createElement(HelpRequestOverlay, {
          request: baseRequest({ id: "b", selectors: ["#b-target"] }),
        }),
      ),
    );

    expect(elA.scrollIntoView as ReturnType<typeof vi.fn>).toHaveBeenCalled();
    expect(elB.scrollIntoView as ReturnType<typeof vi.fn>).toHaveBeenCalled();
    elA.remove();
    elB.remove();
  });

  it("anchors the banner near a matched selector", () => {
    const el = document.createElement("div");
    el.id = "login";
    el.getBoundingClientRect = () =>
      ({ top: 100, left: 200, width: 120, height: 40, right: 320, bottom: 140 }) as DOMRect;
    el.scrollIntoView = vi.fn();
    document.body.append(el);
    renderOverlay(baseRequest({ selectors: ["#login"] }));

    const banner = document.querySelector("[data-slot='help-request-banner']") as HTMLElement;
    expect(banner.getAttribute("data-anchored")).toBe("true");
    expect(banner.style.top).not.toBe("");
    expect(banner.style.left).not.toBe("");
    expect(banner.style.bottom).toBe("auto");
    expect(banner.style.transform).toBe("translateX(-50%)");
    expect(banner.style.top).toBe("152px");
    expect(banner.style.left).toBe("260px");

    el.remove();
  });

  it("falls back to bottom-center when no selectors match", () => {
    renderOverlay(baseRequest({ selectors: [] }));
    const banner = document.querySelector("[data-slot='help-request-banner']") as HTMLElement;
    expect(banner.getAttribute("data-anchored")).toBe("false");
    expect(banner.style.top).toBe("");
    expect(banner.style.left).toBe("");
  });

  it("keeps the above placement edge anchored while collapsing", () => {
    const el = document.createElement("div");
    el.id = "login";
    const targetTop = window.innerHeight - 80;
    const targetBottom = targetTop + 40;
    el.getBoundingClientRect = () =>
      ({
        top: targetTop,
        left: 200,
        width: 120,
        height: 40,
        right: 320,
        bottom: targetBottom,
      }) as DOMRect;
    el.scrollIntoView = vi.fn();
    document.body.append(el);
    renderOverlay(baseRequest({ selectors: ["#login"] }));

    const banner = document.querySelector("[data-slot='help-request-banner']") as HTMLElement;
    expect(banner.getAttribute("data-placement")).toBe("above");
    expect(banner.style.top).toBe("auto");
    expect(banner.style.bottom).toBe(`${window.innerHeight - targetTop + 12}px`);
    const bottomBefore = banner.style.bottom;

    fireEvent.click(screen.getByLabelText(i18n.t("helpRequest.collapse", { ns: "extension" })));

    expect(banner.getAttribute("data-placement")).toBe("above");
    expect(banner.style.top).toBe("auto");
    expect(banner.style.bottom).toBe(bottomBefore);

    el.remove();
  });

  it("removes body content from collapsed width layout", () => {
    const { container } = renderOverlay(
      baseRequest({
        prompt:
          "This is a very long prompt that should not make the collapsed help request banner wide.",
      }),
    );

    fireEvent.click(screen.getByLabelText(i18n.t("helpRequest.collapse", { ns: "extension" })));

    const banner = container.querySelector("[data-slot='help-request-banner']") as HTMLElement;
    const body = container.querySelector(".bsk-help-body") as HTMLElement;
    const styles = overlayStyles(container);

    expect(banner.getAttribute("data-collapsed")).toBe("true");
    expect(body.getAttribute("aria-hidden")).toBe("true");
    expect(styles).toContain('.bsk-help-banner[data-collapsed="true"] .bsk-help-body');
    expect(styles).toContain("position: absolute");
    expect(styles).toContain("width: 0");
  });

  it("keeps the same banner width when collapsed", () => {
    const { container } = renderOverlay(baseRequest());
    const styles = overlayStyles(container);

    fireEvent.click(screen.getByLabelText(i18n.t("helpRequest.collapse", { ns: "extension" })));

    const banner = container.querySelector("[data-slot='help-request-banner']") as HTMLElement;
    expect(banner.getAttribute("data-collapsed")).toBe("true");
    expect(styles).toContain("--bsk-help-banner-width: 420px");
    expect(styles).toContain("width: var(--bsk-help-banner-width)");
    expect(styles).not.toContain("width: auto");
  });

  it("keeps collapsed header actions visible when the title is long", () => {
    const { container } = renderOverlay(
      baseRequest({
        title:
          "This title is intentionally long enough to compete with the collapsed action buttons for space",
      }),
    );

    fireEvent.click(screen.getByLabelText(i18n.t("helpRequest.collapse", { ns: "extension" })));

    const banner = container.querySelector("[data-slot='help-request-banner']") as HTMLElement;
    const styles = overlayStyles(container);
    expect(banner.getAttribute("data-collapsed")).toBe("true");
    expect(styles).toMatch(
      /\.bsk-help-title\s*\{[^}]*min-width:\s*0;[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;/s,
    );
    expect(styles).toMatch(/\.bsk-help-header-actions\s*\{[^}]*flex-shrink:\s*0;/s);
  });

  it("moves the banner when dragging the top strip and freezes auto positioning", () => {
    const el = document.createElement("div");
    el.id = "login";
    el.getBoundingClientRect = () =>
      ({ top: 100, left: 200, width: 120, height: 40, right: 320, bottom: 140 }) as DOMRect;
    el.scrollIntoView = vi.fn();
    document.body.append(el);
    renderOverlay(baseRequest({ selectors: ["#login"] }));

    const banner = document.querySelector("[data-slot='help-request-banner']") as HTMLElement;
    const handle = banner.querySelector("[data-slot='help-drag-handle']") as HTMLElement;
    const anchoredTop = banner.style.top;
    const anchoredLeft = banner.style.left;

    banner.getBoundingClientRect = () =>
      ({
        top: 152,
        left: 50,
        width: 420,
        height: 180,
        right: 470,
        bottom: 332,
      }) as DOMRect;
    Object.defineProperty(banner, "offsetWidth", { value: 420, configurable: true });
    Object.defineProperty(banner, "offsetHeight", { value: 180, configurable: true });

    fireEvent.pointerDown(handle, { button: 0, clientX: 210, clientY: 154, pointerId: 1 });
    fireEvent(window, new PointerEvent("pointermove", { clientX: 260, clientY: 184 }));
    fireEvent(window, new PointerEvent("pointerup", { pointerId: 1 }));

    expect(banner.style.transform).toBe("none");
    expect(banner.style.top).toBe("182px");
    expect(banner.style.left).toBe("100px");

    el.getBoundingClientRect = () =>
      ({ top: 300, left: 400, width: 120, height: 40, right: 520, bottom: 340 }) as DOMRect;
    fireEvent.scroll(window);
    fireEvent.resize(window);

    expect(banner.style.top).toBe("182px");
    expect(banner.style.left).toBe("100px");
    expect(banner.style.top).not.toBe(anchoredTop);
    expect(banner.style.left).not.toBe(anchoredLeft);

    el.remove();
  });

  it("does not start drag when pointer down on a button in the header", () => {
    const { container } = renderOverlay(baseRequest());
    const banner = container.querySelector("[data-slot='help-request-banner']") as HTMLElement;
    const collapseBtn = screen.getByLabelText(i18n.t("helpRequest.collapse", { ns: "extension" }));

    fireEvent.pointerDown(collapseBtn, { button: 0, clientX: 10, clientY: 10, pointerId: 1 });

    expect(banner.getAttribute("data-dragging")).toBe("false");
    expect(banner.style.transform).not.toBe("none");
  });

  it("resets drag position when switching to a new request", () => {
    const el = document.createElement("div");
    el.id = "login";
    el.getBoundingClientRect = () =>
      ({ top: 100, left: 200, width: 120, height: 40, right: 320, bottom: 140 }) as DOMRect;
    el.scrollIntoView = vi.fn();
    document.body.append(el);

    const { rerender } = render(
      createElement(
        I18nextProvider,
        { i18n },
        createElement(HelpRequestOverlay, {
          request: baseRequest({ id: "a", selectors: ["#login"] }),
        }),
      ),
    );

    const banner = document.querySelector("[data-slot='help-request-banner']") as HTMLElement;
    const handle = banner.querySelector("[data-slot='help-drag-handle']") as HTMLElement;
    banner.getBoundingClientRect = () =>
      ({
        top: 152,
        left: 50,
        width: 420,
        height: 180,
        right: 470,
        bottom: 332,
      }) as DOMRect;
    Object.defineProperty(banner, "offsetWidth", { value: 420, configurable: true });
    Object.defineProperty(banner, "offsetHeight", { value: 180, configurable: true });

    fireEvent.pointerDown(handle, { button: 0, clientX: 210, clientY: 154, pointerId: 1 });
    fireEvent(window, new PointerEvent("pointermove", { clientX: 260, clientY: 184 }));
    fireEvent(window, new PointerEvent("pointerup", { pointerId: 1 }));
    expect(banner.style.transform).toBe("none");

    rerender(
      createElement(
        I18nextProvider,
        { i18n },
        createElement(HelpRequestOverlay, {
          request: baseRequest({ id: "b", selectors: ["#login"] }),
        }),
      ),
    );

    const bannerAfter = document.querySelector("[data-slot='help-request-banner']") as HTMLElement;
    expect(bannerAfter.style.transform).toBe("translateX(-50%)");

    el.remove();
  });

  it("renders a labelled drag handle affordance", () => {
    const { container } = renderOverlay(baseRequest());
    const handle = container.querySelector("[data-slot='help-drag-handle']") as HTMLElement;
    expect(handle).toBeTruthy();
    expect(handle.getAttribute("aria-label")).toBe(
      i18n.t("helpRequest.dragHandle", { ns: "extension" }),
    );
    expect(handle.querySelector(".bsk-help-drag-pill")).toBeTruthy();
  });

  it("moves the banner when dragging the drag handle", () => {
    const el = document.createElement("div");
    el.id = "login";
    el.getBoundingClientRect = () =>
      ({ top: 100, left: 200, width: 120, height: 40, right: 320, bottom: 140 }) as DOMRect;
    el.scrollIntoView = vi.fn();
    document.body.append(el);
    renderOverlay(baseRequest({ selectors: ["#login"] }));

    const banner = document.querySelector("[data-slot='help-request-banner']") as HTMLElement;
    const handle = banner.querySelector("[data-slot='help-drag-handle']") as HTMLElement;
    banner.getBoundingClientRect = () =>
      ({
        top: 152,
        left: 50,
        width: 420,
        height: 180,
        right: 470,
        bottom: 332,
      }) as DOMRect;
    Object.defineProperty(banner, "offsetWidth", { value: 420, configurable: true });
    Object.defineProperty(banner, "offsetHeight", { value: 180, configurable: true });

    fireEvent.pointerDown(handle, { button: 0, clientX: 260, clientY: 158, pointerId: 1 });
    expect(banner.getAttribute("data-dragging")).toBe("true");
    fireEvent(window, new PointerEvent("pointermove", { clientX: 310, clientY: 188 }));
    fireEvent(window, new PointerEvent("pointerup", { pointerId: 1 }));

    expect(banner.style.transform).toBe("none");
    expect(banner.style.top).toBe("182px");
    expect(banner.style.left).toBe("100px");

    el.remove();
  });

  it("keeps the horizontal anchor stable while collapsing", () => {
    const el = document.createElement("div");
    el.id = "login";
    el.getBoundingClientRect = () =>
      ({ top: 100, left: 200, width: 120, height: 40, right: 320, bottom: 140 }) as DOMRect;
    el.scrollIntoView = vi.fn();
    document.body.append(el);
    renderOverlay(baseRequest({ selectors: ["#login"] }));

    const banner = document.querySelector("[data-slot='help-request-banner']") as HTMLElement;
    const leftBefore = banner.style.left;
    const transformBefore = banner.style.transform;

    fireEvent.click(screen.getByLabelText(i18n.t("helpRequest.collapse", { ns: "extension" })));

    expect(banner.style.left).toBe(leftBefore);
    expect(banner.style.transform).toBe(transformBefore);
    expect(banner.style.transform).toBe("translateX(-50%)");

    el.remove();
  });
});
