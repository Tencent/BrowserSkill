/** Range inputs also represent business data. Only explicitly named timelines
 * with an unambiguous media association may tolerate incidental progress. */
export interface PlaybackProgressControl {
  tag: string;
  role?: string;
  name?: string;
  attrs?: Readonly<Record<string, string>>;
  inForm: boolean;
}

const timelineName =
  /^(?:(?:playback|video|audio|media)\s+(?:progress|position|time(?:\s+scrubber)?|timeline)|seek(?:\s+(?:bar|slider))?|time scrubber|(?:播放|视频|音频)(?:进度|时间|位置|时间轴))$/i;

/** Explicit aria-controls wins; otherwise require exactly one media element.
 * Named/submitted controls, form members and unknown labels stay protected. */
export function playbackProgressMedia<T extends { id?: string }>(
  control: PlaybackProgressControl,
  media: readonly T[],
): T | undefined {
  const attrs = control.attrs ?? {};
  if (control.inForm || attrs.form !== undefined || attrs.name?.trim()) return;
  const nativeRange = control.tag === "input" && attrs.type?.toLowerCase() === "range";
  if (
    !nativeRange &&
    control.tag !== "progress" &&
    !["slider", "progressbar"].includes(control.role?.toLowerCase() ?? "")
  )
    return;
  if (!timelineName.test(control.name?.trim().replace(/\s+/g, " ") ?? "")) return;
  const controls = attrs["aria-controls"]?.trim().split(/\s+/).filter(Boolean);
  if (controls?.length) {
    if (controls.length !== 1) return;
    const matches = media.filter((item) => item.id === controls[0]);
    return matches.length === 1 ? matches[0] : undefined;
  }
  return media.length === 1 ? media[0] : undefined;
}
