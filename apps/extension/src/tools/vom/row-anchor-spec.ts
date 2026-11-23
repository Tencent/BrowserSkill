/**
 * Single source of truth for virtual-scroll row business-key (`rowAnchor`)
 * extraction shared between snapshot-time semantic resolution (`resolve.ts`)
 * and pre-action in-page verification (`SAMPLE_TARGET` in `action-checks.ts`).
 *
 * Both sides MUST agree identically on row container selection, slot skipping,
 * and volatile-cell filtering so unchanged rows never trigger false-positive
 * `virtual_row_recycled` errors.
 */

export const MAX_ROW_ANCHOR_CHARS = 80;
export const MAX_SEMANTIC_ROW_HOPS = 12;
export const MAX_VIRTUAL_DIV_ROW_HOPS = 3;
export const MAX_SLOT_TEXT_SCAN_CHARS = 160;

/**
 * Pure timers ("00:15", "5s ago", "3 秒前") and pure progress percentages
 * ("45%", "99.5%") update continuously inside an unchanged row, so row-anchor
 * selection skips them in favor of the next stable business-key column.
 */
export const VOLATILE_ROW_TEXT_RE =
  /^(?:\d{1,2}:\d{2}(?::\d{2})?|\d+(?:\.\d+)?\s*%|\d+(?:\.\d+)?\s*(?:ms|s|sec|secs|m|min|mins|h|hr|hrs|秒|分钟|分|小时)(?:\s*前|\s*ago)?)$/i;

export const ROW_STOP_TAGS = new Set([
  "body",
  "html",
  "form",
  "table",
  "main",
  "nav",
  "header",
  "footer",
  "section",
  "article",
  "aside",
  "dialog",
]);

export const VIRTUAL_POOL_EXCLUDED_TAGS = new Set(["body", "html", "form", "label", "fieldset"]);

export const NON_ANCHOR_TAGS = new Set([
  "button",
  "input",
  "select",
  "textarea",
  "option",
  "optgroup",
  "summary",
  "script",
  "style",
  "noscript",
  "template",
  "svg",
]);

export const NON_ANCHOR_ROLES = new Set([
  "button",
  "checkbox",
  "combobox",
  "listbox",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox",
  "treeitem",
]);

/**
 * Generates the self-contained JS snippet embedded inside `SAMPLE_TARGET`
 * (`Runtime.callFunctionOn`) so the in-page pre-action check uses the exact
 * same tag/role sets, volatile regex, hop limits, and stealth/microbox geometry
 * exclusions as `createRowAnchorResolver` in `resolve.ts`.
 *
 * Expects `this` (or `const el = this`) and `sensitiveSelector` in scope, and
 * assigns the computed `string | null` to `rowAnchor`.
 */
