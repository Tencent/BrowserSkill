import type { CollectorOptions, RawCapture, RawCell, RawRow, RawTarget } from "./types";

/**
 * Runs in an isolated renderer world. Keep all runtime helpers inside this
 * function: its source is sent to CDP, without caller-provided JavaScript.
 * It never dispatches input, scrolls, fetches, or changes the page DOM.
 */
export function collectExtractDom(this: Element, options: CollectorOptions): RawCapture {
  const result: RawCapture = {
    frame_url: document.URL,
    title: document.title,
    captured_at: new Date().toISOString(),
    rows: [],
    items: [],
    item_sources: [],
    targets: [],
    truncated: false,
    warnings: [],
    omitted_rows: [],
  };
  const started = performance.now();
  let work = 0;
  let textBytes = 0;
  const encoder = new TextEncoder();
  const tableSelector = 'table,[role="table"],[role="grid"],[role="treegrid"]';
  const listSelector = 'ul,ol,[role="list"]';
  const hidden = new WeakMap<Element, boolean>();
  const styles = new WeakMap<Element, CSSStyleDeclaration>();
  const styleOf = (element: Element) => {
    let style = styles.get(element);
    if (!style) {
      style = getComputedStyle(element);
      styles.set(element, style);
    }
    return style;
  };
  const fail = (reason: string, message: string): never => {
    throw new Error(`${reason}: ${message}`);
  };
  const consume = (value: string) => {
    // Bound allocation before UTF-8 encoding a page-controlled string.
    if (value.length > options.max_bytes - textBytes)
      fail("extract_limit", "Text byte budget exceeded");
    textBytes += encoder.encode(value).length;
    if (textBytes > options.max_bytes) fail("extract_limit", "Text byte budget exceeded");
  };
  const tick = () => {
    if (++work > 100_000) fail("extract_limit", "DOM traversal budget exceeded");
    if (work % 64 === 0 && performance.now() - started > options.timeout_ms)
      fail("extract_limit", "DOM collection deadline exceeded");
  };
  const isHidden = (node: Element): boolean => {
    const cached = hidden.get(node);
    if (cached !== undefined) return cached;
    const chain: Element[] = [];
    let current: Element | null = node;
    let value = false;
    while (current) {
      tick();
      const known = hidden.get(current);
      if (known !== undefined) {
        value = known;
        break;
      }
      chain.push(current);
      const style = styleOf(current);
      if (
        current.hasAttribute("hidden") ||
        current.hasAttribute("data-bsk-overlay") ||
        current.hasAttribute("data-bsk-overlay-host") ||
        current.tagName.toLowerCase() === "browser-skill-overlay" ||
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.visibility === "collapse" ||
        style.opacity === "0"
      ) {
        value = true;
        break;
      }
      current =
        current.assignedSlot ??
        current.parentElement ??
        ((current.getRootNode() as ShadowRoot).host || null);
    }
    for (const item of chain) hidden.set(item, value);
    return value;
  };
  const childrenOf = (element: Element): ArrayLike<Node> => {
    if (element instanceof HTMLSlotElement) return element.assignedNodes({ flatten: true });
    return element.shadowRoot?.childNodes ?? element.childNodes;
  };
  const text = (root: Element): string => {
    if (isHidden(root)) return "";
    const pieces: string[] = [];
    let pendingSpace = false;
    let pendingBreak = false;
    let lineStart = true;
    const emit = (value: string) => {
      if (!value) return;
      if (pendingBreak && !lineStart) pieces.push("\n");
      else if (pendingSpace && !lineStart && !value.startsWith("\n")) pieces.push(" ");
      pendingSpace = false;
      pendingBreak = false;
      pieces.push(value);
      lineStart = value.endsWith("\n");
    };
    const newline = () => {
      pieces.push("\n");
      pendingBreak = false;
      pendingSpace = false;
      lineStart = true;
    };
    const append = (value: string, whiteSpace: string) => {
      consume(value);
      if (["pre", "pre-wrap", "break-spaces"].includes(whiteSpace)) {
        emit(value.replace(/\r\n?/g, "\n"));
        return;
      }
      const lines = whiteSpace === "pre-line" ? value.replace(/\r\n?/g, "\n").split("\n") : [value];
      for (const [index, line] of lines.entries()) {
        if (index) newline();
        const collapsed = line.replace(/[ \t\r\n\f]+/g, " ");
        if (collapsed.startsWith(" ")) pendingSpace = true;
        emit(collapsed.replace(/^ +| +$/g, ""));
        if (collapsed.endsWith(" ")) pendingSpace = true;
      }
    };
    type TextVisit = { node: Node; whiteSpace: string; exit?: boolean };
    const stack: TextVisit[] = [{ node: root, whiteSpace: styleOf(root).whiteSpace }];
    while (stack.length) {
      const { node, whiteSpace, exit } = stack.pop()!;
      if (node !== root) tick();
      if (exit) {
        pendingBreak = true;
        pendingSpace = false;
        continue;
      }
      if (node.nodeType === Node.TEXT_NODE) {
        append(node.nodeValue ?? "", whiteSpace);
        continue;
      }
      if (!(node instanceof Element)) continue;
      if (
        isHidden(node) ||
        node.matches(
          'script,style,template,noscript,input[type="password"],input[type="hidden"]',
        ) ||
        (node !== root && node.matches(tableSelector))
      )
        continue;
      if (node.tagName === "BR") {
        newline();
        continue;
      }
      const style = styleOf(node);
      const block =
        node !== root &&
        /^(block|flow-root|list-item|flex|grid|table|table-row|table-caption)( |$)/.test(
          style.display,
        );
      if (block) {
        pendingBreak = true;
        pendingSpace = false;
        stack.push({ node, whiteSpace, exit: true });
      }
      if (node instanceof HTMLInputElement) {
        if (!["checkbox", "radio", "file", "image"].includes(node.type))
          append(node.value, "pre-wrap");
        continue;
      }
      if (node instanceof HTMLTextAreaElement) {
        append(node.value, "pre-wrap");
        continue;
      }
      if (node instanceof HTMLSelectElement) {
        for (const [index, option] of Array.from(node.selectedOptions).entries()) {
          tick();
          if (index) newline();
          append(option.label, "normal");
        }
        continue;
      }
      const children = childrenOf(node);
      for (let index = children.length - 1; index >= 0; index--)
        stack.push({ node: children[index], whiteSpace: style.whiteSpace });
    }
    return pieces.join("");
  };
  const ariaSpan = (cell: Element, name: string, allowZero = false) => {
    const value = cell.getAttribute(name);
    if (value === null) return 1;
    const number = Number(value);
    if (/^\d+$/.test(value) && Number.isSafeInteger(number) && number >= (allowZero ? 0 : 1))
      return number;
    result.warnings.push(`invalid_${name}`);
    return 1;
  };
  const positions = new WeakMap<Element, number>();
  const siblings = new WeakMap<ParentNode, { last: Element | null; counts: Map<string, number> }>();
  const positionOf = (node: Element): number => {
    const known = positions.get(node);
    if (known !== undefined) return known;
    const parent = node.parentNode as ParentNode | null;
    if (!parent) return 1;
    let scan = siblings.get(parent);
    if (!scan) {
      scan = { last: null, counts: new Map() };
      siblings.set(parent, scan);
    }
    // Scan each parent's prefix once, without visiting an unneeded suffix.
    for (
      let child = scan.last ? scan.last.nextElementSibling : parent.firstElementChild;
      child;
      child = child.nextElementSibling
    ) {
      tick();
      const count = (scan.counts.get(child.tagName) ?? 0) + 1;
      scan.counts.set(child.tagName, count);
      positions.set(child, count);
      scan.last = child;
      if (child === node) return count;
    }
    return fail("extract_target_stale", "The row is no longer attached to its parent");
  };
  const select = (root: ParentNode, selector: string): NodeListOf<Element> => {
    try {
      return root.querySelectorAll(selector);
    } catch {
      return fail("extract_selector_invalid", `Invalid CSS selector: ${selector}`);
    }
  };
  const integer = (value: string | null, fallback: number, allowZero = false): number => {
    if (value === null) return fallback;
    if (!/^\d+$/.test(value))
      return fail("extract_structure_invalid", "Invalid row/column index or span");
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < (allowZero ? 0 : 1))
      return fail("extract_structure_invalid", "Invalid row/column index or span");
    return number;
  };
  const locator = (element: Element): string => {
    const segments: string[] = [];
    let node: Element | null = element;
    for (let depth = 0; node && depth < 32; depth++) {
      tick();
      if (node.id) {
        if (node.id.length > 2048) fail("extract_limit", "Locator ID exceeds metadata budget");
        segments.unshift(`#${CSS.escape(node.id)}`);
        break;
      }
      const position = positionOf(node);
      segments.unshift(`${node.tagName.toLowerCase()}:nth-of-type(${position})`);
      if (!node.parentElement && (node.getRootNode() as ShadowRoot).host) {
        segments.unshift("::shadow");
        node = (node.getRootNode() as ShadowRoot).host;
      } else node = node.parentElement;
    }
    return segments.join(" > ");
  };
  const stop = (reason: string) => {
    result.truncated = true;
    result.stop_reason = reason;
  };
  const isLimit = (error: unknown): error is Error =>
    error instanceof Error && error.message.startsWith("extract_limit:");
  const limitReason = (error: Error, fallback: string) =>
    error.message.includes("deadline") ? "time_limit" : fallback;
  const omit = (element: Element, fallback: number, attribute: string) => {
    const value = element.getAttribute(attribute);
    const index = value === null ? fallback : Number(value);
    if (Number.isSafeInteger(index) && index > 0) result.omitted_rows!.push(index);
    result.warnings.push("hidden_rows_omitted");
  };
  try {
    if (options.anchored && (!this.isConnected || this.ownerDocument !== document))
      fail("extract_target_stale", "The extraction target no longer belongs to this document");
    let root = options.anchored ? this : document.documentElement;
    if (options.selector) {
      const matches = select(document, options.selector);
      if (matches.length === 0)
        fail("selector_not_found", "No extraction target matches the selector");
      if (matches.length !== 1)
        fail("extract_target_ambiguous", "The selector must match exactly one container");
      root = matches[0];
    }
    if (options.action === "discover") {
      const stack: Element[] = [root];
      const tables: RawTarget[] = [];
      const lists: RawTarget[] = [];
      let found = 0;
      try {
        while (stack.length) {
          tick();
          const element = stack.pop()!;
          if (isHidden(element)) continue;
          if (
            element.matches(`${tableSelector},${listSelector}`) &&
            !["presentation", "none"].includes(element.getAttribute("role") ?? "")
          ) {
            found++;
            const candidates = element.matches(tableSelector) ? tables : lists;
            if (tables.length === 32) {
              stop("target_limit");
              break;
            }
            if (candidates.length < 32) {
              const columns: string[] = [];
              for (const header of select(element, 'th,[role="columnheader"]')) {
                if (columns.length >= 8) break;
                if (header.closest(tableSelector) === element && !isHidden(header))
                  columns.push(text(header));
              }
              const caption = element instanceof HTMLTableElement ? element.caption : null;
              const label =
                element.getAttribute("aria-label") ||
                (caption ? text(caption) : "") ||
                element.id ||
                element.tagName.toLowerCase();
              candidates.push({
                kind: element.matches(tableSelector) ? "table" : "list",
                name: label.slice(0, 500),
                columns,
                node: element as unknown as { backendNodeId: number },
              });
            }
          }
          const children = childrenOf(element);
          for (let index = children.length - 1; index >= 0; index--)
            if (children[index] instanceof Element) stack.push(children[index] as Element);
        }
      } catch (error) {
        if (!isLimit(error)) throw error;
        stop(limitReason(error, "traversal_limit"));
      }
      result.targets = [...tables, ...lists].slice(0, 32);
      if (!result.truncated && found > 32) stop("target_limit");
      return result;
    }
    if (!options.anchored && !options.selector) {
      const matches = select(root, options.action === "table" ? tableSelector : listSelector);
      let selected: Element | undefined;
      for (const node of matches) {
        tick();
        if (isHidden(node)) continue;
        if (selected)
          fail("extract_target_ambiguous", "Multiple containers found; use discover or a selector");
        selected = node;
      }
      if (!selected) fail("selector_not_found", "No extractable container found");
      root = selected!;
    }
    if (isHidden(root)) fail("extract_target_hidden", "The extraction container is hidden");
    for (const [attribute, field] of [
      ["aria-rowcount", "declared_rows"],
      ["aria-colcount", "declared_columns"],
    ] as const) {
      const value = root.getAttribute(attribute);
      if (value !== null) {
        const count = Number(value);
        if (Number.isSafeInteger(count) && (count === -1 || count >= 0)) result[field] = count;
        else result.warnings.push(`invalid_${attribute}`);
      }
    }
    if (options.action === "list") {
      const fields = options.fields ?? [
        { key: "text", name: "Text", selector: ":scope", read: "text" },
        { key: "url", name: "URL", selector: "a[href]", read: "href" },
      ];
      const nodes = options.item_selector
        ? select(root, options.item_selector)
        : select(root, 'li,[role="listitem"]');
      let sourceRow = 0;
      for (const item of nodes) {
        try {
          tick();
          if (!options.item_selector && item.closest(listSelector) !== root) continue;
          sourceRow++;
          if (isHidden(item)) {
            omit(item, sourceRow, "aria-posinset");
            continue;
          }
          if (result.items.length === options.max_rows) {
            stop("row_limit");
            break;
          }
          const row: Record<string, string | null> = Object.create(null);
          const position = integer(item.getAttribute("aria-posinset"), sourceRow);
          if (position <= (result.item_sources.at(-1)?.source_row ?? 0))
            fail("extract_structure_invalid", "ARIA list positions must increase");
          const setSize = item.getAttribute("aria-setsize");
          if (setSize !== null) {
            const count = setSize === "-1" ? -1 : integer(setSize, 0);
            result.declared_rows =
              result.declared_rows === undefined
                ? count
                : result.declared_rows === -1 || count === -1
                  ? -1
                  : Math.max(result.declared_rows, count);
          }
          for (const field of fields) {
            const matches = field.selector === ":scope" ? [item] : select(item, field.selector);
            const visible: Element[] = [];
            for (const match of matches) {
              tick();
              if (!isHidden(match)) visible.push(match);
              if (visible.length > 1) break;
            }
            if (visible.length > 1 && !options.fields && field.key === "url") {
              row[field.key] = null;
              result.warnings.push("ambiguous_default_url");
              continue;
            }
            if (visible.length > 1)
              fail("extract_field_ambiguous", `Field ${field.key} matches multiple elements`);
            const element = visible[0];
            if (!element || element.matches('input[type="password"],input[type="hidden"]')) {
              row[field.key] = null;
              continue;
            }
            if (field.read === "text") row[field.key] = text(element);
            else {
              const value = element.getAttribute(field.read === "href" ? "href" : field.attribute!);
              if (value !== null) {
                consume(value);
              }
              if (field.read === "href" && value !== null) {
                try {
                  row[field.key] = new URL(value, element.baseURI).href;
                } catch {
                  row[field.key] = value;
                  result.warnings.push("invalid_link_url");
                }
              } else row[field.key] = value;
            }
          }
          const source = {
            row: result.items.length,
            source_row: position,
            row_kind: "data" as const,
            locator: locator(item),
          };
          result.items.push(row);
          result.item_sources.push(source);
        } catch (error) {
          if (isLimit(error) && result.items.length) {
            stop(limitReason(error, "collection_limit"));
            break;
          }
          throw error;
        }
      }
      return result;
    }
    if (!root.matches(tableSelector))
      fail("extract_structure_invalid", "Target is not an HTML or ARIA table/grid");
    const native = root instanceof HTMLTableElement;
    result.aria_rows = !native;
    const rows = native ? (root as HTMLTableElement).rows : select(root, '[role="row"]');
    const groups = new Map<Element | null, number>();
    let dataRows = 0;
    let previousSourceRow = 0;
    const dataPositions = new Set<number>();
    let sawData = false;
    for (let index = 0; index < rows.length; index++) {
      try {
        tick();
        const element = rows[index];
        if (element.closest(tableSelector) !== root) continue;
        if (isHidden(element)) {
          omit(element, index + 1, "aria-rowindex");
          continue;
        }
        const sourceRow = integer(element.getAttribute("aria-rowindex"), index + 1);
        if (native && sourceRow <= previousSourceRow)
          fail("extract_structure_invalid", "ARIA row indices must increase");
        previousSourceRow = sourceRow;
        const rowCells =
          element instanceof HTMLTableRowElement
            ? element.cells
            : select(
                element,
                '[role="cell"],[role="gridcell"],[role="columnheader"],[role="rowheader"]',
              );
        const cells: RawCell[] = [];
        const groupElement = native ? element.parentElement : element.closest('[role="rowgroup"]');
        if (!groups.has(groupElement)) groups.set(groupElement, groups.size);
        const headerGroup = groupElement?.tagName === "THEAD";
        const footerGroup = groupElement?.tagName === "TFOOT";
        for (let cellIndex = 0; cellIndex < rowCells.length; cellIndex++) {
          tick();
          const cell = rowCells[cellIndex];
          if (cell.closest(native ? "tr" : '[role="row"]') !== element) continue;
          if (cells.length === options.max_columns) fail("extract_limit", "Column budget exceeded");
          const scope = cell.getAttribute("scope") ?? "";
          if (
            cell.id.length > 2048 ||
            (cell.getAttribute("headers")?.length ?? 0) > 8192 ||
            scope.length > 128
          )
            fail("extract_limit", "Cell attributes exceed metadata budget");
          const role = cell.getAttribute("role");
          const header =
            role === "columnheader" ||
            ((headerGroup || cell.tagName === "TH") &&
              !["row", "rowgroup"].includes(scope) &&
              role !== "rowheader");
          const columnIndex =
            cell.getAttribute("aria-colindex") ??
            (cellIndex === 0 ? element.getAttribute("aria-colindex") : null);
          cells.push({
            text: isHidden(cell) ? null : text(cell),
            id: cell.id,
            headers: (cell.getAttribute("headers") ?? "").split(/\s+/).filter(Boolean),
            scope: role === "rowheader" ? "row" : scope,
            header,
            row_span:
              cell instanceof HTMLTableCellElement
                ? cell.getAttribute("rowspan") === "0"
                  ? 0
                  : cell.rowSpan
                : ariaSpan(cell, "aria-rowspan", true),
            column_span:
              cell instanceof HTMLTableCellElement ? cell.colSpan : ariaSpan(cell, "aria-colspan"),
            ...(columnIndex !== null ? { column_index: integer(columnIndex, 1) } : {}),
          });
        }
        const isHeader =
          headerGroup ||
          ((!native || !sawData) &&
            cells.some((cell) => cell.header) &&
            cells.every((cell) => cell.header || !cell.text));
        if (!isHeader && !dataPositions.has(sourceRow) && dataRows === options.max_rows) {
          stop("row_limit");
          break;
        }
        if (isHeader && result.rows.filter((row) => row.kind === "header").length >= 32)
          fail("extract_limit", "Header row budget exceeded");
        const row: RawRow = {
          cells,
          source_row: sourceRow,
          group: groups.get(groupElement)!,
          kind: isHeader ? "header" : footerGroup ? "footer" : "data",
          locator: locator(element),
          indexed: element.hasAttribute("aria-rowindex"),
        };
        result.rows.push(row);
        if (!isHeader) {
          dataPositions.add(sourceRow);
          dataRows = dataPositions.size;
          sawData = true;
        }
      } catch (error) {
        if (isLimit(error) && dataRows) {
          stop(limitReason(error, "collection_limit"));
          break;
        }
        throw error;
      }
    }
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const separator = message.indexOf(": ");
    result.error = {
      reason: separator >= 0 ? message.slice(0, separator) : "extract_structure_invalid",
      message: separator >= 0 ? message.slice(separator + 2) : message,
    };
    return result;
  }
}
