import type { CdpDebuggee } from "@/browser-driver/chromium-cdp";
import type { CdpRunner } from "@/tools/shared";
import { sendToCdpTarget } from "@/tools/shared";
import { requestMetadata } from "./journal";
import { jsonPointer } from "./json-source";
import {
  BODY_CHARS,
  redactBody,
  redactHeaderEvidence,
  redactHeaders,
  redactRequestUrl,
  redactText,
  redactUrl,
} from "./redact";
import type { DebugBody, DebugIntervention, DebugRequest } from "./types";

export const MAX_REQUESTS = 200;
export const MAX_INFLIGHT = 200;
const MAX_BODY_CHARS = 512 * 1024;
const MAX_BODY_JOBS = 4;
const MAX_BODY_QUEUE = 32;

interface Response {
  status?: number;
  mimeType?: string;
  headers?: Record<string, string>;
  fromDiskCache?: boolean;
  fromServiceWorker?: boolean;
  timing?: Record<string, number>;
}
interface Event {
  requestId?: string;
  request?: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    postData?: string;
    hasPostData?: boolean;
  };
  response?: Response;
  redirectResponse?: Response;
  timestamp?: number;
  type?: string;
  frameId?: string;
  loaderId?: string;
  errorText?: string;
  encodedDataLength?: number;
  dataLength?: number;
  headers?: Record<string, string>;
  statusCode?: number;
  hasExtraInfo?: boolean;
  redirectHasExtraInfo?: boolean;
  initiator?: {
    type?: string;
    stack?: { callFrames?: { url?: string; lineNumber?: number; functionName?: string }[] };
  };
}
interface RequestRecord {
  entry: DebugRequest;
  rawId: string;
  target: CdpDebuggee & { tabId: number };
  timestamp?: number;
  expectsExtra?: boolean;
}
interface Chain {
  hops: RequestRecord[];
  requestHeaders: ReturnType<typeof redactHeaderEvidence>[];
  responseHeaders: ReturnType<typeof redactHeaderEvidence>[];
  requestIndex: number;
  responseIndex: number;
  partial?: boolean;
}

interface ControlAnnotation {
  intervention?: DebugIntervention;
  replay_from?: string;
  replay_id?: string;
  effective?: {
    url: string;
    method: string;
    headers: Record<string, string>;
    postData?: string;
  };
  mock?: { status: number; headers?: Record<string, string>; body: string };
}

function incompleteMetadata(entry: DebugRequest): void {
  entry.truncated = true;
  if (entry.integrity) entry.integrity.metadata = "truncated";
}

export class DebugNetworkStore {
  readonly entries = new Map<string, RequestRecord>();
  // Recent traffic must not erase the CDP identity of a slow request or body job.
  private readonly inflight = new Map<string, RequestRecord>();
  private readonly chains = new Map<string, Chain>();
  private readonly queue: RequestRecord[] = [];
  private readonly annotations = new Map<
    string,
    {
      value: ControlAnnotation;
      requestBody?: ReturnType<typeof redactBody>;
      responseBody?: ReturnType<typeof redactBody>;
      headersTruncated: boolean;
      urlState?: ReturnType<typeof redactRequestUrl>["state"];
    }
  >();
  private jobs = 0;
  private serial = 0;
  private retainedChars = 0;
  private pendingHeaders = 0;
  private alive = true;
  private accepting = true;
  dropped = 0;

  constructor(
    private readonly runId: string,
    private readonly cdp: CdpRunner,
    private readonly changed: () => number,
    private readonly now: () => number = Date.now,
    private readonly retain?: (entry: DebugRequest) => void,
  ) {}

  private key(source: CdpDebuggee, requestId: string): string {
    return `${source.sessionId ?? "root"}:${requestId}`;
  }

  private tracked(id: string): boolean {
    return this.entries.has(id) || this.inflight.has(id);
  }
  private unsettled(record: RequestRecord): boolean {
    return record.entry.state === "pending" || record.entry.response_body.state === "pending";
  }
  private *records(): IterableIterator<RequestRecord> {
    yield* this.inflight.values();
    yield* this.entries.values();
  }
  get size(): number {
    return this.entries.size + this.inflight.size;
  }

