import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_WINDOW_HOME, chromeAgentWindowApi } from "../agent-window";

describe("chromeAgentWindowApi.ensureActiveTab", () => {
  const query = vi.fn();
  const update = vi.fn();
  const create = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("chrome", {
      tabs: { query, update, create },
    });
    query.mockReset();
    update.mockReset();
    create.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("activates an existing tab when the window already has one", async () => {
    query.mockResolvedValue([{ id: 7, active: false }]);
    update.mockResolvedValue({});

    await chromeAgentWindowApi.ensureActiveTab(100, AGENT_WINDOW_HOME, new Set([7]));

    expect(query).toHaveBeenCalledWith({ windowId: 100 });
    expect(update).toHaveBeenCalledWith(7, { active: true });
    expect(create).not.toHaveBeenCalled();
  });

  it("creates about:blank when the Agent Window has no tabs", async () => {
    query.mockResolvedValue([]);
    create.mockResolvedValue({ id: 8 });

    await chromeAgentWindowApi.ensureActiveTab(100, AGENT_WINDOW_HOME, new Set());

    expect(create).toHaveBeenCalledWith({
      windowId: 100,
      url: AGENT_WINDOW_HOME,
      active: true,
    });
    expect(update).not.toHaveBeenCalled();
  });

  it("creates its own home tab instead of adopting a tab opened by the user", async () => {
    query.mockResolvedValue([{ id: 99, active: true }]);
    create.mockResolvedValue({ id: 8 });
    const home = await chromeAgentWindowApi.ensureActiveTab(100, AGENT_WINDOW_HOME, new Set([7]));
    expect(home).toBe(8);
    expect(update).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledWith({ windowId: 100, url: AGENT_WINDOW_HOME, active: true });
  });
});

describe("chromeAgentWindowApi.create", () => {
  const create = vi.fn();
  const isAllowedIncognitoAccess = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("chrome", {
      windows: { create },
      extension: { isAllowedIncognitoAccess },
    });
    create.mockReset();
    create.mockResolvedValue({ id: 100 });
    isAllowedIncognitoAccess.mockReset().mockResolvedValue(false);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns initial tab identities from the creation result", async () => {
    create.mockResolvedValue({ id: 100, tabs: [{ id: 7 }, { id: 8 }] });
    expect(await chromeAgentWindowApi.create(AGENT_WINDOW_HOME)).toEqual({
      windowId: 100,
      initialTabIds: [7, 8],
    });
  });

  it("opens Agent Windows in the background by default", async () => {
    await chromeAgentWindowApi.create(AGENT_WINDOW_HOME);

    expect(create).toHaveBeenCalledWith({
      type: "normal",
      focused: false,
      incognito: false,
      url: AGENT_WINDOW_HOME,
    });
    expect(isAllowedIncognitoAccess).not.toHaveBeenCalled();
  });

  it("can explicitly bring an Agent Window to the foreground", async () => {
    await chromeAgentWindowApi.create(AGENT_WINDOW_HOME, { focused: true });

    expect(create).toHaveBeenCalledWith({
      type: "normal",
      focused: true,
      incognito: false,
      url: AGENT_WINDOW_HOME,
    });
  });

  it("passes an optional window size through the options object", async () => {
    await chromeAgentWindowApi.create(AGENT_WINDOW_HOME, {
      size: { width: 1280, height: 800 },
    });

    expect(create).toHaveBeenCalledWith({
      type: "normal",
      focused: false,
      incognito: false,
      url: AGENT_WINDOW_HOME,
      width: 1280,
      height: 800,
    });
  });

  it("checks permission before opening an incognito window", async () => {
    isAllowedIncognitoAccess.mockResolvedValue(true);
    create.mockResolvedValue({ id: 100, incognito: true, tabs: [{ id: 7 }] });
    expect(await chromeAgentWindowApi.create(AGENT_WINDOW_HOME, { incognito: true })).toEqual({
      windowId: 100,
      initialTabIds: [7],
      incognito: true,
    });
    expect(create).toHaveBeenCalledWith({
      type: "normal",
      focused: false,
      incognito: true,
      url: AGENT_WINDOW_HOME,
    });
  });

  it("explains missing incognito permission without creating a window", async () => {
    await expect(
      chromeAgentWindowApi.create(AGENT_WINDOW_HOME, { incognito: true }),
    ).rejects.toThrow(/chrome:\/\/extensions.*Allow in incognito/);
    expect(create).not.toHaveBeenCalled();
  });

  it("propagates a browser refusal without retrying in normal mode", async () => {
    isAllowedIncognitoAccess.mockResolvedValue(true);
    create.mockRejectedValue(new Error("Incognito mode is disabled by policy"));
    await expect(
      chromeAgentWindowApi.create(AGENT_WINDOW_HOME, { incognito: true }),
    ).rejects.toThrow("Incognito mode is disabled by policy");
    expect(create).toHaveBeenCalledTimes(1);
  });
});
