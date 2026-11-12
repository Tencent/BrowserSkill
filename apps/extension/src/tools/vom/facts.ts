import type { Viewport } from "@browser-skill/vom";
import type { CdpFrame, CdpTarget } from "@/browser-driver/frame-graph";
import { OVERLAY_HOST_MARKER_ATTR, OVERLAY_HOST_NAME } from "@/lib/overlay-bridge";
import type { GeometryProjection } from "../geometry";
import type { FrameProjectionIssue, SnapshotCoordinates } from "../geometry/coordinate-types";
import { createCaptureCheckpoint } from "./capture-abort";
import type { CapturedNode } from "./capture-types";
import type { FrameOwnedAxNode } from "./frame-document";

function isDecodedOverlayHost(item: DecodedNode): boolean {
  if (item.tag === OVERLAY_HOST_NAME || item.tag.toLowerCase() === OVERLAY_HOST_NAME) return true;
  const attrs = item.attrs;
  if (OVERLAY_HOST_MARKER_ATTR in attrs) return true;
  for (const key in attrs) {
    if (key.toLowerCase() === OVERLAY_HOST_MARKER_ATTR) return true;
  }
  return false;
}

const STEALTH_SKIP_SHELL_TAGS = new Set([
  "html",
  "body",
  "head",
  "meta",
  "link",
  "script",
  "style",
  "noscript",
  "template",
  "br",
  "hr",
  "wbr",
  "col",
  "colgroup",
  "svg",
  "path",
  "g",
  "defs",
  "use",
  "symbol",
  "clippath",
  "lineargradient",
  "radialgradient",
  "stop",
]);

const INTERACTIVE_OR_VISUAL_TAGS = new Set([
  "button",
  "input",
  "select",
  "textarea",
  "option",
  "optgroup",
  "summary",
  "details",
  "iframe",
  "canvas",
  "video",
  "audio",
  "dialog",
]);

