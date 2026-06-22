import {
  OVERLAY_MSG_INTERRUPT,
  type OverlayInterruptRequest,
  type OverlayInterruptResponse,
} from "@/lib/overlay-bridge";

const DEFAULT_TIMEOUT_MS = 2000;

export interface SendInterruptOptions {
  timeoutMs?: number;
}

/**
 * Round-trip an `overlay.interrupt` message to the background SW.
 *
 * Resolves to `{ ok: true }` only when the SW explicitly replies
 * with `ok: true`. All other outcomes — undefined reply, thrown
 * sendMessage, timeout — collapse to `{ ok: false }` so the caller
 * can take the same retract-and-retry path regardless of cause.
 *
 * The 2 s soft timeout matches the design doc: the user must never
 * wait longer than that to see the mask retract, even if the
 * daemon is unreachable. The cancellation itself is fire-and-forget
 * on the daemon side — a slow ack does not invalidate it.
 */
export async function sendInterrupt(
  sendMessage: (msg: OverlayInterruptRequest) => Promise<unknown>,
  sessionId: string,
  options: SendInterruptOptions = {},
): Promise<OverlayInterruptResponse> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const req: OverlayInterruptRequest = { kind: OVERLAY_MSG_INTERRUPT, sessionId };
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<OverlayInterruptResponse>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false }), timeoutMs);
  });
  const send = (async () => {
    try {
      const reply = (await sendMessage(req)) as OverlayInterruptResponse | undefined;
      return reply?.ok === true ? { ok: true } : { ok: false };
    } catch {
      return { ok: false };
    }
  })();
  const result = await Promise.race([send, timeout]);
  if (timer !== null) clearTimeout(timer);
  return result;
}
