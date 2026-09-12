import { describe, expect, it, vi } from "vitest";
import { isHoverSurfaceCandidateElement, isLikelyHoverSurfaceOwner } from "../record-hover-surface";

function mockRect(
  el: Element,
  rect: { left: number; top: number; width: number; height: number },
): void {
  vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
    x: rect.left,
    y: rect.top,
    top: rect.top,
    left: rect.left,
    right: rect.left + rect.width,
    bottom: rect.top + rect.height,
    width: rect.width,
    height: rect.height,
    toJSON: () => ({}),
  });
}

describe("record-hover-surface", () => {
  it("recognizes popover containers without treating topbar wrappers or menu items as surfaces", () => {
    document.body.innerHTML = `
      <ul class="header-menu tw-flex navbar-app__authentication-menu">
        <li class="tg-popover">
          <div class="tg-avatar tg-avatar--img"></div>
        </li>
      </ul>
      <div class="tg-popover__popper">
        <div class="tg-popover__content">
          <div class="tg-popover__content-body">
            <li class="header-menu__item">
              <a class="header-dropdown-menu__link" href="/u/me">My profile</a>
            </li>
            <li class="header-menu__item">
              <a class="header-dropdown-menu__link" href="/dashboard/groups">My groups</a>
            </li>
          </div>
        </div>
      </div>
    `;

    expect(isHoverSurfaceCandidateElement(document.querySelector(".header-menu")!)).toBe(false);
    expect(isHoverSurfaceCandidateElement(document.querySelector(".tg-popover")!)).toBe(false);
    expect(isHoverSurfaceCandidateElement(document.querySelector(".header-menu__item")!)).toBe(
      false,
    );
    expect(
      isHoverSurfaceCandidateElement(document.querySelector(".header-dropdown-menu__link")!),
    ).toBe(false);
    expect(isHoverSurfaceCandidateElement(document.querySelector(".tg-popover__popper")!)).toBe(
      true,
    );
    expect(isHoverSurfaceCandidateElement(document.querySelector(".tg-popover__content")!)).toBe(
      true,
    );
    expect(
      isHoverSurfaceCandidateElement(document.querySelector(".tg-popover__content-body")!),
    ).toBe(true);
  });

  it("does not treat elements covered by an open surface as the surface owner", () => {
    document.body.innerHTML = `
      <button class="avatar">image</button>
      <a class="fork" href="/fork">Fork</a>
      <button class="clone">Clone & Download</button>
      <div class="tg-popover__content-body"></div>
    `;
    const avatar = document.querySelector(".avatar")!;
    const fork = document.querySelector(".fork")!;
    const clone = document.querySelector(".clone")!;
    const surface = document.querySelector(".tg-popover__content-body")!;
    mockRect(avatar, { left: 1340, top: 11, width: 26, height: 26 });
    mockRect(fork, { left: 1275, top: 56, width: 69, height: 28 });
    mockRect(clone, { left: 1159, top: 111, width: 180, height: 30 });
    mockRect(surface, { left: 1111, top: 44, width: 240, height: 496 });

    expect(isLikelyHoverSurfaceOwner(avatar, surface)).toBe(true);
    expect(isLikelyHoverSurfaceOwner(fork, surface)).toBe(false);
    expect(isLikelyHoverSurfaceOwner(clone, surface)).toBe(false);
  });

  it("does not treat fixed navigation containers as plain floating surfaces", () => {
    document.body.innerHTML = `
      <header class="navbar-app">
        <a href="/fork">Fork</a>
        <button>image</button>
      </header>
      <div class="plain-floating"></div>
    `;
    const navbar = document.querySelector(".navbar-app")!;
    const floating = document.querySelector(".plain-floating")!;
    mockRect(navbar, { left: 0, top: 0, width: 1386, height: 51 });
    mockRect(floating, { left: 1111, top: 44, width: 240, height: 496 });
    vi.spyOn(window, "getComputedStyle").mockImplementation((el) => {
      const style = {
        cursor: "",
        display: "block",
        pointerEvents: "auto",
        position: el === navbar ? "fixed" : "absolute",
        visibility: "visible",
      } as CSSStyleDeclaration;
      return style;
    });

    expect(isHoverSurfaceCandidateElement(navbar)).toBe(false);
    expect(isHoverSurfaceCandidateElement(floating)).toBe(true);
  });
});