const INTERACTIVE_ARIA_ROLES = new Set([
  "button",
  "checkbox",
  "combobox",
  "link",
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

const INLINE_OPACITY_RE = /(?:^|;)\s*opacity\s*:\s*([+-]?\d*\.?\d+)/i;
const INLINE_FONT_SIZE_RE = /(?:^|;)\s*font-size\s*:\s*([+-]?\d*\.?\d+)\s*px\b/i;
const INLINE_CLIP_OVERFLOW_RE = /(?:^|;)\s*overflow(?:-[xy])?\s*:\s*(?:hidden|clip)\b/i;
const INLINE_SCROLL_OVERFLOW_X_RE = /(?:^|;)\s*overflow(?:-x)?\s*:\s*(?:auto|scroll|overlay)\b/i;
const INLINE_SCROLL_OVERFLOW_Y_RE = /(?:^|;)\s*overflow(?:-y)?\s*:\s*(?:auto|scroll|overlay)\b/i;
const INLINE_BG_CLIP_TEXT_RE = /(?:^|;)\s*(?:-webkit-)?background-clip\s*:\s*text\b/i;
const INLINE_BG_DECL_RE = /(?:^|;)\s*background(?:-image)?\s*:\s*([^;]+)/gi;
const GRADIENT_FN_RE =
  /^(?:-(?:webkit|moz|o)-)?(repeating-)?(linear|radial|conic)-gradient\(([\s\S]+)\)$/i;
const IMAGE_FN_RE = /^(?:url|image-set|-webkit-image-set|cross-fade|paint)\(/i;
const CSS_PX_RE = /^([+-]?(?:\d+\.?\d*|\.\d+))px$/i;
const MAX_SR_ONLY_LABEL_CHARS = 80;

interface ParsedRgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

const NAMED_RGBA: Readonly<Record<string, readonly [number, number, number]>> = {
  black: [0, 0, 0],
  white: [255, 255, 255],
  red: [255, 0, 0],
  green: [0, 128, 0],
  lime: [0, 255, 0],
  blue: [0, 0, 255],
  yellow: [255, 255, 0],
  cyan: [0, 255, 255],
  aqua: [0, 255, 255],
  magenta: [255, 0, 255],
  fuchsia: [255, 0, 255],
  gray: [128, 128, 128],
  grey: [128, 128, 128],
  silver: [192, 192, 192],
  maroon: [128, 0, 0],
  olive: [128, 128, 0],
  purple: [128, 0, 128],
  teal: [0, 128, 128],
  navy: [0, 0, 128],
  orange: [255, 165, 0],
  rebeccapurple: [102, 51, 153],
};

function parseCssPx(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const m = CSS_PX_RE.exec(raw.trim());
  if (!m) return undefined;
  const v = Number.parseFloat(m[1]);
  return Number.isFinite(v) ? v : undefined;
}

function clampAlpha(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function clampByte(v: number): number {
  return v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v);
}

function linToSrgb(c: number): number {
  if (c <= 0) return 0;
  if (c >= 1) return 1;
  return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
}

function srgbToLin(c: number): number {
  if (c <= 0) return 0;
  if (c >= 1) return 1;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function splitTopLevel(s: string, sepCode: number): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    if (quote !== 0) {
      if (ch === 92) i++;
      else if (ch === quote) quote = 0;
      continue;
    }
    if (ch === 34 || ch === 39) quote = ch;
    else if (ch === 40) depth++;
    else if (ch === 41 && depth > 0) depth--;
    else if (ch === sepCode && depth === 0) {
      out.push(s.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(s.slice(start).trim());
  return out;
}

function splitTopLevelTokens(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = 0;
  let start = -1;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    if (quote !== 0) {
      if (ch === 92) i++;
      else if (ch === quote) quote = 0;
      continue;
    }
    const isWs = ch === 32 || ch === 9 || ch === 10 || ch === 13;
    if (isWs && depth === 0) {
      if (start >= 0) {
        out.push(s.slice(start, i));
        start = -1;
      }
      continue;
    }
    if (start < 0) start = i;
    if (ch === 34 || ch === 39) quote = ch;
    else if (ch === 40) depth++;
    else if (ch === 41 && depth > 0) depth--;
  }
  if (start >= 0) out.push(s.slice(start));
  return out;
}

function parseAlphaValue(raw: string | undefined): number | undefined {
  if (raw === undefined) return 1;
  const t = raw.trim();
  if (t === "none") return 0;
  const isPct = t.endsWith("%");
  const v = Number.parseFloat(isPct ? t.slice(0, -1) : t);
  return Number.isFinite(v) ? clampAlpha(isPct ? v / 100 : v) : undefined;
}

function parseAngleDeg(raw: string): number | undefined {
  if (raw === "none") return 0;
  let scale = 1;
  let num = raw;
  if (raw.endsWith("deg")) num = raw.slice(0, -3);
  else if (raw.endsWith("grad")) {
    num = raw.slice(0, -4);
    scale = 0.9;
  } else if (raw.endsWith("rad")) {
    num = raw.slice(0, -3);
    scale = 180 / Math.PI;
  } else if (raw.endsWith("turn")) {
    num = raw.slice(0, -4);
    scale = 360;
  }
  const v = Number.parseFloat(num);
  return Number.isFinite(v) ? v * scale : undefined;
}

function parseChannel(raw: string, pctScale: number): number | undefined {
  if (raw === "none") return 0;
  const isPct = raw.endsWith("%");
  const v = Number.parseFloat(isPct ? raw.slice(0, -1) : raw);
  if (!Number.isFinite(v)) return undefined;
  return isPct ? (v * pctScale) / 100 : v;
}

function hslToRgbBytes(hDeg: number, s: number, l: number): [number, number, number] {
  const h = ((hDeg % 360) + 360) % 360;
  const sc = clampAlpha(s);
  const lc = clampAlpha(l);
  const c = (1 - Math.abs(2 * lc - 1)) * sc;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = lc - c / 2;
  let r1 = 0;
  let g1 = 0;
  let b1 = 0;
  if (h < 60) [r1, g1, b1] = [c, x, 0];
  else if (h < 120) [r1, g1, b1] = [x, c, 0];
  else if (h < 180) [r1, g1, b1] = [0, c, x];
  else if (h < 240) [r1, g1, b1] = [0, x, c];
  else if (h < 300) [r1, g1, b1] = [x, 0, c];
  else [r1, g1, b1] = [c, 0, x];
  return [clampByte((r1 + m) * 255), clampByte((g1 + m) * 255), clampByte((b1 + m) * 255)];
}

function isZeroContrast(a: ParsedRgba, b: ParsedRgba): boolean {
  return Math.abs(a.r - b.r) <= 2 && Math.abs(a.g - b.g) <= 2 && Math.abs(a.b - b.b) <= 2;
}

function compositeOver(fg: ParsedRgba, bg: ParsedRgba): ParsedRgba {
  const ia = 1 - fg.a;
  return {
    r: clampByte(fg.r * fg.a + bg.r * ia),
    g: clampByte(fg.g * fg.a + bg.g * ia),
    b: clampByte(fg.b * fg.a + bg.b * ia),
    a: 1,
  };
}

function parseMixItem(raw: string): { colorRaw: string; pct?: number } | undefined {
  const toks = splitTopLevelTokens(raw.trim());
  if (toks.length === 0) return undefined;
  if (toks.length === 1) return { colorRaw: toks[0] };
  if (toks.length === 2) {
    if (toks[1].endsWith("%")) {
      const p = Number.parseFloat(toks[1].slice(0, -1));
      return Number.isFinite(p) && p >= 0 && p <= 100 ? { colorRaw: toks[0], pct: p } : undefined;
    }
    if (toks[0].endsWith("%")) {
      const p = Number.parseFloat(toks[0].slice(0, -1));
      return Number.isFinite(p) && p >= 0 && p <= 100 ? { colorRaw: toks[1], pct: p } : undefined;
    }
  }
  return undefined;
}

function parseCssRgba(
  raw: string | undefined,
  currentColor?: ParsedRgba | null,
  depth = 0,
): ParsedRgba | undefined {
  if (!raw || depth > 6) return undefined;
  const s = raw.trim().toLowerCase();
  if (
    !s ||
    s === "none" ||
    s === "auto" ||
    s === "initial" ||
    s === "inherit" ||
    s === "unset" ||
    s === "revert" ||
    s === "revert-layer"
  ) {
    return undefined;
  }
  if (s === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  if (s === "currentcolor") return currentColor ?? undefined;
  const named = NAMED_RGBA[s];
  if (named) return { r: named[0], g: named[1], b: named[2], a: 1 };

  if (s.startsWith("#")) {
    const hex = s.slice(1);
    if (hex.length === 3 || hex.length === 4) {
      const r = Number.parseInt(hex[0] + hex[0], 16);
      const g = Number.parseInt(hex[1] + hex[1], 16);
      const b = Number.parseInt(hex[2] + hex[2], 16);
      const a = hex.length === 4 ? Number.parseInt(hex[3] + hex[3], 16) / 255 : 1;
      return Number.isNaN(r + g + b + a) ? undefined : { r, g, b, a };
    }
    if (hex.length === 6 || hex.length === 8) {
      const r = Number.parseInt(hex.slice(0, 2), 16);
      const g = Number.parseInt(hex.slice(2, 4), 16);
      const b = Number.parseInt(hex.slice(4, 6), 16);
      const a = hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : 1;
      return Number.isNaN(r + g + b + a) ? undefined : { r, g, b, a };
    }
    return undefined;
  }

  const openIdx = s.indexOf("(");
  if (openIdx <= 0 || !s.endsWith(")")) return undefined;
  const fn = s.slice(0, openIdx);
  const body = s.slice(openIdx + 1, -1).trim();

  if (fn === "color-mix") {
    const parts = splitTopLevel(body, 44);
    if (parts.length !== 3 || !parts[0].startsWith("in ")) return undefined;
    const m1 = parseMixItem(parts[1]);
    const m2 = parseMixItem(parts[2]);
    if (!m1 || !m2) return undefined;
    const p1 = m1.pct ?? (m2.pct !== undefined ? 100 - m2.pct : 50);
    const p2 = m2.pct ?? (m1.pct !== undefined ? 100 - m1.pct : 50);
    const sum = p1 + p2;
    if (sum <= 0) return undefined;
    const alphaMul = sum < 100 ? sum / 100 : 1;
    const w1 = p1 / sum;
    const w2 = p2 / sum;
    if (w1 === 0) {
      const c2 = parseCssRgba(m2.colorRaw, currentColor, depth + 1);
      return c2 ? { ...c2, a: clampAlpha(c2.a * alphaMul) } : undefined;
    }
    if (w2 === 0) {
      const c1 = parseCssRgba(m1.colorRaw, currentColor, depth + 1);
      return c1 ? { ...c1, a: clampAlpha(c1.a * alphaMul) } : undefined;
    }
    const c1 = parseCssRgba(m1.colorRaw, currentColor, depth + 1);
    const c2 = parseCssRgba(m2.colorRaw, currentColor, depth + 1);
    if (!c1 || !c2) {
      if (m1.colorRaw === "currentcolor" && c2) {
        const maxA = clampAlpha((w1 + w2 * c2.a) * alphaMul);
        if (maxA < 0.05) return { r: c2.r, g: c2.g, b: c2.b, a: maxA };
      } else if (m2.colorRaw === "currentcolor" && c1) {
        const maxA = clampAlpha((w1 * c1.a + w2) * alphaMul);
        if (maxA < 0.05) return { r: c1.r, g: c1.g, b: c1.b, a: maxA };
      }
      return undefined;
    }
    const rawA = w1 * c1.a + w2 * c2.a;
    if (rawA <= 0) return { r: 0, g: 0, b: 0, a: 0 };
    return {
      r: clampByte((w1 * c1.a * c1.r + w2 * c2.a * c2.r) / rawA),
      g: clampByte((w1 * c1.a * c1.g + w2 * c2.a * c2.g) / rawA),
      b: clampByte((w1 * c1.a * c1.b + w2 * c2.a * c2.b) / rawA),
      a: clampAlpha(rawA * alphaMul),
    };
  }

  if (fn === "light-dark") {
    const parts = splitTopLevel(body, 44);
    if (parts.length !== 2) return undefined;
    const c1 = parseCssRgba(parts[0], currentColor, depth + 1);
    const c2 = parseCssRgba(parts[1], currentColor, depth + 1);
    if (c1 && c2) {
      if (c1.a < 0.05 && c2.a < 0.05) return { r: 0, g: 0, b: 0, a: 0 };
      if (c1.a >= 0.9 && c2.a >= 0.9 && isZeroContrast(c1, c2)) return c1;
    }
    return undefined;
  }

  let alphaRaw: string | undefined;
  let chanToks: string[];
  const commaParts = splitTopLevel(body, 44);
  if (commaParts.length >= 3) {
    if (commaParts.length > 4) return undefined;
    chanToks = commaParts.slice(0, 3);
    alphaRaw = commaParts[3];
  } else {
    const slashParts = splitTopLevel(body, 47);
    if (slashParts.length > 2) return undefined;
    alphaRaw = slashParts[1];
    chanToks = splitTopLevelTokens(slashParts[0]);
  }
  const a = parseAlphaValue(alphaRaw);
  if (a === undefined) return undefined;

  if (fn === "rgb" || fn === "rgba") {
    if (chanToks.length !== 3) return undefined;
    const r = parseChannel(chanToks[0], 255);
    const g = parseChannel(chanToks[1], 255);
    const b = parseChannel(chanToks[2], 255);
    return r === undefined || g === undefined || b === undefined
      ? undefined
      : { r: clampByte(r), g: clampByte(g), b: clampByte(b), a };
  }

  if (fn === "hsl" || fn === "hsla") {
    if (chanToks.length !== 3) return undefined;
    const h = parseAngleDeg(chanToks[0]);
    const sat = parseChannel(chanToks[1], 1);
    const lig = parseChannel(chanToks[2], 1);
    if (h === undefined || sat === undefined || lig === undefined) return undefined;
    const sNorm = chanToks[1].endsWith("%") || chanToks[1] === "none" ? sat : sat / 100;
    const lNorm = chanToks[2].endsWith("%") || chanToks[2] === "none" ? lig : lig / 100;
    const [r, g, b] = hslToRgbBytes(h, sNorm, lNorm);
    return { r, g, b, a };
  }

  if (fn === "hwb") {
    if (chanToks.length !== 3) return undefined;
    const h = parseAngleDeg(chanToks[0]);
    const wRaw = parseChannel(chanToks[1], 1);
    const bRaw = parseChannel(chanToks[2], 1);
    if (h === undefined || wRaw === undefined || bRaw === undefined) return undefined;
    const w = clampAlpha(chanToks[1].endsWith("%") || chanToks[1] === "none" ? wRaw : wRaw / 100);
    const bl = clampAlpha(chanToks[2].endsWith("%") || chanToks[2] === "none" ? bRaw : bRaw / 100);
    if (w + bl >= 1) {
      const gray = clampByte((w / (w + bl)) * 255);
      return { r: gray, g: gray, b: gray, a };
    }
    const [r0, g0, b0] = hslToRgbBytes(h, 1, 0.5);
    const f = 1 - w - bl;
    return {
      r: clampByte(r0 * f + w * 255),
      g: clampByte(g0 * f + w * 255),
      b: clampByte(b0 * f + w * 255),
      a,
    };
  }

  if (fn === "oklab" || fn === "oklch") {
    if (chanToks.length !== 3) return undefined;
    const L = parseChannel(chanToks[0], 1);
    if (L === undefined) return undefined;
    let oa: number | undefined;
    let ob: number | undefined;
    if (fn === "oklch") {
      const C = parseChannel(chanToks[1], 0.4);
      const H = parseAngleDeg(chanToks[2]);
      if (C === undefined || H === undefined) return undefined;
      const rad = (H * Math.PI) / 180;
      oa = Math.max(0, C) * Math.cos(rad);
      ob = Math.max(0, C) * Math.sin(rad);
    } else {
      oa = parseChannel(chanToks[1], 0.4);
      ob = parseChannel(chanToks[2], 0.4);
    }
    if (oa === undefined || ob === undefined) return undefined;
    const l_ = L + 0.3963377774 * oa + 0.2158037573 * ob;
    const m_ = L - 0.1055613458 * oa - 0.0638541728 * ob;
    const s_ = L - 0.0894841775 * oa - 1.291485548 * ob;
    const l3 = l_ * l_ * l_;
    const m3 = m_ * m_ * m_;
    const s3 = s_ * s_ * s_;
    const lr = 4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3;
    const lg = -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3;
    const lb = -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3;
    return {
      r: clampByte(linToSrgb(lr) * 255),
      g: clampByte(linToSrgb(lg) * 255),
      b: clampByte(linToSrgb(lb) * 255),
      a,
    };
  }

  if (fn === "lab" || fn === "lch") {
    if (chanToks.length !== 3) return undefined;
    const L = parseChannel(chanToks[0], 100);
    if (L === undefined) return undefined;
    let la: number | undefined;
    let lbCh: number | undefined;
    if (fn === "lch") {
      const C = parseChannel(chanToks[1], 150);
      const H = parseAngleDeg(chanToks[2]);
      if (C === undefined || H === undefined) return undefined;
      const rad = (H * Math.PI) / 180;
      la = Math.max(0, C) * Math.cos(rad);
      lbCh = Math.max(0, C) * Math.sin(rad);
    } else {
      la = parseChannel(chanToks[1], 125);
      lbCh = parseChannel(chanToks[2], 125);
    }
    if (la === undefined || lbCh === undefined) return undefined;
    const fy = (L + 16) / 116;
    const fx = la / 500 + fy;
    const fz = fy - lbCh / 200;
    const eps = 216 / 24389;
    const kap = 24389 / 27;
    const x = (fx * fx * fx > eps ? fx * fx * fx : (116 * fx - 16) / kap) * 0.96422;
    const y = L > kap * eps ? fy * fy * fy : L / kap;
    const z = (fz * fz * fz > eps ? fz * fz * fz : (116 * fz - 16) / kap) * 0.82521;
    const lr = 3.1338561 * x - 1.6168667 * y - 0.4906146 * z;
    const lg = -0.9787684 * x + 1.9161415 * y + 0.033454 * z;
    const lb = 0.0719453 * x - 0.2289914 * y + 1.4052427 * z;
    return {
      r: clampByte(linToSrgb(lr) * 255),
      g: clampByte(linToSrgb(lg) * 255),
      b: clampByte(linToSrgb(lb) * 255),
      a,
    };
  }

  if (fn === "color") {
    if (chanToks.length !== 4) return undefined;
    const space = chanToks[0];
    const c1 = parseChannel(chanToks[1], 1);
    const c2 = parseChannel(chanToks[2], 1);
    const c3 = parseChannel(chanToks[3], 1);
    if (c1 === undefined || c2 === undefined || c3 === undefined) return undefined;
    if (space === "srgb") {
      return { r: clampByte(c1 * 255), g: clampByte(c2 * 255), b: clampByte(c3 * 255), a };
    }
    let lr: number;
    let lg: number;
    let lb: number;
    if (space === "srgb-linear") {
      [lr, lg, lb] = [c1, c2, c3];
    } else if (space === "display-p3") {
      const pr = srgbToLin(c1);
      const pg = srgbToLin(c2);
      const pb = srgbToLin(c3);
      lr = 1.2249401 * pr - 0.2249402 * pg;
      lg = -0.0420569 * pr + 1.0420571 * pg;
      lb = -0.0196376 * pr - 0.0786361 * pg + 1.0982735 * pb;
    } else if (space === "xyz" || space === "xyz-d65") {
      lr = 3.2404542 * c1 - 1.5371385 * c2 - 0.4985314 * c3;
      lg = -0.969266 * c1 + 1.8760108 * c2 + 0.041556 * c3;
      lb = 0.0556434 * c1 - 0.2040259 * c2 + 1.0572252 * c3;
    } else if (space === "xyz-d50") {
      lr = 3.1338561 * c1 - 1.6168667 * c2 - 0.4906146 * c3;
      lg = -0.9787684 * c1 + 1.9161415 * c2 + 0.033454 * c3;
      lb = 0.0719453 * c1 - 0.2289914 * c2 + 1.4052427 * c3;
    } else if (space === "a98-rgb" || space === "prophoto-rgb" || space === "rec2020") {
      return { r: clampByte(c1 * 255), g: clampByte(c2 * 255), b: clampByte(c3 * 255), a };
    } else {
      return undefined;
    }
    return {
      r: clampByte(linToSrgb(lr) * 255),
      g: clampByte(linToSrgb(lg) * 255),
      b: clampByte(linToSrgb(lb) * 255),
      a,
    };
  }

  return undefined;
}

function isUnresolvedColorBarrier(raw: string): boolean {
  const s = raw.trim().toLowerCase();
  if (s.startsWith("light-dark(") && s.endsWith(")")) {
    const parts = splitTopLevel(s.slice(11, -1), 44);
    if (parts.length !== 2) return false;
    const c1 = parseCssRgba(parts[0]);
    const c2 = parseCssRgba(parts[1]);
    return (c1?.a ?? 1) >= 0.15 || (c2?.a ?? 1) >= 0.15;
  }
  if (s.startsWith("color-mix(") && s.endsWith(")") && /\bcurrentcolor\b/.test(s)) {
    const parsedWithOpaque = parseCssRgba(s, { r: 0, g: 0, b: 0, a: 1 });
    return (parsedWithOpaque?.a ?? 0) >= 0.15;
  }
  return false;
}

function parseStopPosition(
  tok: string,
  isConic: boolean,
  boxCssWidth: number | undefined,
): number | undefined {
  if (tok.endsWith("%")) {
    const v = Number.parseFloat(tok.slice(0, -1));
    return Number.isFinite(v) ? v / 100 : undefined;
  }
  if (isConic) {
    const deg = parseAngleDeg(tok);
    if (deg !== undefined) return deg / 360;
  }
  if (tok === "0" || tok === "+0" || tok === "-0") return 0;
  const px = parseCssPx(tok);
  if (px !== undefined) {
    if (px === 0) return 0;
    if (boxCssWidth !== undefined && boxCssWidth > 0) return px / boxCssWidth;
  }
  return undefined;
}

function parseGradientVisibleColors(
  rawLayer: string,
  currentColor: ParsedRgba | null | undefined,
  boxCssWidth: number | undefined,
): ParsedRgba[] | null {
  const m = GRADIENT_FN_RE.exec(rawLayer.trim());
  if (!m) return null;
  const isRepeating = Boolean(m[1]);
  const isConic = m[2].toLowerCase() === "conic";
  const args = splitTopLevel(m[3], 44);
  if (args.length === 0) return null;

  const stops: Array<{ color: ParsedRgba; pos?: number }> = [];
  for (let i = 0; i < args.length; i++) {
    const toks = splitTopLevelTokens(args[i]);
    if (toks.length === 0) return null;
    if (toks.length === 1 && stops.length > 0) {
      const hint = parseStopPosition(toks[0], isConic, boxCssWidth);
      if (hint !== undefined) continue;
    }
    const color = parseCssRgba(toks[0], currentColor);
    if (!color) {
      if (i === 0) continue;
      return null;
    }
    if (toks.length === 1) {
      stops.push({ color });
    } else if (toks.length === 2) {
      stops.push({ color, pos: parseStopPosition(toks[1], isConic, boxCssWidth) });
    } else if (toks.length === 3) {
      const p1 = parseStopPosition(toks[1], isConic, boxCssWidth);
      const p2 = parseStopPosition(toks[2], isConic, boxCssWidth);
      stops.push({ color, pos: p1 }, { color, pos: p2 });
    } else {
      return null;
    }
  }

  if (stops.length === 0) return null;
  if (stops.length === 1) return [stops[0].color];

  if (stops[0].pos === undefined) stops[0].pos = 0;
  let maxPos = stops[0].pos;
  for (let i = 1; i < stops.length; i++) {
    const p = stops[i].pos;
    if (p !== undefined) {
      if (p < maxPos) stops[i].pos = maxPos;
      else maxPos = p;
    }
  }
  const lastIdx = stops.length - 1;
  if (stops[lastIdx].pos === undefined) stops[lastIdx].pos = Math.max(1, maxPos);
  let anchor = 0;
  for (let i = 1; i <= lastIdx; i++) {
    if (stops[i].pos !== undefined) {
      const gap = i - anchor;
      if (gap > 1) {
        const pStart = stops[anchor].pos!;
        const pStep = (stops[i].pos! - pStart) / gap;
        for (let k = anchor + 1; k < i; k++) stops[k].pos = pStart + pStep * (k - anchor);
      }
      anchor = i;
    }
  }

  const cycleSpan = stops[lastIdx].pos! - stops[0].pos!;
  const visibleColors: ParsedRgba[] = [];
  for (let i = 0; i < lastIdx; i++) {
    const p0 = stops[i].pos!;
    const p1 = stops[i + 1].pos!;
    const relSpan = isRepeating
      ? cycleSpan > 0
        ? (p1 - p0) / cycleSpan
        : 0
      : Math.max(0, Math.min(1, p1) - Math.max(0, p0));
    if (relSpan < 0.05) continue;
    const c0 = stops[i].color;
    const c1 = stops[i + 1].color;
    visibleColors.push(c0, c1);
    const midA = 0.5 * (c0.a + c1.a);
    if (midA > 0) {
      visibleColors.push({
        r: clampByte((0.5 * (c0.a * c0.r + c1.a * c1.r)) / midA),
        g: clampByte((0.5 * (c0.a * c0.g + c1.a * c1.g)) / midA),
        b: clampByte((0.5 * (c0.a * c0.b + c1.a * c1.b)) / midA),
        a: clampAlpha(midA),
      });
    }
  }
  return visibleColors;
}

function extractInlineGradientTokens(inlineStyle: string): string[] {
  const out: string[] = [];
  INLINE_BG_DECL_RE.lastIndex = 0;
  let match = INLINE_BG_DECL_RE.exec(inlineStyle);
  while (match !== null) {
    for (const layer of splitTopLevel(match[1], 44)) {
      for (const tok of splitTopLevelTokens(layer)) {
        if (GRADIENT_FN_RE.test(tok)) out.push(tok);
      }
    }
    match = INLINE_BG_DECL_RE.exec(inlineStyle);
  }
  return out;
}

function getClipLayers(
  st: Readonly<Record<string, string>> | undefined,
  inlineStyle?: string,
): string[] {
  const rawClip = st?.["background-clip"]?.trim().toLowerCase();
  const rawWebkit = st?.["-webkit-background-clip"]?.trim().toLowerCase();
  const clips = rawClip ? splitTopLevel(rawClip, 44) : [];
  const wkClips = rawWebkit ? splitTopLevel(rawWebkit, 44) : [];
  const count = Math.max(clips.length, wkClips.length);
  if (count > 0) {
    const merged: string[] = [];
    for (let i = 0; i < count; i++) {
      const c = clips[i % (clips.length || 1)] ?? "border-box";
      const w = wkClips[i % (wkClips.length || 1)] ?? "border-box";
      merged.push(c === "text" || w === "text" ? "text" : c);
    }
    return merged;
  }
  return inlineStyle && INLINE_BG_CLIP_TEXT_RE.test(inlineStyle) ? ["text"] : ["border-box"];
}

function isInteractiveFactsNode(item: DecodedNode): boolean {
  const tag = item.tag.toLowerCase();
  if (tag.startsWith("#")) return false;
  if (tag === "input") return (item.attrs.type ?? "").toLowerCase() !== "hidden";
  if (tag === "a") return "href" in item.attrs || item.clickable === true;
  if (INTERACTIVE_OR_VISUAL_TAGS.has(tag)) return true;
  const role = (item.attrs.role ?? "").trim().toLowerCase();
  if (role && INTERACTIVE_ARIA_ROLES.has(role)) return true;
  if (item.clickable === true) return true;
  if ("contenteditable" in item.attrs) {
    const ce = (item.attrs.contenteditable ?? "").trim().toLowerCase();
    if (ce === "" || ce === "true" || ce === "plaintext-only") return true;
  }
  return false;
}

type StealthKind = "container" | "microbox" | "textstyle";

type OwnBg = ParsedRgba | "image" | "barrier";

function applyStealthPromptInjectionExclusions<T extends DecodedNode>(
  input: readonly T[],
  nodes: ReadonlyMap<number, T>,
  excludedBackendNodeIds: Set<number>,
  explicitLayoutScale?: number,
): void {
  const colorCache = new Map<string, ParsedRgba | null>();
  const parseCachedColor = (raw: string | undefined): ParsedRgba | null => {
    if (!raw) return null;
    const hit = colorCache.get(raw);
    if (hit !== undefined) return hit;
    const parsed = parseCssRgba(raw) ?? null;
    if (!raw.toLowerCase().includes("currentcolor")) {
      colorCache.set(raw, parsed);
    }
    return parsed;
  };

  const fgMemo = new Map<number, ParsedRgba | null>();
  const resolveNodeFgColor = (id: number, depth = 0): ParsedRgba | null => {
    if (depth > 64) return null;
    const hit = fgMemo.get(id);
    if (hit !== undefined) return hit;
    const n = nodes.get(id);
    const raw = n?.layout?.styles?.color;
    if (!raw) {
      fgMemo.set(id, null);
      return null;
    }
    if (!raw.toLowerCase().includes("currentcolor")) {
      const parsed = parseCachedColor(raw);
      fgMemo.set(id, parsed);
      return parsed;
    }
    const parentFg =
      n.parentBackendNodeId !== null ? resolveNodeFgColor(n.parentBackendNodeId, depth + 1) : null;
    const parsed = parseCssRgba(raw, parentFg) ?? null;
    fgMemo.set(id, parsed);
    return parsed;
  };

  const hasExplicitScale =
    explicitLayoutScale !== undefined &&
    Number.isFinite(explicitLayoutScale) &&
    explicitLayoutScale > 0;
  let htmlExactScale: number | undefined;
  let htmlFallbackScale: number | undefined;
  let bodyScale: number | undefined;

  if (!hasExplicitScale) {
    for (let i = 0; i < input.length && htmlExactScale === undefined; i++) {
      const item = input[i];
      const t = item.tag.toLowerCase();
      if (t !== "html" && t !== "body") continue;
      const b = item.layout?.bounds;
      const st = item.layout?.styles;
      if (!st || !b || b.length < 4 || b[2] < 100 || !Number.isFinite(b[2])) continue;
      const cssW = parseCssPx(st.width);
      if (cssW === undefined || cssW < 50) continue;
      const rx = b[2] / cssW;
      if (!Number.isFinite(rx) || rx < 0.25 || rx > 8) continue;
      const cssH = parseCssPx(st.height);
      const skewFree =
        cssH !== undefined &&
        cssH >= 50 &&
        Number.isFinite(b[3]) &&
        b[3] > 0 &&
        Math.abs(rx - b[3] / cssH) <= 0.05 * Math.max(rx, b[3] / cssH);
      if (t === "html") {
        if (skewFree) htmlExactScale = rx;
        else htmlFallbackScale ??= rx;
      } else if (skewFree) {
        bodyScale ??= rx;
      } else {
        htmlFallbackScale ??= rx;
      }
    }
  }

  const scale = hasExplicitScale
    ? explicitLayoutScale
    : (htmlExactScale ?? htmlFallbackScale ?? bodyScale ?? 1);

  let hasAnyOpaqueBg = false;
  const ownBgByNode = new Map<number, OwnBg>();
  for (let i = 0; i < input.length; i++) {
    const item = input[i];
    const layout = item.layout;
    const st = layout?.styles;
    if (!st) continue;

    const clipLayers = getClipLayers(st, item.attrs.style);
    const rawBgImg = st["background-image"]?.trim();
    if (
      rawBgImg &&
      rawBgImg !== "none" &&
      rawBgImg !== "initial" &&
      rawBgImg !== "inherit" &&
      rawBgImg !== "unset"
    ) {
      const imgLayers = splitTopLevel(rawBgImg.toLowerCase(), 44);
      let hasNonTextImageLayer = false;
      let uniformGradBg: ParsedRgba | undefined;
      const boxCssW =
        parseCssPx(st.width) ?? (layout.bounds?.[2] ? layout.bounds[2] / scale : undefined);
      for (let k = 0; k < imgLayers.length; k++) {
        const layer = imgLayers[k];
        if (!layer || layer === "none" || layer === "initial") continue;
        if (clipLayers[k % clipLayers.length] === "text") continue;
        if (IMAGE_FN_RE.test(layer)) {
          hasNonTextImageLayer = true;
          break;
        }
        const gradColors = parseGradientVisibleColors(
          layer,
          resolveNodeFgColor(item.backendNodeId),
          boxCssW,
        );
        if (gradColors === null) {
          if (GRADIENT_FN_RE.test(layer)) {
            hasNonTextImageLayer = true;
            break;
          }
          continue;
        }
        if (!gradColors.some((c) => c.a >= 0.15)) continue;
        if (
          !uniformGradBg &&
          gradColors.every((c) => c.a >= 0.9 && isZeroContrast(c, gradColors[0]))
        ) {
          uniformGradBg = gradColors[0];
        } else {
          hasNonTextImageLayer = true;
          break;
        }
      }
      if (hasNonTextImageLayer) {
        ownBgByNode.set(item.backendNodeId, "image");
        continue;
      }
      if (uniformGradBg) {
        ownBgByNode.set(item.backendNodeId, uniformGradBg);
        hasAnyOpaqueBg = true;
        continue;
      }
    }

    if (clipLayers[clipLayers.length - 1] === "text") continue;
    const rawBg = st["background-color"];
    if (!rawBg || rawBg === "rgba(0, 0, 0, 0)" || rawBg === "transparent") continue;
    const parsed = rawBg.toLowerCase().includes("currentcolor")
      ? (parseCssRgba(rawBg, resolveNodeFgColor(item.backendNodeId)) ?? null)
      : parseCachedColor(rawBg);
    if (parsed) {
      if (parsed.a >= 0.9) {
        ownBgByNode.set(item.backendNodeId, parsed);
        hasAnyOpaqueBg = true;
      } else if (parsed.a >= 0.15) {
        ownBgByNode.set(item.backendNodeId, "barrier");
      }
    } else if (isUnresolvedColorBarrier(rawBg)) {
      ownBgByNode.set(item.backendNodeId, "barrier");
    }
  }

  const bgMemo = new Map<number, ParsedRgba | null>();
  const resolveEffectiveBg = (id: number): ParsedRgba | null => {
    if (!hasAnyOpaqueBg) return null;
    const directMemo = bgMemo.get(id);
    if (directMemo !== undefined) return directMemo;
    const node = nodes.get(id);
    if (!node) return null;
    const own = ownBgByNode.get(id);
    if (own !== undefined) {
      const resolved = own === "image" || own === "barrier" ? null : own;
      bgMemo.set(id, resolved);
      return resolved;
    }
    const parentId = node.parentBackendNodeId;
    if (parentId === null) {
      bgMemo.set(id, null);
      return null;
    }
    const parentMemo = bgMemo.get(parentId);
    if (parentMemo !== undefined) {
      bgMemo.set(id, parentMemo);
      return parentMemo;
    }
    const chain: number[] = [id];
    let cur: T | undefined = nodes.get(parentId);
    let found: ParsedRgba | null = null;
    let guard = 0;
    while (cur && guard++ < 128) {
      const m = bgMemo.get(cur.backendNodeId);
      if (m !== undefined) {
        found = m;
        break;
      }
      const curOwn = ownBgByNode.get(cur.backendNodeId);
      if (curOwn !== undefined) {
        found = curOwn === "image" || curOwn === "barrier" ? null : curOwn;
        bgMemo.set(cur.backendNodeId, found);
        break;
      }
      chain.push(cur.backendNodeId);
      cur = cur.parentBackendNodeId === null ? undefined : nodes.get(cur.parentBackendNodeId);
    }
    for (let i = 0; i < chain.length; i++) bgMemo.set(chain[i], found);
    return found;
  };

  const hasVisibleSelfGradientTextClip = (cur: T): boolean => {
    const st = cur.layout?.styles;
    const inlineStyle = cur.attrs.style;
    const clipLayers = getClipLayers(st, inlineStyle);
    if (!clipLayers.includes("text")) return false;

    const textGradLayers: string[] = [];
    const rawBgImg = st?.["background-image"]?.trim().toLowerCase();
    if (
      rawBgImg &&
      rawBgImg !== "none" &&
      rawBgImg !== "initial" &&
      rawBgImg !== "inherit" &&
      rawBgImg !== "unset"
    ) {
      const imgLayers = splitTopLevel(rawBgImg, 44);
      for (let k = 0; k < imgLayers.length; k++) {
        if (clipLayers[k % clipLayers.length] === "text") textGradLayers.push(imgLayers[k]);
      }
    } else if (inlineStyle && INLINE_BG_CLIP_TEXT_RE.test(inlineStyle)) {
      textGradLayers.push(...extractInlineGradientTokens(inlineStyle.toLowerCase()));
    }
    if (textGradLayers.length === 0) return false;

    const own = ownBgByNode.get(cur.backendNodeId);
    const backdrop =
      own && own !== "image" && own !== "barrier"
        ? own
        : cur.parentBackendNodeId !== null
          ? resolveEffectiveBg(cur.parentBackendNodeId)
          : null;
    const curFg = resolveNodeFgColor(cur.backendNodeId);
    const boxCssW =
      parseCssPx(st?.width) ?? (cur.layout?.bounds?.[2] ? cur.layout.bounds[2] / scale : undefined);

    for (let i = 0; i < textGradLayers.length; i++) {
      const colors = parseGradientVisibleColors(textGradLayers[i], curFg, boxCssW);
      if (!colors || colors.length === 0) continue;
      for (let j = 0; j < colors.length; j++) {
        const c = colors[j];
        if (c.a < 0.05) continue;
        if (
          !backdrop ||
          backdrop.a < 0.9 ||
          !isZeroContrast(compositeOver(c, backdrop), backdrop)
        ) {
          return true;
        }
      }
    }
    return false;
  };

  const gradientTextMemo = new Map<number, boolean>();
  const hasGradientTextPaint = (id: number): boolean => {
    const cached = gradientTextMemo.get(id);
    if (cached !== undefined) return cached;
    let cur: T | undefined = nodes.get(id);
    let found = false;
    let guard = 0;
    while (cur && guard++ < 128) {
      const m = gradientTextMemo.get(cur.backendNodeId);
      if (m !== undefined) {
        found = m;
        break;
      }
      if (hasVisibleSelfGradientTextClip(cur)) {
        found = true;
        break;
      }
      if (ownBgByNode.has(cur.backendNodeId)) {
        found = false;
        break;
      }
      cur = cur.parentBackendNodeId === null ? undefined : nodes.get(cur.parentBackendNodeId);
    }
    gradientTextMemo.set(id, found);
    return found;
  };

  const isScrollOverflow = (v: string | undefined): boolean =>
    v === "auto" || v === "scroll" || v === "overlay";
  const scrollAxesOf = (n: T): { scrollX: boolean; scrollY: boolean } | null => {
    const t = n.tag.toLowerCase();
    if (t === "html" || t.startsWith("#")) return null;
    const st = n.layout?.styles;
    const ox = st?.["overflow-x"] || undefined;
    const oy = st?.["overflow-y"] || undefined;
    let scrollX = false;
    let scrollY = false;
    if (ox !== undefined || oy !== undefined) {
      scrollX = isScrollOverflow(ox);
      scrollY = isScrollOverflow(oy);
    } else if (n.attrs.style) {
      scrollX = INLINE_SCROLL_OVERFLOW_X_RE.test(n.attrs.style);
      scrollY = INLINE_SCROLL_OVERFLOW_Y_RE.test(n.attrs.style);
    }
    if (!scrollX && !scrollY) return null;
    if (t === "body") {
      const parent = n.parentBackendNodeId !== null ? nodes.get(n.parentBackendNodeId) : undefined;
      if (!parent || parent.tag.toLowerCase() !== "html") return null;
      const pst = parent.layout?.styles;
      const pox = pst?.["overflow-x"] || "visible";
      const poy = pst?.["overflow-y"] || "visible";
      if (pox === "visible" && poy === "visible") return null;
    }
    return { scrollX, scrollY };
  };
  const isExplainedByInnerScroll = (
    item: T,
    bounds: number[],
    offX: boolean,
    offY: boolean,
  ): boolean => {
    if (item.parentBackendNodeId === null) return false;
    const pos = (item.layout?.styles?.position || item.position || "static").toLowerCase();
    if (pos === "fixed" || pos === "sticky") return false;
    let remX = offX;
    let remY = offY;
    let hasPositionedAncestor = false;
    let cur: T | undefined = nodes.get(item.parentBackendNodeId);
    let guard = 0;
    while (cur && guard++ < 128) {
      const curPos = (cur.layout?.styles?.position || cur.position || "static").toLowerCase();
      if (curPos !== "static") hasPositionedAncestor = true;
      const axes = scrollAxesOf(cur);
      if (axes && (pos !== "absolute" || hasPositionedAncestor)) {
        const sr = cur.layout?.scrollRect;
        const cb = cur.layout?.bounds;
        if (sr && sr.length >= 2) {
          if (
            remX &&
            axes.scrollX &&
            sr[0] > 0 &&
            bounds[0] + bounds[2] >= (cb?.[0] ?? 0) - sr[0] * scale - 500 * scale
          ) {
            remX = false;
          }
          if (
            remY &&
            axes.scrollY &&
            sr[1] > 0 &&
            bounds[1] + bounds[3] >= (cb?.[1] ?? 0) - sr[1] * scale - 500 * scale
          ) {
            remY = false;
          }
        } else if (pos === "static") {
          const extremeThreshold = -4000 * scale;
          if (remX && axes.scrollX && bounds[0] + bounds[2] > extremeThreshold) remX = false;
          if (remY && axes.scrollY && bounds[1] + bounds[3] > extremeThreshold) remY = false;
        }
        if (!remX && !remY) return true;
      }
      cur = cur.parentBackendNodeId === null ? undefined : nodes.get(cur.parentBackendNodeId);
    }
    return false;
  };

  let hasInheritedZeroContrast = false;
  const offscreenTextNodes: T[] = [];
  const candidates: Array<{
    node: T;
    order: number;
    kind: StealthKind;
    boxScale?: number;
    inheritedZeroContrast?: boolean;
  }> = [];
  for (let i = 0; i < input.length; i++) {
    const item = input[i];
    if (item.tag.charCodeAt(0) === 35) {
      const tb = item.layout?.bounds;
      if (
        tb &&
        tb.length >= 4 &&
        (item.tag === "#text" || item.tag === "#cdata-section") &&
        !excludedBackendNodeIds.has(item.backendNodeId)
      ) {
        const offscreenThreshold = -500 * scale;
        const offX = tb[0] + tb[2] < offscreenThreshold;
        const offY = tb[1] + tb[3] < offscreenThreshold;
        if (offX || offY) {
          const parentEl =
            item.parentBackendNodeId !== null ? nodes.get(item.parentBackendNodeId) : undefined;
          if (!parentEl || !isExplainedByInnerScroll(parentEl, tb, offX, offY)) {
            offscreenTextNodes.push(item);
          }
        }
      }
      continue;
    }
    if (excludedBackendNodeIds.has(item.backendNodeId)) continue;
    const styles = item.layout?.styles;
    const inlineStyle = item.attrs.style;
    if (!styles && !inlineStyle) continue;

    const tag = item.tag.toLowerCase();
    if (STEALTH_SKIP_SHELL_TAGS.has(tag)) continue;

    let kind: StealthKind | undefined;
    let boxScale: number | undefined;
    let inheritedZeroContrast = false;

    const rawOpacity =
      styles?.opacity || (inlineStyle ? INLINE_OPACITY_RE.exec(inlineStyle)?.[1] : undefined);
    if (rawOpacity && rawOpacity !== "1") {
      const op = Number.parseFloat(rawOpacity);
      if (Number.isFinite(op) && op < 0.05) kind = "container";
    }

    const bounds = item.layout?.bounds;
    if (
      !kind &&
      bounds &&
      bounds.length >= 4 &&
      Number.isFinite(bounds[0]) &&
      Number.isFinite(bounds[1]) &&
      Number.isFinite(bounds[2]) &&
      Number.isFinite(bounds[3])
    ) {
      const offscreenThreshold = -500 * scale;
      const offX = bounds[0] + bounds[2] < offscreenThreshold;
      const offY = bounds[1] + bounds[3] < offscreenThreshold;
      if (offX || offY) {
        if (!isExplainedByInnerScroll(item, bounds, offX, offY)) {
          kind = "container";
        }
      } else if (bounds[2] > 0 && bounds[3] > 0) {
        const cssW = parseCssPx(styles?.width);
        const cssH = parseCssPx(styles?.height);
        const isCssMicrobox =
          cssW !== undefined &&
          cssH !== undefined &&
          cssW > 0 &&
          cssW < 2 &&
          cssH > 0 &&
          cssH < 2 &&
          bounds[2] <= cssW * 4 &&
          bounds[3] <= cssH * 4;
        if ((bounds[2] < 2 * scale && bounds[3] < 2 * scale) || isCssMicrobox) {
          const ox = styles?.["overflow-x"] || undefined;
          const oy = styles?.["overflow-y"] || undefined;
          if (ox !== undefined || oy !== undefined) {
            if (ox === "hidden" || ox === "clip" || oy === "hidden" || oy === "clip") {
              kind = "container";
            } else {
              kind = "microbox";
              boxScale = isCssMicrobox && cssW ? Math.max(scale, bounds[2] / cssW) : scale;
            }
          } else if (inlineStyle && INLINE_CLIP_OVERFLOW_RE.test(inlineStyle)) {
            kind = "container";
          } else {
            kind = "microbox";
            boxScale = isCssMicrobox && cssW ? Math.max(scale, bounds[2] / cssW) : scale;
          }
        }
      }
    }

    if (!kind) {
      const rawFontSize =
        styles?.["font-size"] ||
        (inlineStyle ? INLINE_FONT_SIZE_RE.exec(inlineStyle)?.[1] : undefined);
      if (
        rawFontSize &&
        rawFontSize !== "16px" &&
        rawFontSize !== "12px" &&
        rawFontSize !== "14px"
      ) {
        const fs = Number.parseFloat(rawFontSize);
        if (Number.isFinite(fs) && fs <= 1.5) kind = "textstyle";
      }
    }

    if (!kind && styles?.color) {
      const fg = resolveNodeFgColor(item.backendNodeId);
      if (fg) {
        if (fg.a < 0.05) {
          if (!hasGradientTextPaint(item.backendNodeId)) {
            kind = "textstyle";
          }
        } else if (fg.a >= 0.9 && hasAnyOpaqueBg) {
          const bg = resolveEffectiveBg(item.backendNodeId);
          if (bg && bg.a >= 0.9 && isZeroContrast(fg, bg)) {
            kind = "textstyle";
            if (ownBgByNode.get(item.backendNodeId) === undefined) {
              inheritedZeroContrast = true;
              hasInheritedZeroContrast = true;
            }
          }
        }
      }
    }

    if (kind) {
      candidates.push({
        node: item,
        order: i,
        kind,
        ...(boxScale !== undefined ? { boxScale } : {}),
        ...(inheritedZeroContrast ? { inheritedZeroContrast: true } : {}),
      });
    }
  }

  if (candidates.length === 0 && offscreenTextNodes.length === 0) return;

  const candidateKindById = new Map<number, { kind: StealthKind; boxScale?: number }>();
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    candidateKindById.set(c.node.backendNodeId, { kind: c.kind, boxScale: c.boxScale });
  }

  const childrenByParent = new Map<number, T[]>();
  const idToNode = new Map<string, T>();
  const ariaRefIds = new Set<string>();
  const interactiveIds = new Set<number>();

  for (let i = 0; i < input.length; i++) {
    const item = input[i];
    if (item.parentBackendNodeId !== null) {
      let list = childrenByParent.get(item.parentBackendNodeId);
      if (!list) {
        list = [];
        childrenByParent.set(item.parentBackendNodeId, list);
      }
      list.push(item);
    }
    const idAttr = item.attrs.id?.trim();
    if (idAttr) idToNode.set(idAttr, item);
    if (isInteractiveFactsNode(item)) {
      interactiveIds.add(item.backendNodeId);
    }
    if (
      !excludedBackendNodeIds.has(item.backendNodeId) &&
      (interactiveIds.has(item.backendNodeId) || !candidateKindById.has(item.backendNodeId))
    ) {
      const labelledBy = item.attrs["aria-labelledby"];
      if (labelledBy) {
        for (const tok of labelledBy.split(/\s+/)) if (tok) ariaRefIds.add(tok);
      }
      const describedBy = item.attrs["aria-describedby"];
      if (describedBy) {
        for (const tok of describedBy.split(/\s+/)) if (tok) ariaRefIds.add(tok);
      }
    }
  }

  const hasInteractiveDescendant = new Set<number>();
  for (const intId of interactiveIds) {
    let cur = nodes.get(intId)?.parentBackendNodeId ?? null;
    let guard = 0;
    while (cur !== null && !hasInteractiveDescendant.has(cur) && guard++ < 512) {
      hasInteractiveDescendant.add(cur);
      cur = nodes.get(cur)?.parentBackendNodeId ?? null;
    }
  }

  const subtreeTextLenMemo = new Map<number, number>();
  const subtreeTextLen = (id: number, visiting: Set<number>): number => {
    const cached = subtreeTextLenMemo.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return 0;
    const n = nodes.get(id);
    if (!n) return 0;
    visiting.add(id);
    let own = n.textContent ? n.textContent.replace(/\s+/g, " ").trim().length : 0;
    const kids = childrenByParent.get(id);
    if (own === 0 && kids) {
      for (let i = 0; i < kids.length; i++) {
        const ch = kids[i];
        if ((ch.tag === "#text" || ch.tag === "#cdata-section") && ch.textContent) {
          own += ch.textContent.replace(/\s+/g, " ").trim().length;
        }
      }
    }
    let total = own;
    if (kids) {
      for (let i = 0; i < kids.length; i++) {
        const ch = kids[i];
        if (ch.tag.startsWith("#")) continue;
        total += subtreeTextLen(ch.backendNodeId, visiting);
        if (total > MAX_SR_ONLY_LABEL_CHARS + 1) break;
      }
    }
    visiting.delete(id);
    subtreeTextLenMemo.set(id, total);
    return total;
  };

  const subtreeLabelAttrMemo = new Map<number, boolean>();
  const subtreeHasLabelAttr = (id: number, visiting: Set<number>): boolean => {
    const cached = subtreeLabelAttrMemo.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return false;
    const n = nodes.get(id);
    if (!n) return false;
    const a = n.attrs;
    if (
      a["aria-label"]?.trim() ||
      a["aria-description"]?.trim() ||
      a["aria-roledescription"]?.trim() ||
      a["aria-valuetext"]?.trim() ||
      a.alt?.trim() ||
      a.title?.trim() ||
      a.placeholder?.trim()
    ) {
      subtreeLabelAttrMemo.set(id, true);
      return true;
    }
    visiting.add(id);
    let found = false;
    for (const ch of childrenByParent.get(id) ?? []) {
      if (ch.tag.startsWith("#")) continue;
      if (subtreeHasLabelAttr(ch.backendNodeId, visiting)) {
        found = true;
        break;
      }
    }
    visiting.delete(id);
    subtreeLabelAttrMemo.set(id, found);
    return found;
  };

  const exemptSubtreeIds = new Set<number>();
  const markExemptSubtree = (rootId: number): void => {
    const queue = [rootId];
    while (queue.length > 0) {
      const curId = queue.pop()!;
      if (exemptSubtreeIds.has(curId)) continue;
      exemptSubtreeIds.add(curId);
      for (const ch of childrenByParent.get(curId) ?? []) {
        queue.push(ch.backendNodeId);
      }
    }
  };

  for (const refId of ariaRefIds) {
    const target = idToNode.get(refId);
    if (target && subtreeTextLen(target.backendNodeId, new Set()) <= MAX_SR_ONLY_LABEL_CHARS) {
      markExemptSubtree(target.backendNodeId);
    }
  }

  for (let i = 0; i < input.length; i++) {
    const item = input[i];
    if (
      item.tag.toLowerCase() === "label" &&
      item.attrs.for?.trim() &&
      subtreeTextLen(item.backendNodeId, new Set()) <= MAX_SR_ONLY_LABEL_CHARS
    ) {
      markExemptSubtree(item.backendNodeId);
    }
  }

  const hasInteractiveAncestor = (id: number): boolean => {
    let cur = nodes.get(id)?.parentBackendNodeId ?? null;
    let guard = 0;
    while (cur !== null && guard++ < 64) {
      if (interactiveIds.has(cur)) return true;
      cur = nodes.get(cur)?.parentBackendNodeId ?? null;
    }
    return false;
  };

  const hasOverflowingVisibleChild = (id: number, minScale: number): boolean => {
    const minDim = 2 * minScale;
    const stack = [...(childrenByParent.get(id) ?? [])];
    let guard = 0;
    while (stack.length > 0 && guard++ < 256) {
      const ch = stack.pop()!;
      if (ch.tag.startsWith("#")) continue;
      const b = ch.layout?.bounds;
      if (b && b.length >= 4 && b[2] >= minDim && b[3] >= minDim) return true;
      for (const grand of childrenByParent.get(ch.backendNodeId) ?? []) stack.push(grand);
    }
    return false;
  };

  const hasNonStealthElementDescendant = (id: number): boolean => {
    const stack = [...(childrenByParent.get(id) ?? [])];
    let guard = 0;
    while (stack.length > 0 && guard++ < 512) {
      const ch = stack.pop()!;
      const chId = ch.backendNodeId;
      if (ch.tag.startsWith("#") || STEALTH_SKIP_SHELL_TAGS.has(ch.tag.toLowerCase())) continue;
      if (excludedBackendNodeIds.has(chId)) continue;
      if (!ch.layout || ch.layout.styles.display === "none") continue;
      const candInfo = candidateKindById.get(chId);
      if (candInfo?.kind === "container") continue;
      const vis = ch.layout.styles.visibility;
      const selfHidden =
        vis === "hidden" ||
        vis === "collapse" ||
        candInfo?.kind === "textstyle" ||
        (candInfo?.kind === "microbox" &&
          !hasOverflowingVisibleChild(chId, candInfo.boxScale ?? scale));
      if (!selfHidden) return true;
      for (const grand of childrenByParent.get(chId) ?? []) stack.push(grand);
    }
    return false;
  };

  const excludeSubtree = (rootId: number): void => {
    const queue = [rootId];
    while (queue.length > 0) {
      const curId = queue.pop()!;
      if (
        excludedBackendNodeIds.has(curId) ||
        interactiveIds.has(curId) ||
        hasInteractiveDescendant.has(curId) ||
        exemptSubtreeIds.has(curId)
      ) {
        continue;
      }
      excludedBackendNodeIds.add(curId);
      for (const ch of childrenByParent.get(curId) ?? []) {
        queue.push(ch.backendNodeId);
      }
    }
  };

  let mediaBackdrops:
    | Array<{ x: number; y: number; r: number; b: number; paintOrder: number; order: number }>
    | undefined;
  if (hasInheritedZeroContrast) {
    mediaBackdrops = [];
    const minMediaDim = 8 * scale;
    for (let i = 0; i < input.length; i++) {
      const m = input[i];
      const mTag = m.tag.toLowerCase();
      const isMediaEl = mTag === "img" || mTag === "video" || mTag === "canvas";
      const isBgImgEl = ownBgByNode.get(m.backendNodeId) === "image";
      if (!isMediaEl && !isBgImgEl) continue;
      const mb = m.layout?.bounds;
      if (!mb || mb.length < 4 || mb[2] < minMediaDim || mb[3] < minMediaDim) continue;
      mediaBackdrops.push({
        x: mb[0],
        y: mb[1],
        r: mb[0] + mb[2],
        b: mb[1] + mb[3],
        paintOrder: m.paintOrder,
        order: i,
      });
    }
  }

  const overlapsUnderneathMedia = (cand: T, candOrder: number): boolean => {
    if (!mediaBackdrops || mediaBackdrops.length === 0) return false;
    const cb = cand.layout?.bounds;
    if (!cb || cb.length < 4 || cb[2] <= 0 || cb[3] <= 0) return false;
    const cx = cb[0];
    const cy = cb[1];
    const cr = cx + cb[2];
    const cbot = cy + cb[3];
    for (let i = 0; i < mediaBackdrops.length; i++) {
      const m = mediaBackdrops[i];
      if (
        m.paintOrder > cand.paintOrder ||
        (m.paintOrder === cand.paintOrder && m.order >= candOrder)
      ) {
        continue;
      }
      const ox = Math.min(cr, m.r) - Math.max(cx, m.x);
      const oy = Math.min(cbot, m.b) - Math.max(cy, m.y);
      if (ox > scale && oy > scale) return true;
    }
    return false;
  };

  for (const {
    node: cand,
    order: candOrder,
    kind,
    boxScale,
    inheritedZeroContrast,
  } of candidates) {
    const id = cand.backendNodeId;
    if (
      excludedBackendNodeIds.has(id) ||
      interactiveIds.has(id) ||
      hasInteractiveDescendant.has(id) ||
      exemptSubtreeIds.has(id)
    ) {
      continue;
    }
    const textLen = subtreeTextLen(id, new Set());
    if (textLen === 0 && !subtreeHasLabelAttr(id, new Set())) {
      continue;
    }
    if (inheritedZeroContrast && overlapsUnderneathMedia(cand, candOrder)) {
      markExemptSubtree(id);
      continue;
    }
    if (hasInteractiveAncestor(id) && textLen <= MAX_SR_ONLY_LABEL_CHARS) {
      markExemptSubtree(id);
      continue;
    }
    if (kind === "microbox" && hasOverflowingVisibleChild(id, boxScale ?? scale)) {
      continue;
    }
    if (kind === "textstyle" && hasNonStealthElementDescendant(id)) {
      cand.textContent = undefined;
      for (const ch of childrenByParent.get(id) ?? []) {
        if (ch.tag === "#text" || ch.tag === "#cdata-section") {
          excludedBackendNodeIds.add(ch.backendNodeId);
        }
      }
      continue;
    }
    excludeSubtree(id);
  }

  if (offscreenTextNodes.length > 0) {
    const dirtyParents = new Set<number>();
    for (let i = 0; i < offscreenTextNodes.length; i++) {
      const txt = offscreenTextNodes[i];
      const tid = txt.backendNodeId;
      if (excludedBackendNodeIds.has(tid) || exemptSubtreeIds.has(tid)) continue;
      const tlen = txt.textContent ? txt.textContent.replace(/\s+/g, " ").trim().length : 0;
      if (tlen === 0) continue;
      if (hasInteractiveAncestor(tid) && tlen <= MAX_SR_ONLY_LABEL_CHARS) continue;
      excludedBackendNodeIds.add(tid);
      if (txt.parentBackendNodeId !== null) dirtyParents.add(txt.parentBackendNodeId);
    }
    for (const pid of dirtyParents) {
      const parent = nodes.get(pid);
      if (!parent || parent.textContent === undefined) continue;
      const kept: string[] = [];
      for (const ch of childrenByParent.get(pid) ?? []) {
        if (
          (ch.tag === "#text" || ch.tag === "#cdata-section") &&
          !excludedBackendNodeIds.has(ch.backendNodeId) &&
          ch.textContent
        ) {
          const trimmed = ch.textContent.trim();
          if (trimmed) kept.push(trimmed);
        }
      }
      parent.textContent = kept.length > 0 ? kept.join(" ") : undefined;
    }
  }
}

/** Bounds retain their raw snapshot document layout units until normalization. */
export interface SnapshotLayout {
  readonly boundsSpace: "snapshot-document-layout";
  bounds?: number[];
  /** [scrollLeft, scrollTop, scrollWidth, scrollHeight], local CSS units. */
  scrollRect?: number[];
  /** [clientLeft, clientTop, clientWidth, clientHeight], untransformed local CSS units. */
  clientRect?: number[];
  styles: Readonly<Record<string, string>>;
}

export interface DecodedNode extends Omit<CapturedNode, "rect" | "localRect" | "rendered"> {
  nodeType?: number;
  parentMissing?: boolean;
  layout?: SnapshotLayout;
}

export interface NodeFacts extends CapturedNode {
  nodeType?: number;
  parentMissing?: boolean;
  layout?: SnapshotLayout;
}

export interface DocumentIndex<T extends DecodedNode = NodeFacts> {
  readonly nodes: ReadonlyMap<number, T>;
  readonly ancestryComplete?: ReadonlyMap<number, boolean>;
  readonly excludedBackendNodeIds: ReadonlySet<number>;
}

export interface DecodedDocument {
  nodes: DecodedNode[];
}

/** All snapshot nodes participate, including document and shadow roots. This
 * preserves overlay propagation when the semantic adapter omits those nodes. */
export async function buildDocumentIndex<T extends DecodedNode>(
  input: readonly T[],
  signal?: AbortSignal,
  includeVisualFacts = false,
  layoutScale?: number,
): Promise<DocumentIndex<T>> {
  const checkpoint = createCaptureCheckpoint(signal);
  const nodes = new Map<number, T>();
  const overlayByNode = new Map<number, boolean>();
  const ancestryComplete = includeVisualFacts ? new Map<number, boolean>() : undefined;
  const excludedBackendNodeIds = new Set<number>();
  for (let i = 0; i < input.length; i++) {
    if (i % 256 === 0) {
      const pending = checkpoint();
      if (pending) await pending;
    }
    const node = input[i];
    nodes.set(node.backendNodeId, node);
  }
  let work = 0;
  for (const node of input) {
    if (work++ % 256 === 0) {
      const pending = checkpoint();
      if (pending) await pending;
    }
    if (overlayByNode.has(node.backendNodeId)) continue;
    if (!ancestryComplete && !isDecodedOverlayHost(node)) {
      if (node.parentBackendNodeId === null) {
        overlayByNode.set(node.backendNodeId, false);
        continue;
      }
      const parentOverlay = overlayByNode.get(node.parentBackendNodeId);
      if (parentOverlay !== undefined) {
        overlayByNode.set(node.backendNodeId, parentOverlay);
        if (parentOverlay) excludedBackendNodeIds.add(node.backendNodeId);
        continue;
      }
    }
    const path: DecodedNode[] = [];
    const visiting = new Set<number>();
    let current: DecodedNode | undefined = node;
    let overlay = false;
    let complete = false;
    while (current && !overlayByNode.has(current.backendNodeId)) {
      if (work++ % 256 === 0) {
        const pending = checkpoint();
        if (pending) await pending;
      }
      if (visiting.has(current.backendNodeId)) {
        // Only an overlay inside the cycle may mark the cycle and its descendants.
        overlay = path
          .slice(path.findIndex((item) => item.backendNodeId === current!.backendNodeId))
          .some((item) => isDecodedOverlayHost(item));
        break;
      }
      visiting.add(current.backendNodeId);
      path.push(current);
      if (current.parentBackendNodeId === null) {
        if (ancestryComplete) complete = !current.parentMissing && current.nodeType === 9;
        current = undefined;
        break;
      }
      current = nodes.get(current.parentBackendNodeId);
    }
    if (current && overlayByNode.has(current.backendNodeId)) {
      overlay = overlayByNode.get(current.backendNodeId)!;
      if (ancestryComplete) complete = ancestryComplete.get(current.backendNodeId) === true;
    }
    for (let i = path.length - 1; i >= 0; i--) {
      if (work++ % 256 === 0) {
        const pending = checkpoint();
        if (pending) await pending;
      }
      const item = path[i];
      overlay = overlay || isDecodedOverlayHost(item);
      overlayByNode.set(item.backendNodeId, overlay);
      if (ancestryComplete) {
        complete = complete && !item.parentMissing;
        ancestryComplete.set(item.backendNodeId, complete);
      }
      if (overlay) excludedBackendNodeIds.add(item.backendNodeId);
    }
  }
  applyStealthPromptInjectionExclusions(input, nodes, excludedBackendNodeIds, layoutScale);
  return { nodes, ...(ancestryComplete ? { ancestryComplete } : {}), excludedBackendNodeIds };
}

export interface DocumentIdentity {
  attachmentId: string;
  target: CdpTarget;
  frameId: string;
  documentElementBackendNodeId: number;
}

/** Narrow input shared by the existing semantic scene/hover consumers. */
export interface CapturedSceneInput {
  nodes: CapturedNode[];
  viewport: Viewport;
  rootFrameId?: string;
  excludedBackendNodeIds: ReadonlySet<number>;
}

export interface CaptureIssue {
  /** Owner failure or inherited blockage; absent for other geometry failures. */
  projectionIssue?: FrameProjectionIssue;
  target: CdpTarget;
  frameId?: string;
  stage: "dom" | "ax" | "identity" | "ownership" | "geometry" | "forms";
  reason:
    | "document-changed"
    | "identity-unavailable"
    | "identity-unverified"
    | "capture-unavailable"
    | "frame-ownership-unresolved"
    | "geometry-unavailable";
}

/** Shared per document; never retain the live GeometryContext in published facts. */
export interface DocumentGeometry {
  readonly projections: readonly GeometryProjection[];
  readonly coordinates: SnapshotCoordinates;
  /** Visual viewport scale (pinch), distinct from browser UI zoom. */
  readonly pageScale?: number;
}

export interface DocumentFacts<T extends FrameOwnedAxNode> {
  readonly geometry?: DocumentGeometry;
  readonly frame: CdpFrame;
  readonly identity?: DocumentIdentity;
  readonly index: DocumentIndex;
  readonly domNodes: CapturedNode[];
  readonly axNodes: T[];
}

export interface ObservationFacts<T extends FrameOwnedAxNode> {
  /** Whether visual collection was enabled; partial capture failures remain in issues. */
  readonly visualFactsCollected: boolean;
  readonly rootFrameId: string;
  readonly viewport: Viewport;
  readonly documents: readonly DocumentFacts<T>[];
  readonly issues: readonly CaptureIssue[];
  readonly startedAt: number;
  readonly finishedAt: number;
}

export interface CapturedSurfaceProbe {
  triggerBackendNodeId: number;
  triggerPoint?: { x: number; y: number };
  triggerAction: "hover" | "focus" | string;
  subItems: string[];
  confidence?: "high" | "medium" | "low";
}

export type { CapturedNode } from "./capture-types";
