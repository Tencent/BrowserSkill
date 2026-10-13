# Profile bookmarks

## Applicability

Use a local browser session. Select the required Chrome profile before starting
the session. Bookmark IDs belong to that profile. Remote sessions are unsupported.

In the extension settings, turn on **Bookmark access**. Chrome requests the
optional `bookmarks` permission. This permission covers all bookmarks in the
profile. It is off by default. Turn it off to revoke access.

## Operations

```sh
bsk bookmarks --session <session_id> tree --json
bsk bookmarks --session <session_id> move <node_id> --parent <folder_id> --index 0 --json
bsk bookmarks --session <session_id> create-folder "Folder title" --parent <folder_id> --json
bsk bookmarks --session <session_id> remove-empty-folder <folder_id> --json
```

`tree` returns the native tree under `nodes`. Keep its parent IDs, indexes,
titles, URLs, and metadata when saving a backup. `move` preserves the node ID.
`create-folder` cannot create a URL bookmark. `remove-empty-folder` refuses URL
bookmarks, nonempty folders, root folders, and managed nodes. No command removes
a folder recursively.

Results are JSON in both output modes. A mutation returns its resulting node,
or `removed_id` after an empty folder is removed. Native errors remain errors.
The existing session queue and user-interrupt handling apply to writes. Reads
remain available after a user interrupt.

## Flatten a bookmark bar

1. Read the tree. Confirm the profile and bookmark bar. Do not assume a root ID.
2. Save the tree to a new backup file before the first write.
3. For each top-level folder, move bookmarks from its descendant folders into
   that top-level folder. Preserve the requested order.
4. Remove the descendant folders only after they are empty. Work from the
   deepest folder to the shallowest folder.
5. Read the tree again. Check bookmark IDs, titles, URLs, order, and folder depth.
   Confirm that nodes outside the requested scope are unchanged.

Each API call is one operation. The sequence is not a transaction. On a lost
reply or cancellation, read the tree before retrying a write. A completed write
remains completed if cancellation arrives after dispatch.

To restore folder structure, recreate any removed empty folders, then move
bookmarks to the saved parents and indexes. Recreated folders have new IDs;
update the parent mapping. Do not claim that restoration succeeded until the
tree has been checked.
