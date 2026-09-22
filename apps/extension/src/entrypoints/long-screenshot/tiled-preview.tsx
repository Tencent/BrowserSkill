import { useEffect, useRef, useState } from "react";
import { readTile, type TiledScreenshot } from "@/long-screenshot/tiles";

function Tile({
  shot,
  index,
  thumbnail,
}: {
  shot: TiledScreenshot;
  index: number;
  thumbnail: boolean;
}) {
  const [url, setUrl] = useState("");
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true,
      objectUrl = "";
    setUrl("");
    setFailed(false);
    void readTile(shot, index, thumbnail)
      .then((blob) => {
        if (!alive) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [shot, index, thumbnail]);
  return url ? (
    <img
      className="preview-image block w-full"
      src={url}
      alt=""
      draggable={false}
      style={{ height: "100%" }}
    />
  ) : (
    <div
      role={failed ? "alert" : undefined}
      className="h-full w-full bg-muted"
      data-tile-error={failed || undefined}
    />
  );
}

/** Only mount the visible strip plus one neighboring tile. A rebased scrollbar
 * also avoids CSS element-height limits for exceptionally long captures. */
export function TiledPreview({
  shot,
  zoom,
  label,
}: {
  shot: TiledScreenshot;
  zoom: string;
  label: string;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ width: 1000, height: 800, top: 0 });
  useEffect(() => {
    const node = container.current!;
    const measure = () =>
      setView({ width: node.clientWidth, height: node.clientHeight, top: node.scrollTop });
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    node.addEventListener("scroll", measure, { passive: true });
    measure();
    return () => {
      observer.disconnect();
      node.removeEventListener("scroll", measure);
    };
  }, []);
  const width =
    zoom === "fit"
      ? Math.max(1, Math.min(view.width - 32, 1100, shot.width))
      : shot.width * Number(zoom);
  const scale = width / shot.width;
  const total = shot.height * scale;
  const physical = Math.min(total, 8_000_000);
  const top =
    physical > view.height
      ? (view.top / (physical - view.height)) * Math.max(0, total - view.height)
      : 0;
  const tileHeight = shot.tileHeight * scale;
  const first = Math.max(0, Math.floor(top / tileHeight) - 1);
  const last = Math.min(
    Math.ceil(shot.height / shot.tileHeight),
    Math.ceil((top + view.height) / tileHeight) + 1,
  );
  return (
    <div
      ref={container}
      className="preview-canvas overflow-auto"
      role="img"
      aria-label={label}
      style={{ height: "calc(100vh - 150px)", minHeight: 240 }}
    >
      <div className="relative mx-auto bg-white shadow-lg" style={{ width, height: physical }}>
        {Array.from({ length: Math.max(0, last - first) }, (_, at) => {
          const index = first + at;
          const actual = Math.min(shot.tileHeight, shot.height - index * shot.tileHeight);
          return (
            <div
              key={index}
              data-tile-index={index}
              className="absolute left-0 w-full overflow-hidden"
              style={{ top: index * tileHeight - top + view.top, height: actual * scale }}
            >
              <div style={{ height: tileHeight }}>
                <Tile shot={shot} index={index} thumbnail={width <= 1200} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
