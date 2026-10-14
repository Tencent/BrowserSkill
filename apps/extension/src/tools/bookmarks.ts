import type { SessionManager } from "@/session-manager/manager";
import type { BookmarksParams, BookmarksResult, RpcError } from "@/transport/types";
import { isRpcError, lookupSession } from "./shared";

type BookmarkMethod =
  | "tool.bookmarks_tree"
  | "tool.bookmarks_move"
  | "tool.bookmarks_create_folder"
  | "tool.bookmarks_remove_empty_folder";

interface BookmarksDeps {
  bookmarks: Pick<
    typeof chrome.bookmarks,
    "getTree" | "get" | "getChildren" | "move" | "create" | "remove"
  >;
  permissions: Pick<typeof chrome.permissions, "contains">;
}

/** One native operation per request. Never turn cancellation after a write into a failed write. */
export async function handleBookmarks(
  manager: SessionManager,
  method: BookmarkMethod,
  params: BookmarksParams,
  signal?: AbortSignal,
  deps?: BookmarksDeps,
): Promise<BookmarksResult | RpcError> {
  const ctx = lookupSession(manager, params, "bookmarks");
  if (isRpcError(ctx)) return ctx;
  if (ctx.remote)
    return { code: "unsupported", message: "Remote sessions cannot access profile bookmarks" };
  const allowed: string[] = {
    "tool.bookmarks_tree": [],
    "tool.bookmarks_move": ["id", "parent_id", "index"],
    "tool.bookmarks_create_folder": ["title", "parent_id", "index"],
    "tool.bookmarks_remove_empty_folder": ["id"],
  }[method];
  if (
    !allowed ||
    ["id", "parent_id", "index", "title"].some(
      (key) => params[key as keyof BookmarksParams] !== undefined && !allowed.includes(key),
    ) ||
    [params.id, params.parent_id].some(
      (id) => id !== undefined && (typeof id !== "string" || !id.trim()),
    ) ||
    (params.index !== undefined && (!Number.isSafeInteger(params.index) || params.index < 0)) ||
    (params.title !== undefined && typeof params.title !== "string") ||
    (allowed.includes("id") && !params.id) ||
    (allowed.includes("parent_id") && !params.parent_id) ||
    (allowed.includes("title") && params.title === undefined)
  )
    return { code: "invalid_params", message: "Invalid bookmark operation parameters" };

  const active = () => !signal?.aborted && manager.get(ctx.sessionId) === ctx;
  const cancelled: RpcError = {
    code: "cancelled",
    message: "Bookmark operation cancelled before dispatch",
  };
  try {
    const api = deps ?? { bookmarks: chrome.bookmarks, permissions: chrome.permissions };
    if (!active()) return cancelled;
    if (!(await api.permissions.contains({ permissions: ["bookmarks"] }))) {
      return {
        code: "permission_denied",
        message: "Enable bookmark access in the BrowserSkill extension settings for this profile",
      };
    }
    if (!active()) return cancelled;
    if (method === "tool.bookmarks_tree") return { nodes: await api.bookmarks.getTree() };

    if (params.parent_id !== undefined) {
      const [parent] = await api.bookmarks.get(params.parent_id);
      if (!parent || parent.id === "0" || parent.url !== undefined || parent.unmodifiable) {
        return {
          code: "invalid_params",
          message: "Destination must be a writable bookmark folder",
        };
      }
    }
    if (params.id !== undefined) {
      const [node] = await api.bookmarks.get(params.id);
      if (!node) return { code: "not_found", message: "Bookmark node not found" };
      if (!node.parentId || node.parentId === "0" || node.unmodifiable) {
        return {
          code: "permission_denied",
          message: "Cannot modify a root or managed bookmark node",
        };
      }
      if (method === "tool.bookmarks_remove_empty_folder") {
        if (node.url !== undefined || (await api.bookmarks.getChildren(node.id)).length > 0) {
          return {
            code: "invalid_params",
            message: "Only an empty bookmark folder can be removed",
          };
        }
      }
    }
    if (!active()) return cancelled;
    switch (method) {
      case "tool.bookmarks_move":
        return {
          nodes: [
            await api.bookmarks.move(params.id!, {
              parentId: params.parent_id!,
              index: params.index,
            }),
          ],
        };
      case "tool.bookmarks_create_folder":
        return {
          nodes: [
            await api.bookmarks.create({
              parentId: params.parent_id!,
              title: params.title!,
              index: params.index,
            }),
          ],
        };
      case "tool.bookmarks_remove_empty_folder":
        // Chrome remove() also rejects a folder that became nonempty after the check.
        await api.bookmarks.remove(params.id!);
        return { nodes: [], removed_id: params.id };
    }
  } catch (error) {
    return {
      code: "protocol_error",
      message: `Bookmark API failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
