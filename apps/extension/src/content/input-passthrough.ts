import {
  INPUT_PASSTHROUGH,
  INPUT_PASSTHROUGH_ATTR,
  type InputPassthroughAck,
  type InputPassthroughMessage,
} from "@/lib/input-passthrough-bridge";

export function createInputPassthroughController(getHost: () => HTMLElement | null) {
  const pending = new Set<string>();
  const apply = (host: HTMLElement | null) =>
    host?.toggleAttribute(INPUT_PASSTHROUGH_ATTR, pending.size > 0);

  return {
    get pendingCount() {
      return pending.size;
    },
    handleMessage(
      message: InputPassthroughMessage,
      sendResponse: (ack: InputPassthroughAck) => void,
    ): false {
      if (message.phase === "begin") pending.add(message.id);
      else pending.delete(message.id);
      apply(getHost());
      // Hit testing uses current styles; unlike screenshots it needs no compositor frame.
      sendResponse({ type: INPUT_PASSTHROUGH, ok: true });
      return false;
    },
    onHostMounted: apply,
  };
}
