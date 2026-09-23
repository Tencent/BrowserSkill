import {
  INPUT_PASSTHROUGH,
  INPUT_PASSTHROUGH_ATTR,
  INPUT_PASSTHROUGH_TTL_MS,
  type InputPassthroughAck,
  type InputPassthroughMessage,
} from "@/lib/input-passthrough-bridge";

export function createInputPassthroughController(getHost: () => HTMLElement | null) {
  const pending = new Map<string, { timer: ReturnType<typeof setTimeout>; expiresAt: number }>();
  const release = (id: string) => {
    const lease = pending.get(id);
    if (lease) clearTimeout(lease.timer);
    pending.delete(id);
  };
  const apply = (host: HTMLElement | null) => {
    // A suspended page can resume/remount before its overdue timers run.
    for (const [id, lease] of pending) {
      if (lease.expiresAt <= Date.now()) release(id);
    }
    host?.toggleAttribute(INPUT_PASSTHROUGH_ATTR, pending.size > 0);
  };

  return {
    get pendingCount() {
      return pending.size;
    },
    handleMessage(
      message: InputPassthroughMessage,
      sendResponse: (ack: InputPassthroughAck) => void,
    ): false {
      if (message.phase === "begin") {
        if (!pending.has(message.id)) {
          pending.set(message.id, {
            expiresAt: Date.now() + INPUT_PASSTHROUGH_TTL_MS,
            timer: setTimeout(() => {
              release(message.id);
              apply(getHost());
            }, INPUT_PASSTHROUGH_TTL_MS),
          });
        }
      } else release(message.id);
      apply(getHost());
      // Hit testing uses current styles; unlike screenshots it needs no compositor frame.
      sendResponse({ type: INPUT_PASSTHROUGH, ok: true });
      return false;
    },
    reset() {
      for (const id of pending.keys()) release(id);
      apply(getHost());
    },
    onHostMounted: apply,
  };
}
