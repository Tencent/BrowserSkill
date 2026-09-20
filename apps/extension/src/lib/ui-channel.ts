/**
 * Optional UI request channel for authenticated remote gateways.
 *
 * A gateway that runs tasks for a user usually renders its own view of the
 * running task: a small preview of the page the agent is working on, and a
 * control that brings that tab to the front. Both have to answer while the
 * session's tool queue is busy — during a long navigation, or while
 * `request_help` waits for the user — which is exactly when the ordinary tool
 * RPCs cannot run, because they are serialized per session.
 *
 * These requests are therefore answered here and never enter the tool
 * dispatcher. Attach this to the socket before `WSTransport` so a `ui.*` frame
 * is consumed by this listener instead of being reported as an unknown method.
 * Only authenticated remote sockets carry the channel; a local daemon socket
 * keeps the native protocol unchanged.
 */
export interface UiChannelHandlers {
  /** Activates the task's own tab and raises its window. Never starts a task. */
  focus(sessionId: string): Promise<unknown>;
  /** Returns one downscaled JPEG frame of the task's own tab. */
  preview(sessionId: string): Promise<unknown>;
}

export function attachUiChannel(socket: WebSocket, handlers: UiChannelHandlers): void {
  socket.addEventListener("message", (event) => {
    let request: { id?: unknown; method?: unknown; params?: { session_id?: unknown } };
    try {
      request = JSON.parse(event.data);
      if (!request || typeof request !== "object") return;
    } catch {
      return;
    }
    const methods: Record<string, (sessionId: string) => Promise<unknown>> = {
      "ui.task_focus": (id) => handlers.focus(id),
      "ui.task_preview": (id) => handlers.preview(id),
    };
    if (typeof request.method !== "string" || !Object.hasOwn(methods, request.method)) return;
    // The frame is ours: keep it away from the native transport listener.
    event.stopImmediatePropagation();
    if (typeof request.id !== "string" || !request.id) return;
    const id = request.id;
    const sessionId = request.params?.session_id;
    const send = (body: object) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ id, ...body }));
    };
    if (typeof sessionId !== "string" || !sessionId) {
      send({ error: { code: "invalid_params", message: "session_id is required" } });
      return;
    }
    void Promise.resolve()
      .then(() => methods[request.method as string]!(sessionId))
      .then(
        (result) => send({ result }),
        () => send({ error: { code: "not_found", message: "Browser task unavailable" } }),
      );
  });
}