export function buildInPageRowAnchorSnippet(): string {
  const stopTagsJson = JSON.stringify([...ROW_STOP_TAGS]);
  const poolExcludedJson = JSON.stringify([...VIRTUAL_POOL_EXCLUDED_TAGS]);
  const nonAnchorTagsJson = JSON.stringify([...NON_ANCHOR_TAGS]);
  const nonAnchorRolesJson = JSON.stringify([...NON_ANCHOR_ROLES]);
  const volatileReSrc = VOLATILE_ROW_TEXT_RE.source;
  const volatileReFlags = VOLATILE_ROW_TEXT_RE.flags;

  return `{
    const el = this;
    const clean = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
    const directText = (n) => {
      const parts = [];
      for (let c = n.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3 || c.nodeType === 4) {
          const t = String(c.nodeValue || '').trim();
          if (t) parts.push(t);
        }
      }
      return parts.length ? clean(parts.join(' ')) : '';
    };
    const stopTags = new Set(${stopTagsJson});
    const poolExcludedTags = new Set(${poolExcludedJson});
    const nonAnchorTags = new Set(${nonAnchorTagsJson});
    const nonAnchorRoles = new Set(${nonAnchorRolesJson});
    const volatileRe = new RegExp(${JSON.stringify(volatileReSrc)}, ${JSON.stringify(volatileReFlags)});
    const rootRect = document.documentElement ? document.documentElement.getBoundingClientRect() : null;
    const hasLayout = Boolean(rootRect && (rootRect.width > 0 || rootRect.height > 0));
    const hasOverflowingVisibleChild = (root) => {
      const stack = Array.from(root.children);
      let guard = 0;
      while (stack.length > 0 && guard++ < 256) {
        const ch = stack.pop();
        const r = ch.getBoundingClientRect();
        if (r.width >= 2 && r.height >= 2) return true;
        for (let i = 0; i < ch.children.length; i++) stack.push(ch.children[i]);
      }
      return false;
    };
    const findRow = () => {
      let cur = el.parentElement;
      for (let hop = 0; hop < ${MAX_SEMANTIC_ROW_HOPS} && cur; hop++) {
        const t = cur.tagName.toLowerCase();
        if (t === 'body' || t === 'html') break;
        const r = (cur.getAttribute('role') || '').trim().toLowerCase();
        if (t === 'tr' || t === 'li' || r === 'row' || r === 'listitem') return cur;
        cur = cur.parentElement;
      }
      if (el.closest('form')) return null;
      cur = el.parentElement;
      for (let hop = 0; hop < ${MAX_VIRTUAL_DIV_ROW_HOPS} && cur; hop++) {
        const t = cur.tagName.toLowerCase();
        if (stopTags.has(t)) break;
        if (t === 'div') {
          const r = (cur.getAttribute('role') || '').trim().toLowerCase();
          const cls = (cur.getAttribute('class') || '').trim();
          const pool = cur.parentElement;
          const poolTag = pool ? pool.tagName.toLowerCase() : '';
          if (
            cls &&
            (!r || r === 'generic' || r === 'none' || r === 'presentation') &&
            cur.children.length >= 1 &&
            cur.children.length <= 12 &&
            pool &&
            !poolExcludedTags.has(poolTag)
          ) {
            let same = 0;
            for (let i = 0; i < pool.children.length && same < 4; i++) {
              const sib = pool.children[i];
              if (sib.tagName.toLowerCase() === 'div' && (sib.getAttribute('class') || '').trim() === cls) {
                same++;
              }
            }
            if (same >= 4) return cur;
          }
        }
        cur = cur.parentElement;
      }
      return null;
    };
    const elemText = (root) => {
      const parts = [];
      let len = 0;
      const own = directText(root);
      if (own) {
        parts.push(own);
        len = own.length;
      }
      for (let i = 0; i < root.children.length && len < 240; i++) {
        const ch = root.children[i];
        const ct = ch.tagName.toLowerCase();
        if (ct === 'script' || ct === 'style' || ct === 'noscript' || ct === 'template') continue;
        const sub = elemText(ch);
        if (sub) {
          parts.push(sub);
          len += sub.length + 1;
        }
      }
      return parts.length ? clean(parts.join(' ').slice(0, 240)) : '';
    };
    const slotText = (n) => {
      if (n === el || !(n instanceof Element)) return '';
      if (n.hasAttribute('hidden') || (n.getAttribute('aria-hidden') || '').toLowerCase() === 'true') return '';
      const t = n.tagName.toLowerCase();
      if (nonAnchorTags.has(t)) return '';
      const r = (n.getAttribute('role') || '').trim().toLowerCase();
      if (r && nonAnchorRoles.has(r)) return '';
      if (n.matches(sensitiveSelector)) return '';
      const st = getComputedStyle(n);
      if (st.display === 'none' || st.visibility === 'hidden' || st.visibility === 'collapse') return '';
      const op = parseFloat(st.opacity || '1');
      if (Number.isFinite(op) && op < 0.05) return '';
      const fs = parseFloat(st.fontSize || '16');
      if (Number.isFinite(fs) && fs <= 1.5) return '';
      if (st.display !== 'contents') {
        const clipped = st.overflowX === 'hidden' || st.overflowX === 'clip' || st.overflowY === 'hidden' || st.overflowY === 'clip';
        if (clipped && (st.width === '0px' || st.height === '0px')) return '';
        const rect = n.getBoundingClientRect();
        if (hasLayout && (rect.width <= 0 || rect.height <= 0)) return '';
        if (rect.right + (window.scrollX || 0) < -500 || rect.bottom + (window.scrollY || 0) < -500) return '';
        if (rect.width > 0 && rect.width < 2 && rect.height > 0 && rect.height < 2) {
          if (clipped || !hasOverflowingVisibleChild(n)) return '';
        }
      }
      const parts = [];
      let len = 0;
      const own = directText(n);
      if (own) {
        parts.push(own);
        len += own.length;
      }
      for (let i = 0; i < n.children.length; i++) {
        const sub = slotText(n.children[i]);
        if (sub) {
          parts.push(sub);
          len += sub.length + 1;
          if (len >= ${MAX_SLOT_TEXT_SCAN_CHARS}) break;
        }
      }
      return parts.length ? clean(parts.join(' ')) : '';
    };
    const row = findRow();
    if (row) {
      const selfText = elemText(el).toLowerCase();
      const selfAria = clean(el.getAttribute('aria-label')).toLowerCase();
      const accept = (raw) => {
        if (!raw || volatileRe.test(raw)) return null;
        const lower = raw.toLowerCase();
        if ((selfText && lower === selfText) || (selfAria && lower === selfAria)) return null;
        const cps = Array.from(raw);
        return cps.length > ${MAX_ROW_ANCHOR_CHARS} ? cps.slice(0, ${MAX_ROW_ANCHOR_CHARS}).join('').trim() : raw;
      };
      rowAnchor = accept(directText(row));
      if (!rowAnchor) {
        for (let i = 0; i < row.children.length; i++) {
          rowAnchor = accept(slotText(row.children[i]));
          if (rowAnchor) break;
        }
      }
    }
  }`;
}
