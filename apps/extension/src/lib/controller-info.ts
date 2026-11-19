/** Caller-supplied display labels; these never establish control authority. */
export interface ControllerInfo {
  name: string;
  project?: string | null;
  color?: string | null;
}

export function isControllerInfo(value: unknown): value is ControllerInfo {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const info = value as Partial<ControllerInfo>;
  const label = (text: unknown, max: number) =>
    typeof text === "string" &&
    text.trim().length > 0 &&
    Array.from(text).length <= max &&
    !/[\u0000-\u001f\u007f-\u009f]/.test(text);
  return (
    label(info.name, 80) &&
    (info.project == null || label(info.project, 120)) &&
    (info.color == null || (typeof info.color === "string" && /^#[0-9a-fA-F]{6}$/.test(info.color)))
  );
}

// Color complements the visible session ID; it is never the only identifier.
const COLORS = ["#2563eb", "#9333ea", "#0f766e", "#be185d", "#b45309", "#4d7c0f"];

export function controllerColor(
  sessionId: string,
  controller?: ControllerInfo,
  usedColors: Iterable<string | null | undefined> = [],
): string {
  if (controller?.color && /^#[0-9a-fA-F]{6}$/.test(controller.color)) return controller.color;
  let hash = 0;
  for (const char of sessionId) hash = (Math.imul(hash, 31) + char.codePointAt(0)!) >>> 0;
  const used = new Set(Array.from(usedColors, (color) => color?.toLowerCase()));
  const start = hash % COLORS.length;
  return (
    Array.from(
      { length: COLORS.length },
      (_, offset) => COLORS[(start + offset) % COLORS.length],
    ).find((color) => !used.has(color)) ?? COLORS[start]
  );
}