  onEvent(source: CdpDebuggee & { tabId: number }, method: string, raw: unknown): void {
    if (!this.accepting || !method.startsWith("Network.")) return;
    const event = raw as Event;
    if (!event?.requestId) return;
    const key = this.key(source, event.requestId);
    let chain = this.chains.get(key);
    if (!chain) {
      if (
        ![
          "Network.requestWillBeSent",
          "Network.requestWillBeSentExtraInfo",
          "Network.responseReceivedExtraInfo",
        ].includes(method)
      )
        return;
      // ExtraInfo can arrive before requestWillBeSent. Bound unmatched chains too.
      chain = {
        hops: [],
        requestHeaders: [],
        responseHeaders: [],
        requestIndex: 0,
        responseIndex: 0,
      };
      this.chains.set(key, chain);
      while (this.chains.size > MAX_REQUESTS * 2 + MAX_INFLIGHT) {
        // At most MAX_REQUESTS + MAX_INFLIGHT records are tracked, leaving room
        // for bounded unmatched ExtraInfo chains without dropping pending work.
        const oldestKey = [...this.chains].find(
          ([, value]) => !value.hops.some((hop) => this.unsettled(hop)),
        )![0];
        const oldest = this.chains.get(oldestKey)!;
        this.pendingHeaders -= oldest.requestHeaders.length + oldest.responseHeaders.length;
        this.chains.delete(oldestKey);
      }
    }
    if (method === "Network.requestWillBeSent" && event.request) {
      const previous = chain.hops.at(-1);
      if (previous && event.redirectResponse) {
        previous.expectsExtra = event.redirectHasExtraInfo === true;
        this.response(previous, event.redirectResponse);
        this.finish(previous, event, "redirected");
        previous.entry.response_body = { state: "unavailable", reason: "redirect" };
        this.retain?.(previous.entry);
      }
      const { headers, truncated: headersTruncated } = redactHeaderEvidence(event.request.headers);
      const url = redactRequestUrl(event.request.url);
      const metadataTruncated = chain.partial === true || headersTruncated;
      const id = `${this.runId}:n${++this.serial}`;
      const entry: DebugRequest = {
        id,
        run_id: this.runId,
        sequence: this.changed(),
        started_at: this.now(),
        method: redactText(event.request.method ?? "GET", 24),
        url: url.text,
        integrity: { url: url.state, metadata: metadataTruncated ? "truncated" : "complete" },
        resource_type: event.type,
        frame_id: event.frameId,
        loader_id: event.loaderId,
        state: "pending",
        truncated: metadataTruncated || url.state === "truncated",
        request_headers: headers,
        request_body: {
          state: event.request.hasPostData ? "unavailable" : "empty",
          replay_safe: !event.request.hasPostData,
          ...(event.request.hasPostData ? { reason: "not_in_event" } : {}),
        },
        response_body: { state: "pending" },
        ...(previous && event.redirectResponse ? { redirect_from: previous.entry.id } : {}),
      };
      const frame = event.initiator?.stack?.callFrames?.[0];
      if (frame)
        entry.initiator = redactText(
          `${frame.functionName ?? ""} ${redactUrl(frame.url ?? "")}:${(frame.lineNumber ?? 0) + 1}`,
          1024,
        );
      else if (event.initiator?.type) entry.initiator = event.initiator.type;
      const record: RequestRecord = {
        entry,
        rawId: event.requestId,
        target: { ...source },
        timestamp: event.timestamp,
      };
      this.entries.set(id, record);
      chain.hops.push(record);
      if (typeof event.request.postData === "string") {
        this.saveBody(
          record,
          "request_body",
          event.request.postData,
          headers["content-type"] ?? "",
        );
      }
      this.applyExtra(chain);
      this.applyAnnotation(key, record);
      this.retain?.(entry);
      if (previous) this.releaseFinished(previous);
      while (this.entries.size > MAX_REQUESTS) {
        const oldest = this.entries.values().next().value as RequestRecord;
        if (this.unsettled(oldest)) {
          this.entries.delete(oldest.entry.id);
          this.inflight.set(oldest.entry.id, oldest);
          if (this.inflight.size > MAX_INFLIGHT) {
            const lost = this.inflight.values().next().value!;
            if (lost.entry.state === "pending") {
              lost.entry.state = "interrupted";
              lost.entry.finished_at = this.now();
              lost.entry.error = "tracking_limit";
            }
            incompleteMetadata(lost.entry);
            if (lost.entry.response_body.state === "pending")
              lost.entry.response_body = { state: "unavailable", reason: "tracking_limit" };
            lost.entry.sequence = this.changed();
            this.evict(lost);
          }
        } else this.evict(oldest);
      }
      return;
    }
    if (
      method === "Network.requestWillBeSentExtraInfo" ||
      method === "Network.responseReceivedExtraInfo"
    ) {
      if (chain.partial) return;
      const queue =
        method === "Network.requestWillBeSentExtraInfo"
          ? chain.requestHeaders
          : chain.responseHeaders;
      if (queue.length < 8 && this.pendingHeaders < 64) {
        queue.push(redactHeaderEvidence(event.headers));
        this.pendingHeaders += 1;
      } else {
        chain.partial = true;
        const latest = chain.hops.at(-1);
        if (latest) incompleteMetadata(latest.entry);
      }
      this.applyExtra(chain);
      return;
    }
    const record = chain.hops.at(-1);
    if (!record || !this.tracked(record.entry.id)) return;
    const entry = record.entry;
    switch (method) {
      case "Network.responseReceived":
        record.expectsExtra = event.hasExtraInfo === true;
        if (event.response) this.response(record, event.response);
        this.applyExtra(chain);
        break;
      case "Network.dataReceived":
        if (typeof event.dataLength === "number")
          entry.decoded_bytes = (entry.decoded_bytes ?? 0) + Math.max(0, event.dataLength);
        // Byte counters are accumulated without notifying on every chunk.
        return;
      case "Network.loadingFinished":
        this.finish(record, event, "complete");
        if (entry.method === "HEAD" || entry.status === 204 || entry.status === 304)
          entry.response_body = { state: "empty", chars: 0 };
        else if (entry.intervention?.type === "mock" && entry.response_body.state !== "pending") {
          /* Mock body was retained directly. */
        } else if (
          !/^(?:text\/|application\/(?:[\w.+-]*json|javascript|xml|x-www-form-urlencoded))/i.test(
            entry.mime_type ?? "",
          )
        )
          entry.response_body = { state: "omitted", reason: "non_text" };
        else if ((entry.decoded_bytes ?? 0) > BODY_CHARS * 4)
          entry.response_body = { state: "omitted", reason: "body_limit" };
        else if (this.queue.length >= MAX_BODY_QUEUE)
          entry.response_body = { state: "omitted", reason: "capture_busy" };
        else {
          this.queue.push(record);
          this.pump();
        }
        break;
      case "Network.loadingFailed":
        this.finish(record, event, "failed");
        entry.error = redactText(event.errorText ?? "network failed");
        entry.response_body = { state: "unavailable", reason: "request_failed" };
        break;
      case "Network.requestServedFromCache":
        entry.from_cache = true;
        break;
      default:
        return;
    }
    entry.sequence = this.changed();
    this.retain?.(entry);
    this.releaseFinished(record);
  }

