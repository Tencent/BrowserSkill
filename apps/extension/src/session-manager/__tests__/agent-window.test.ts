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

    await chromeAgentWindowApi.ensureActiveTab(100, AGENT_WINDOW_HOME);

    expect(query).toHaveBeenCalledWith({ windowId: 100 });
    expect(update).toHaveBeenCalledWith(7, { active: true });
    expect(create).not.toHaveBeenCalled();
  });

  it("creates about:blank when the Agent Window has no tabs", async () => {
    query.mockResolvedValue([]);
    create.mockResolvedValue({ id: 8 });

    await chromeAgentWindowApi.ensureActiveTab(100, AGENT_WINDOW_HOME);

    expect(create).toHaveBeenCalledWith({
      windowId: 100,
      url: AGENT_WINDOW_HOME,
      active: true,
    });
    expect(update).not.toHaveBeenCalled();
  });
});

describe("chromeAgentWindowApi.create", () => {
  const create = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("chrome", {
      windows: { create },
    });
    create.mockReset();
    create.mockResolvedValue({ id: 100 });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("focuses Agent Windows by default", async () => {
    await chromeAgentWindowApi.create(AGENT_WINDOW_HOME);

    expect(create).toHaveBeenCalledWith({
      type: "normal",
      focused: true,
      url: AGENT_WINDOW_HOME,
    });
  });

  it("can create an Agent Window without stealing focus", async () => {
    await chromeAgentWindowApi.create(AGENT_WINDOW_HOME, { focused: false });

    expect(create).toHaveBeenCalledWith({
      type: "normal",
      focused: false,
      url: AGENT_WINDOW_HOME,
    });
  });

  it("passes an optional window size through the options object", async () => {
    await chromeAgentWindowApi.create(AGENT_WINDOW_HOME, {
      size: { width: 1280, height: 800 },
    });

    expect(create).toHaveBeenCalledWith({
      type: "normal",
      focused: true,
      url: AGENT_WINDOW_HOME,
      width: 1280,
      height: 800,
    });
  });
});
