import { describe, expect, it, vi } from "vitest";
import type { SessionManager } from "@/session-manager/manager";
import { handleBookmarks } from "../bookmarks";

function setup() {
  const ctx = { sessionId: "s", remote: false };
  const manager = { get: vi.fn(() => ctx) } as unknown as SessionManager;
  const deps = {
    permissions: { contains: vi.fn().mockResolvedValue(true) },
    bookmarks: {
      getTree: vi.fn().mockResolvedValue([{ id: "0", title: "", children: [] }]),
      get: vi
        .fn()
        .mockImplementation(async (id: string) => [{ id, title: "folder", parentId: "1" }]),
      getChildren: vi.fn().mockResolvedValue([]),
      move: vi
        .fn()
        .mockResolvedValue({ id: "2", title: "link", parentId: "3", url: "https://example.com" }),
      create: vi.fn().mockResolvedValue({ id: "4", title: "folder", parentId: "1" }),
      remove: vi.fn().mockResolvedValue(undefined),
    },
  };
  return { ctx, manager, deps };
}

describe("profile bookmarks", () => {
  it("requires a local session and explicit permission before reading", async () => {
    const { ctx, manager, deps } = setup();
    ctx.remote = true;
    expect(
      await handleBookmarks(manager, "tool.bookmarks_tree", { session_id: "s" }, undefined, deps),
    ).toMatchObject({ code: "unsupported" });
    expect(deps.permissions.contains).not.toHaveBeenCalled();
    ctx.remote = false;
    deps.permissions.contains.mockResolvedValue(false);
    expect(
      await handleBookmarks(manager, "tool.bookmarks_tree", { session_id: "s" }, undefined, deps),
    ).toMatchObject({ code: "permission_denied" });
    expect(deps.bookmarks.getTree).not.toHaveBeenCalled();
  });

  it("reads the native tree and moves without recreating a bookmark", async () => {
    const { manager, deps } = setup();
    expect(
      await handleBookmarks(manager, "tool.bookmarks_tree", { session_id: "s" }, undefined, deps),
    ).toMatchObject({ nodes: [{ id: "0" }] });
    expect(
      await handleBookmarks(
        manager,
        "tool.bookmarks_move",
        { session_id: "s", id: "2", parent_id: "3", index: 0 },
        undefined,
        deps,
      ),
    ).toMatchObject({ nodes: [{ id: "2", url: "https://example.com" }] });
    expect(deps.bookmarks.move).toHaveBeenCalledWith("2", { parentId: "3", index: 0 });
    expect(deps.bookmarks.create).not.toHaveBeenCalled();
  });

  it.each([
    { id: "2", title: "root", parentId: "0" },
    { id: "2", title: "managed", parentId: "1", unmodifiable: "managed" },
    { id: "2", title: "link", parentId: "1", url: "https://example.com" },
  ])("refuses removal of protected nodes and URL bookmarks: $title", async (node) => {
    const { manager, deps } = setup();
    deps.bookmarks.get.mockResolvedValue([node]);
    expect(
      await handleBookmarks(
        manager,
        "tool.bookmarks_remove_empty_folder",
        { session_id: "s", id: "2" },
        undefined,
        deps,
      ),
    ).toHaveProperty("code");
    expect(deps.bookmarks.remove).not.toHaveBeenCalled();
  });

  it("removes only an empty folder and reports native failures", async () => {
    const { manager, deps } = setup();
    deps.bookmarks.getChildren.mockResolvedValue([{ id: "5" }]);
    expect(
      await handleBookmarks(
        manager,
        "tool.bookmarks_remove_empty_folder",
        { session_id: "s", id: "2" },
        undefined,
        deps,
      ),
    ).toMatchObject({ code: "invalid_params" });
    expect(deps.bookmarks.remove).not.toHaveBeenCalled();
    deps.bookmarks.getChildren.mockResolvedValue([]);
    expect(
      await handleBookmarks(
        manager,
        "tool.bookmarks_remove_empty_folder",
        { session_id: "s", id: "2" },
        undefined,
        deps,
      ),
    ).toEqual({ nodes: [], removed_id: "2" });
    deps.bookmarks.remove.mockRejectedValue(new Error("folder became nonempty"));
    expect(
      await handleBookmarks(
        manager,
        "tool.bookmarks_remove_empty_folder",
        { session_id: "s", id: "2" },
        undefined,
        deps,
      ),
    ).toMatchObject({ code: "protocol_error" });
  });

  it("cancels before dispatch and preserves a completed write after cancellation", async () => {
    const { manager, deps } = setup();
    const controller = new AbortController();
    deps.permissions.contains.mockImplementation(async () => {
      controller.abort();
      return true;
    });
    const params = { session_id: "s", id: "2", parent_id: "3" };
    expect(
      await handleBookmarks(manager, "tool.bookmarks_move", params, controller.signal, deps),
    ).toMatchObject({ code: "cancelled" });
    expect(deps.bookmarks.move).not.toHaveBeenCalled();
    const later = new AbortController();
    deps.permissions.contains.mockResolvedValue(true);
    deps.bookmarks.move.mockImplementation(async () => {
      later.abort();
      return { id: "2", title: "link", parentId: "3" };
    });
    expect(
      await handleBookmarks(manager, "tool.bookmarks_move", params, later.signal, deps),
    ).toMatchObject({ nodes: [{ id: "2" }] });
  });

  it("validates fields before dispatch and creates folders without a URL", async () => {
    const { manager, deps } = setup();
    expect(
      await handleBookmarks(
        manager,
        "tool.bookmarks_move",
        { session_id: "s", id: "2", parent_id: "3", index: -1 },
        undefined,
        deps,
      ),
    ).toMatchObject({ code: "invalid_params" });
    expect(
      await handleBookmarks(
        manager,
        "tool.bookmarks_tree",
        { session_id: "s", title: "unused" },
        undefined,
        deps,
      ),
    ).toMatchObject({ code: "invalid_params" });
    expect(deps.permissions.contains).not.toHaveBeenCalled();
    await handleBookmarks(
      manager,
      "tool.bookmarks_create_folder",
      { session_id: "s", parent_id: "1", title: "folder" },
      undefined,
      deps,
    );
    expect(deps.bookmarks.create).toHaveBeenCalledWith({
      parentId: "1",
      title: "folder",
      index: undefined,
    });
  });
});
