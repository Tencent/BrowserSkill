import {
  OVERLAY_MSG_INTERRUPT,
  OVERLAY_MSG_RETURN_CONTROL,
  type OverlayInterruptRequest,
  type OverlayInterruptResponse,
  type OverlayReturnControlRequest,
  type OverlayReturnControlResponse,
} from "@/lib/overlay-bridge";

const DEFAULT_TIMEOUT_MS = 2000;

export interface SendInterruptOptions {
  timeoutMs?: number;
}

/**
 * Round-trip a `{ ok }`-shaped overlay message to the background SW.
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
async function roundTrip<TRequest>(
  sendMessage: (msg: TRequest) => Promise<unknown>,
  req: TRequest,
  timeoutMs: number,
): Promise<OverlayInterruptResponse> {
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

export async function sendInterrupt(
  sendMessage: (msg: OverlayInterruptRequest) => Promise<unknown>,
  sessionId: string,
  options: SendInterruptOptions = {},
): Promise<OverlayInterruptResponse> {
  const req: OverlayInterruptRequest = { kind: OVERLAY_MSG_INTERRUPT, sessionId };
  return roundTrip(sendMessage, req, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
}

/**
 * Hand control back to the agent: the background tells the daemon
 * (`session.control_returned`) to unblock it and flips the overlay back to
 * `control`. `{ ok: false }` means the session is gone (or the SW is
 * unreachable), in which case the caller clears its overlay.
 */
export async function sendReturnControl(
  sendMessage: (msg: OverlayReturnControlRequest) => Promise<unknown>,
  sessionId: string,
  note: string,
  options: SendInterruptOptions = {},
): Promise<OverlayReturnControlResponse> {
  const req: OverlayReturnControlRequest = {
    kind: OVERLAY_MSG_RETURN_CONTROL,
    sessionId,
    note,
  };
  return roundTrip(sendMessage, req, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
}