  private applyExtra(chain: Chain): void {
    for (const side of ["request", "response"] as const) {
      const indexKey = side === "request" ? "requestIndex" : "responseIndex";
      const headersQueue = side === "request" ? chain.requestHeaders : chain.responseHeaders;
      while (chain[indexKey] < chain.hops.length) {
        const record = chain.hops[chain[indexKey]];
        if (record.expectsExtra === undefined) break;
        if (!record.expectsExtra) {
          chain[indexKey] += 1;
          continue;
        }
        if (!headersQueue.length) break;
        chain[indexKey] += 1;
        const evidence = headersQueue.shift()!;
        this.pendingHeaders -= 1;
        if (!this.tracked(record.entry.id)) continue;
        record.entry[side === "request" ? "request_headers" : "response_headers"] =
          evidence.headers;
        if (evidence.truncated) incompleteMetadata(record.entry);
        record.entry.sequence = this.changed();
        this.retain?.(record.entry);
      }
    }
  }

  private response(record: RequestRecord, response: Response): void {
    const entry = record.entry;
    entry.status = response.status;
    entry.mime_type = response.mimeType;
    entry.response_headers ??= redactHeaders(response.headers);
    entry.from_cache = response.fromDiskCache === true || entry.from_cache;
    entry.from_service_worker = response.fromServiceWorker === true;
    if (response.timing)
      entry.timing = Object.fromEntries(
        Object.entries(response.timing)
          .filter(([, value]) => typeof value === "number" && Number.isFinite(value))
          .slice(0, 30),
      );
    entry.sequence = this.changed();
    this.retain?.(entry);
  }

