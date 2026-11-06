import type { RawRead, ReadOptions } from "./types";

/** Trusted source, synchronous in an isolated world. Caller data is only CDP
 * arguments. No eval, property paths, callbacks, promises, input, timers or I/O.
 * Page-world getters/prototype overrides cannot turn these native DOM reads
 * into arbitrary code. The DOM may change before or after this one task. */
export function collectDomRead(this: Element, options: ReadOptions): RawRead {
  const result: RawRead = {
    frame_url: document.URL,
    title: document.title,
    captured_at: new Date().toISOString(),
    items: [],
    truncated: false,
  };
  const started = performance.now();
  let bytes = 0;
  const fail = (reason: NonNullable<RawRead["error"]>["reason"], message: string): never => {
    throw { reason, message };
  };
  const select = (root: ParentNode, selector: string) => {
    try {
      return root.querySelectorAll(selector);
    } catch {
      return fail("read_selector_invalid", `Invalid CSS selector: ${selector}`);
    }
  };
  try {
    if (this instanceof Element && (!this.isConnected || this.ownerDocument !== document))
      fail("read_target_stale", "The read target was detached or moved to another document");
    const nodes = options.selector
      ? select(document, options.selector)
      : [this instanceof Element ? this : document.documentElement];
    for (const node of nodes) {
      if (result.items.length === options.max_nodes) {
        result.truncated = true;
        break;
      }
      if (performance.now() - started > options.timeout_ms)
        fail("read_limit", "DOM read deadline exceeded");
      const values: Record<string, string | boolean | null> = Object.create(null);
      const redacted: string[] = [];
      for (const field of options.fields) {
        const matches =
          !field.selector || field.selector === ":scope" ? [node] : select(node, field.selector);
        if (matches.length > 1)
          fail("read_field_ambiguous", `Field ${field.key} matches multiple descendants`);
        const element = matches[0];
        let value: string | boolean | null = null;
        if (field.read === "exists") value = !!element;
        else if (element) {
          // Mask the entire text field if its subtree includes sensitive data.
          // Attribute access on sensitive controls is also closed, not just value.
          const sensitive =
            element.matches(options.sensitive) ||
            (field.read === "text" && !!element.querySelector(options.sensitive));
          if (
            sensitive ||
            element.closest(
              "script,style,template,noscript,[data-bsk-overlay],[data-bsk-overlay-host],browser-skill-overlay",
            )
          )
            redacted.push(field.key);
          else if (field.read === "text") value = element.textContent;
          else if (field.read === "attribute") value = element.getAttribute(field.attribute!);
          else if (field.read === "checked")
            value = element instanceof HTMLInputElement ? element.checked : null;
          else if (
            element instanceof HTMLInputElement ||
            element instanceof HTMLTextAreaElement ||
            element instanceof HTMLSelectElement
          )
            value = element.value;
        }
        if (typeof value === "string") {
          // Bound allocation before UTF-8 encoding.
          if (value.length > options.max_bytes - bytes)
            fail("read_limit", "DOM read byte limit exceeded");
          bytes += new TextEncoder().encode(value).length;
          if (bytes > options.max_bytes) fail("read_limit", "DOM read byte limit exceeded");
        }
        values[field.key] = value;
      }
      result.items.push({ node: node as unknown as { backendNodeId: number }, values, redacted });
    }
  } catch (error) {
    const issue = error as RawRead["error"];
    result.items = [];
    result.error = issue?.reason ? issue : { reason: "read_limit", message: "DOM read failed" };
  }
  return result;
}
