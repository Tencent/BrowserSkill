import type { ImageAttachmentRef } from "@deepseek-ai/dsh-attachment";
import { useEffect, useRef, useState } from "react";
import css from "./ScreenshotImage.module.css";

type ImageState = { status: "loading" } | { status: "error" } | { status: "ready"; url: string };

/** Plugin-owned presentation: DSH's attachment client no longer exports image components. */
export function ScreenshotImage({
  attachment,
  load,
}: {
  attachment: ImageAttachmentRef;
  load: (attachment: ImageAttachmentRef) => Promise<string>;
}) {
  const [image, setImage] = useState<ImageState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [open, setOpen] = useState(false);
  const label = attachment.name ?? "screenshot";

  useEffect(() => {
    let active = true;
    let url: string | undefined;
    setImage({ status: "loading" });
    setOpen(false);
    void load(attachment).then(
      (loaded) => {
        if (!active) URL.revokeObjectURL(loaded);
        else {
          url = loaded;
          setImage({ status: "ready", url: loaded });
        }
      },
      () => {
        if (active) setImage({ status: "error" });
      },
    );
    return () => {
      active = false;
      if (url !== undefined) URL.revokeObjectURL(url);
    };
  }, [attachment, load, attempt]);

  return (
    <>
      <div
        className={css.frame}
        style={{
          width: Math.min(attachment.width, 240, (240 * attachment.width) / attachment.height),
          aspectRatio: `${attachment.width} / ${attachment.height}`,
        }}
      >
        {image.status === "loading" ? (
          <span role="status">Loading…</span>
        ) : image.status === "error" ? (
          <button
            type="button"
            className={css.retry}
            onClick={() => setAttempt((value) => value + 1)}
          >
            Load failed — retry
          </button>
        ) : (
          <button
            type="button"
            className={css.thumbnail}
            title="Open the original screenshot"
            aria-label={`Open screenshot ${label}`}
            onClick={() => setOpen(true)}
          >
            <img
              src={image.url}
              alt={label}
              width={attachment.width}
              height={attachment.height}
              onError={() => setImage({ status: "error" })}
            />
          </button>
        )}
      </div>
      {open && image.status === "ready" && (
        <ScreenshotPreview src={image.url} label={label} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

function ScreenshotPreview({
  src,
  label,
  onClose,
}: {
  src: string;
  label: string;
  onClose(): void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={css.preview}
      aria-label="Screenshot preview"
      onClose={() => {
        // A Strict Mode effect replay can close and immediately reopen the dialog.
        if (!ref.current?.open) onClose();
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const { left, right, top, bottom } = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < left ||
          event.clientX > right ||
          event.clientY < top ||
          event.clientY > bottom
        )
          event.currentTarget.close();
      }}
    >
      <form method="dialog">
        <button type="submit" autoFocus>
          Close preview
        </button>
      </form>
      <img src={src} alt={label} />
    </dialog>
  );
}