  private finish(record: RequestRecord, event: Event, state: DebugRequest["state"]): void {
    record.entry.state = state;
    record.entry.finished_at = this.now();
    if (event.timestamp !== undefined && record.timestamp !== undefined)
      record.entry.duration_ms = Math.max(
        0,
        Math.round((event.timestamp - record.timestamp) * 1000 * 100) / 100,
      );
    if (typeof event.encodedDataLength === "number")
      record.entry.transfer_bytes = Math.max(0, event.encodedDataLength);
  }

  private pump(): void {
    while (this.alive && this.jobs < MAX_BODY_JOBS && this.queue.length) {
      const record = this.queue.shift() as RequestRecord;
      if (!this.tracked(record.entry.id)) continue;
      this.jobs += 1;
      // Never call send(), which can reattach a returned tab. The production
      // runner supplies a direct command guarded by current task ownership.
      void sendToCdpTarget<{ body: string; base64Encoded?: boolean }>(
        this.cdp,
        record.target,
        "Network.getResponseBody",
        { requestId: record.rawId },
      )
        .then((result) => {
          if (!this.alive || !this.tracked(record.entry.id)) return;
          let body = result.body;
          if (result.base64Encoded) {
            if (body.length > BODY_CHARS * 6) {
              record.entry.response_body = { state: "omitted", reason: "body_limit" };
              return;
            }
            body = new TextDecoder().decode(
              Uint8Array.from(atob(body), (char) => char.charCodeAt(0)),
            );
          }
          this.saveBody(record, "response_body", body, record.entry.mime_type ?? "");
        })
        .catch(() => {
          if (this.alive && this.tracked(record.entry.id))
            record.entry.response_body = {
              state: "unavailable",
              reason: "browser_buffer_unavailable",
            };
        })
        .finally(() => {
          this.jobs -= 1;
          if (this.alive && this.tracked(record.entry.id)) {
            record.entry.sequence = this.changed();
            this.retain?.(record.entry);
            this.releaseFinished(record);
          }
          this.pump();
        });
    }
  }

  private saveBody(
    record: RequestRecord,
    key: "request_body" | "response_body",
    text: string,
    mime: string,
    retained?: ReturnType<typeof redactBody>,
  ): void {
    if (/multipart\/form-data/i.test(mime)) {
      record.entry[key] = { state: "omitted", reason: "multipart" };
      return;
    }
    const body = retained ?? redactBody(text, mime);
    this.retainedChars -= record.entry[key].text?.length ?? 0;
    record.entry[key] = {
      state: body.reason
        ? "omitted"
        : body.truncated
          ? "truncated"
          : body.text.length
            ? "available"
            : "empty",
      text: body.text,
      chars: body.text.length,
      redacted: body.redacted,
      replay_safe: body.replay_safe,
      ...(body.reason ? { reason: body.reason } : body.truncated ? { reason: "body_limit" } : {}),
    };
    this.retainedChars += body.text.length;
    this.retain?.(record.entry);
    for (const item of this.records()) {
      if (this.retainedChars <= MAX_BODY_CHARS) break;
      for (const part of ["request_body", "response_body"] as const) {
        const length = item.entry[part].text?.length ?? 0;
        if (!length) continue;
        this.retain?.(item.entry);
        this.retainedChars -= length;
        item.entry[part] = { state: "evicted", reason: "memory_limit" };
        item.entry.sequence = this.changed();
      }
    }
  }

