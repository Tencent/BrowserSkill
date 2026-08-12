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