  private evict(record: RequestRecord): void {
    this.retain?.(record.entry);
    this.dropped += 1;
    this.retainedChars -=
      (record.entry.request_body.text?.length ?? 0) +
      (record.entry.response_body.text?.length ?? 0);
    // Clear text on references still held by a redirect chain or pending job.
    record.entry.request_body = { state: "evicted" };
    record.entry.response_body = { state: "evicted" };
    record.entry.request_headers = undefined;
    record.entry.response_headers = undefined;
    this.entries.delete(record.entry.id);
    this.inflight.delete(record.entry.id);
    this.annotations.delete(this.key(record.target, record.rawId));
    // A redirect chain must not keep evicted request records alive. If its
    // pending ExtraInfo can no longer be matched, retain ordinary headers and
    // report partial evidence instead of assigning them to the wrong hop.
    const key = this.key(record.target, record.rawId);
    const chain = this.chains.get(key);
    if (chain) {
      const index = chain.hops.indexOf(record);
      if (index >= 0) {
        chain.hops.splice(index, 1);
        if (chain.requestIndex <= index || chain.responseIndex <= index) {
          chain.partial = true;
          this.pendingHeaders -= chain.requestHeaders.length + chain.responseHeaders.length;
          chain.requestHeaders.length = 0;
          chain.responseHeaders.length = 0;
          for (const hop of chain.hops) incompleteMetadata(hop.entry);
        }
        if (chain.requestIndex > index) chain.requestIndex -= 1;
        if (chain.responseIndex > index) chain.responseIndex -= 1;
      }
      if (!chain.hops.length) {
        this.pendingHeaders -= chain.requestHeaders.length + chain.responseHeaders.length;
        this.chains.delete(key);
      }
    }
  }

  private releaseFinished(record: RequestRecord): void {
    if (this.inflight.has(record.entry.id) && !this.unsettled(record)) this.evict(record);
  }

  /** Called on the CDP event path; annotations can precede requestWillBeSent. */
  annotate(source: CdpDebuggee, rawId: string, annotation: ControlAnnotation): void {
    const key = this.key(source, rawId);
    let requestBody: ReturnType<typeof redactBody> | undefined;
    let responseBody: ReturnType<typeof redactBody> | undefined;
    let urlState: ReturnType<typeof redactRequestUrl>["state"] | undefined;
    const headers = redactHeaderEvidence(annotation.effective?.headers);
    // Pending annotations must obey the same redaction boundary as live records.
    // Preserve the original completeness flags when formatting expands a JSON body.
    if (annotation.effective) {
      const value = annotation.effective;
      const url = redactRequestUrl(value.url);
      urlState = url.state;
      if (value.postData !== undefined)
        requestBody = redactBody(value.postData, value.headers["content-type"] ?? "");
      annotation = {
        ...annotation,
        effective: {
          ...value,
          url: url.text,
          headers: headers.headers,
          ...(value.postData === undefined ? {} : { postData: requestBody!.text }),
        },
      };
    }
    if (annotation.mock) {
      const value = annotation.mock;
      responseBody = redactBody(value.body, value.headers?.["content-type"] ?? "");
      annotation = {
        ...annotation,
        mock: {
          ...value,
          headers: redactHeaders(value.headers),
          body: responseBody.text,
        },
      };
    }
    this.annotations.set(key, {
      value: annotation,
      requestBody,
      responseBody,
      headersTruncated: headers.truncated,
      urlState,
    });
    while (this.annotations.size > 64)
      this.annotations.delete(this.annotations.keys().next().value!);
    const record = this.chains.get(key)?.hops.at(-1);
    if (record) this.applyAnnotation(key, record);
  }
  private applyAnnotation(key: string, record: RequestRecord): void {
    const retained = this.annotations.get(key);
    if (!retained) return;
    this.annotations.delete(key);
    const { effective, mock, ...metadata } = retained.value;
    Object.assign(record.entry, metadata);
    if (effective) {
      if (retained.headersTruncated) incompleteMetadata(record.entry);
      record.entry.url = effective.url;
      record.entry.integrity!.url = retained.urlState!;
      record.entry.truncated =
        record.entry.integrity!.metadata === "truncated" || retained.urlState === "truncated";
      record.entry.method = effective.method;
      record.entry.request_headers = effective.headers;
      if (effective.postData !== undefined)
        this.saveBody(
          record,
          "request_body",
          effective.postData,
          effective.headers["content-type"] ?? "",
          retained.requestBody,
        );
    }
    if (mock) {
      record.entry.status = mock.status;
      record.entry.response_headers = redactHeaders(mock.headers);
      record.entry.mime_type = mock.headers?.["content-type"] ?? "text/plain";
      this.saveBody(
        record,
        "response_body",
        mock.body,
        record.entry.mime_type,
        retained.responseBody,
      );
    }
    record.entry.sequence = this.changed();
    this.retain?.(record.entry);
  }

  checkpoint(): void {
    for (const { entry } of this.records()) this.retain?.(entry);
  }

  list(): DebugRequest[] {
    return Array.from(this.records(), (record) => record.entry);
  }
  get(id: string): DebugRequest | undefined {
    return (this.entries.get(id) ?? this.inflight.get(id))?.entry;
  }

  detachTarget(sessionId: string): void {
    for (const record of this.records()) {
      const { entry, target } = record;
      if (target.sessionId !== sessionId || entry.state !== "pending") continue;
      entry.state = "interrupted";
      entry.error = "frame_detached";
      entry.finished_at = this.now();
      entry.response_body = { state: "unavailable", reason: "frame_detached" };
      entry.sequence = this.changed();
      this.retain?.(entry);
      this.releaseFinished(record);
    }
  }

  stop(reason: string): void {
    this.accepting = false;
    this.alive = false;
    this.queue.length = 0;
    this.chains.clear();
    this.annotations.clear();
    this.pendingHeaders = 0;
    for (const record of this.records()) {
      const { entry } = record;
      if (entry.state === "pending") {
        entry.state = "interrupted";
        entry.error = reason;
        entry.finished_at = this.now();
      }
      if (entry.response_body.state === "pending")
        entry.response_body = { state: "unavailable", reason: "capture_stopped" };
      entry.sequence = this.changed();
      this.retain?.(entry);
      this.releaseFinished(record);
    }
  }
}

export function bodySlice(
  body: DebugBody,
  offset: number,
  maxChars: number,
  pointer?: string,
): DebugBody {
  if (body.text === undefined) return { ...body };
  let text = body.text;
  if (pointer !== undefined) {
    if (body.state !== "available" && body.state !== "empty")
      throw new Error("JSON pointer requires a complete body");
    text = jsonPointer(text, pointer);
  }
  const splitsCharacter = (at: number) =>
    /[\uD800-\uDBFF]/.test(text.charAt(at - 1)) && /[\uDC00-\uDFFF]/.test(text.charAt(at));
  if (splitsCharacter(offset))
    throw new Error("offset splits a Unicode character; use next_offset");
  let end = Math.min(text.length, offset + maxChars);
  if (splitsCharacter(end)) end--;
  if (end === offset && offset < text.length)
    throw new Error("max_chars too small for a complete Unicode character");
  return {
    ...body,
    text: text.slice(offset, end),
    chars: text.length,
    offset,
    ...(end < text.length ? { next_offset: end } : {}),
  };
}

export function requestProjection(
  entry: DebugRequest,
  part: string = "metadata",
  offset = 0,
  maxChars = 4096,
  pointer?: string,
): DebugRequest {
  return {
    ...requestMetadata(entry),
    ...(part === "request"
      ? { request_body: bodySlice(entry.request_body, offset, maxChars, pointer) }
      : {}),
    ...(part === "response"
      ? { response_body: bodySlice(entry.response_body, offset, maxChars, pointer) }
      : {}),
    ...(part === "headers"
      ? { request_headers: entry.request_headers, response_headers: entry.response_headers }
      : {}),
    ...(part === "timing" ? { timing: entry.timing } : {}),
  };
}
