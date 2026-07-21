import type {
  HarStartParams,
  HarStartResult,
  HarStatusResult,
  HarStopResult,
} from "@/transport/types";
import type { CdpDebuggerApi } from "./chromium-cdp";

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_MAX_TOTAL_BODY_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 5000;
const MAX_BODY_BYTES = 10 * 1024 * 1024;
// Keep the decoded body budget below the daemon WebSocket's 64 MiB message
// ceiling even when every retained response is base64-expanded by 4/3.
const MAX_TOTAL_BODY_BYTES = 32 * 1024 * 1024;
const MAX_ENTRIES = 10_000;
const DEFAULT_SETTLE_TIMEOUT_MS = 2000;
const MAX_SETTLE_TIMEOUT_MS = 10_000;
const REDACTED = "<redacted>";

const SENSITIVE_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-auth-token",
]);
const SENSITIVE_QUERY_NAMES = new Set([
  "token",
  "access_token",
  "refresh_token",
  "id_token",
  "auth_token",
  "secret",
  "client_secret",
  "password",
  "passwd",
  "authorization",
  "signature",
  "sig",
  "api_key",
  "apikey",
  "access_key",
  "session",
  "session_id",
  "sessionid",
  "code",
]);

interface HarOptions {
  captureContent: boolean;
  sanitize: boolean;
  maxBodyBytes: number;
  maxTotalBodyBytes: number;
  maxEntries: number;
}

interface RequestDraft {
  requestId: string;
  startedTimestamp: number;
  startedDateTime: string;
  method: string;
  url: string;
  requestHeaders: Record<string, unknown>;
  postData?: string;
  hasPostData: boolean;
  resourceType?: string;
  response?: Record<string, unknown>;
  responseTimestamp?: number;
  responseHeaders?: Record<string, unknown>;
  finishedTimestamp?: number;
  encodedDataLength?: number;
  responseBody?: { body: string; base64Encoded: boolean; decodedBytes: number };
  bodyOmitted?: string;
  error?: string;
}

interface Recording {
  tabId: number;
  startedAt: string;
  options: HarOptions;
  active: Map<string, RequestDraft>;
  pendingRequestHeaders: Map<string, Record<string, unknown>>;
  pendingResponseHeaders: Map<string, Record<string, unknown>>;
  entries: Record<string, unknown>[];
  pending: Set<Promise<void>>;
  bodyBytes: number;
  truncated: boolean;
}

export class HarRecorder {
  private readonly recordings = new Map<string, Recording>();

  constructor(private readonly api: CdpDebuggerApi) {}

  start(sessionId: string, tabId: number, params: HarStartParams): HarStartResult {
    if (this.recordings.has(sessionId)) {
      throw new Error(`HAR recording already active for session ${sessionId}`);
    }
    const options: HarOptions = {
      captureContent: params.capture_content ?? true,
      sanitize: params.sanitize ?? true,
      maxBodyBytes: boundedInteger(
        params.max_body_bytes,
        DEFAULT_MAX_BODY_BYTES,
        MAX_BODY_BYTES,
        "max_body_bytes",
      ),
      maxTotalBodyBytes: boundedInteger(
        params.max_total_body_bytes,
        DEFAULT_MAX_TOTAL_BODY_BYTES,
        MAX_TOTAL_BODY_BYTES,
        "max_total_body_bytes",
      ),
      maxEntries: boundedInteger(
        params.max_entries,
        DEFAULT_MAX_ENTRIES,
        MAX_ENTRIES,
        "max_entries",
      ),
    };
    const startedAt = new Date().toISOString();
    this.recordings.set(sessionId, {
      tabId,
      startedAt,
      options,
      active: new Map(),
      pendingRequestHeaders: new Map(),
      pendingResponseHeaders: new Map(),
      entries: [],
      pending: new Set(),
      bodyBytes: 0,
      truncated: false,
    });
    return {
      tab_id: tabId,
      started_at: startedAt,
      capture_content: options.captureContent,
      sanitize: options.sanitize,
      max_body_bytes: options.maxBodyBytes,
      max_total_body_bytes: options.maxTotalBodyBytes,
      max_entries: options.maxEntries,
    };
  }

  status(sessionId: string): HarStatusResult {
    const recording = this.recordings.get(sessionId);
    if (!recording) {
      return {
        active: false,
        entry_count: 0,
        in_flight: 0,
        body_bytes: 0,
        truncated: false,
      };
    }
    return {
      active: true,
      tab_id: recording.tabId,
      started_at: recording.startedAt,
      entry_count: recording.entries.length,
      in_flight: recording.active.size,
      body_bytes: recording.bodyBytes,
      truncated: recording.truncated,
    };
  }

  async stop(sessionId: string, settleTimeoutMs?: number): Promise<HarStopResult> {
    const recording = this.recordings.get(sessionId);
    if (!recording) throw new Error(`no active HAR recording for session ${sessionId}`);
    const settle = boundedInteger(
      settleTimeoutMs,
      DEFAULT_SETTLE_TIMEOUT_MS,
      MAX_SETTLE_TIMEOUT_MS,
      "settle_timeout_ms",
      true,
    );
    const deadline = Date.now() + settle;
    while ((recording.active.size > 0 || recording.pending.size > 0) && Date.now() < deadline) {
      await delay(25);
    }
    const settled = recording.active.size === 0 && recording.pending.size === 0;
    if (!settled) {
      recording.truncated = true;
      for (const draft of Array.from(recording.active.values())) {
        draft.error ??= "capture stopped before request completed";
        this.finish(recording, draft, draft.finishedTimestamp ?? draft.responseTimestamp);
      }
    }
    if (settled) await Promise.allSettled(Array.from(recording.pending));
    this.recordings.delete(sessionId);
    const har = {
      log: {
        version: "1.2",
        creator: {
          name: "BrowserSkill",
          version: typeof __BSK_EXT_VERSION__ === "string" ? __BSK_EXT_VERSION__ : "unknown",
        },
        comment: recording.truncated
          ? "Capture reached a configured limit or stopped with incomplete requests."
          : undefined,
        entries: recording.entries,
      },
    };
    return {
      tab_id: recording.tabId,
      entry_count: recording.entries.length,
      body_bytes: recording.bodyBytes,
      truncated: recording.truncated,
      har,
    };
  }

  discardSession(sessionId: string): void {
    this.recordings.delete(sessionId);
  }

  handleDetach(tabId: number): void {
    for (const recording of this.recordings.values()) {
      if (recording.tabId !== tabId) continue;
      recording.truncated = true;
      for (const draft of Array.from(recording.active.values())) {
        draft.error ??= "CDP detached before request completed";
        this.finish(recording, draft, draft.finishedTimestamp ?? draft.responseTimestamp);
      }
    }
  }

  handleEvent(tabId: number, method: string, params: unknown): void {
    for (const recording of this.recordings.values()) {
      if (recording.tabId !== tabId) continue;
      const raw = asRecord(params);
      switch (method) {
        case "Network.requestWillBeSent":
          this.onRequest(recording, raw);
          break;
        case "Network.requestWillBeSentExtraInfo":
          this.onRequestExtra(recording, raw);
          break;
        case "Network.responseReceived":
          this.onResponse(recording, raw);
          break;
        case "Network.responseReceivedExtraInfo":
          this.onResponseExtra(recording, raw);
          break;
        case "Network.loadingFinished":
          this.onFinished(recording, raw);
          break;
        case "Network.loadingFailed":
          this.onFailed(recording, raw);
          break;
      }
    }
  }

  private onRequest(recording: Recording, raw: Record<string, unknown>): void {
    const requestId = stringValue(raw.requestId);
    const request = asRecord(raw.request);
    const url = stringValue(request.url);
    if (!requestId || !url) return;
    const previous = recording.active.get(requestId);
    if (previous) {
      const redirect = asRecord(raw.redirectResponse);
      if (Object.keys(redirect).length > 0) {
        previous.response = redirect;
        previous.responseHeaders = asRecord(redirect.headers);
        previous.responseTimestamp = numberValue(raw.timestamp);
      } else {
        previous.error ??= "request id reused before completion";
      }
      this.finish(recording, previous, numberValue(raw.timestamp));
    }
    if (recording.entries.length + recording.active.size >= recording.options.maxEntries) {
      recording.truncated = true;
      return;
    }
    const wallTime = numberValue(raw.wallTime);
    const startedDate = wallTime !== undefined ? new Date(wallTime * 1000) : new Date();
    let postData = recording.options.captureContent ? stringValue(request.postData) : undefined;
    let bodyOmitted: string | undefined;
    if (postData !== undefined && byteLength(postData) > recording.options.maxBodyBytes) {
      postData = undefined;
      recording.truncated = true;
      bodyOmitted = `request body exceeds max_body_bytes (${recording.options.maxBodyBytes})`;
    }
    recording.active.set(requestId, {
      requestId,
      startedTimestamp: numberValue(raw.timestamp) ?? 0,
      startedDateTime: startedDate.toISOString(),
      method: stringValue(request.method) ?? "GET",
      url,
      requestHeaders: {
        ...asRecord(request.headers),
        ...recording.pendingRequestHeaders.get(requestId),
      },
      postData,
      hasPostData: request.hasPostData === true || typeof request.postData === "string",
      resourceType: stringValue(raw.type),
      bodyOmitted,
    });
    recording.pendingRequestHeaders.delete(requestId);
  }

  private onRequestExtra(recording: Recording, raw: Record<string, unknown>): void {
    const requestId = stringValue(raw.requestId) ?? "";
    const draft = recording.active.get(requestId);
    const headers = asRecord(raw.headers);
    if (draft) draft.requestHeaders = { ...draft.requestHeaders, ...headers };
    else if (requestId) recording.pendingRequestHeaders.set(requestId, headers);
  }

  private onResponse(recording: Recording, raw: Record<string, unknown>): void {
    const draft = recording.active.get(stringValue(raw.requestId) ?? "");
    if (!draft) return;
    draft.response = asRecord(raw.response);
    draft.responseHeaders = {
      ...asRecord(draft.response.headers),
      ...recording.pendingResponseHeaders.get(draft.requestId),
    };
    recording.pendingResponseHeaders.delete(draft.requestId);
    draft.responseTimestamp = numberValue(raw.timestamp);
    draft.resourceType = stringValue(raw.type) ?? draft.resourceType;
  }

  private onResponseExtra(recording: Recording, raw: Record<string, unknown>): void {
    const requestId = stringValue(raw.requestId) ?? "";
    const draft = recording.active.get(requestId);
    const headers = asRecord(raw.headers);
    if (draft) draft.responseHeaders = { ...draft.responseHeaders, ...headers };
    else if (requestId) recording.pendingResponseHeaders.set(requestId, headers);
  }

  private onFinished(recording: Recording, raw: Record<string, unknown>): void {
    const requestId = stringValue(raw.requestId) ?? "";
    const draft = recording.active.get(requestId);
    if (!draft) return;
    draft.finishedTimestamp = numberValue(raw.timestamp);
    draft.encodedDataLength = numberValue(raw.encodedDataLength);
    const pending = this.captureBodies(recording, draft)
      .catch((error) => {
        draft.bodyOmitted = error instanceof Error ? error.message : String(error);
      })
      .finally(() => {
        recording.pending.delete(pending);
        if (recording.active.get(requestId) === draft) this.finish(recording, draft);
      });
    recording.pending.add(pending);
  }

  private onFailed(recording: Recording, raw: Record<string, unknown>): void {
    const draft = recording.active.get(stringValue(raw.requestId) ?? "");
    if (!draft) return;
    draft.finishedTimestamp = numberValue(raw.timestamp);
    draft.error = stringValue(raw.errorText) ?? "request failed";
    this.finish(recording, draft);
  }

  private async captureBodies(recording: Recording, draft: RequestDraft): Promise<void> {
    if (!recording.options.captureContent) return;
    if (draft.hasPostData && draft.postData === undefined) {
      try {
        const requestBody = (await this.api.sendCommand(
          { tabId: recording.tabId },
          "Network.getRequestPostData",
          { requestId: draft.requestId },
        )) as { postData?: unknown };
        const postData = stringValue(requestBody.postData);
        if (postData !== undefined && byteLength(postData) <= recording.options.maxBodyBytes) {
          draft.postData = postData;
        }
      } catch {
        // CDP legitimately omits request bodies for some cached/internal requests.
        recording.truncated = true;
        draft.bodyOmitted = appendOmission(draft.bodyOmitted, "request body unavailable from CDP");
      }
    }
    if (responseHasNoBody(draft)) return;
    try {
      const responseBody = (await this.api.sendCommand(
        { tabId: recording.tabId },
        "Network.getResponseBody",
        { requestId: draft.requestId },
      )) as { body?: unknown; base64Encoded?: unknown };
      const body = stringValue(responseBody.body);
      if (body === undefined) return;
      const base64Encoded = responseBody.base64Encoded === true;
      const decodedBytes = base64Encoded ? base64DecodedLength(body) : byteLength(body);
      if (decodedBytes > recording.options.maxBodyBytes) {
        recording.truncated = true;
        draft.bodyOmitted = appendOmission(
          draft.bodyOmitted,
          `response body exceeds max_body_bytes (${recording.options.maxBodyBytes})`,
        );
        return;
      }
      if (recording.bodyBytes + decodedBytes > recording.options.maxTotalBodyBytes) {
        recording.truncated = true;
        draft.bodyOmitted = appendOmission(
          draft.bodyOmitted,
          `recording exceeds max_total_body_bytes (${recording.options.maxTotalBodyBytes})`,
        );
        return;
      }
      recording.bodyBytes += decodedBytes;
      draft.responseBody = { body, base64Encoded, decodedBytes };
    } catch (error) {
      recording.truncated = true;
      draft.bodyOmitted = appendOmission(
        draft.bodyOmitted,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private finish(recording: Recording, draft: RequestDraft, finishTimestamp?: number): void {
    if (recording.active.get(draft.requestId) !== draft) return;
    recording.active.delete(draft.requestId);
    recording.pendingRequestHeaders.delete(draft.requestId);
    recording.pendingResponseHeaders.delete(draft.requestId);
    draft.finishedTimestamp ??= finishTimestamp;
    if (recording.entries.length >= recording.options.maxEntries) {
      recording.truncated = true;
      return;
    }
    recording.entries.push(toHarEntry(draft, recording.options));
  }
}

function toHarEntry(draft: RequestDraft, options: HarOptions): Record<string, unknown> {
  const response = draft.response ?? {};
  const requestHeaders = toHarHeaders(draft.requestHeaders, options.sanitize);
  const responseHeaders = toHarHeaders(
    draft.responseHeaders ?? asRecord(response.headers),
    options.sanitize,
  );
  const protocol = stringValue(response.protocol) ?? "HTTP/1.1";
  const mimeType =
    stringValue(response.mimeType) ?? headerValue(responseHeaders, "content-type") ?? "";
  const timings = makeTimings(draft, response);
  const totalTime = sumTimings(timings);
  const request: Record<string, unknown> = {
    method: draft.method,
    url: sanitizeUrl(draft.url, options.sanitize),
    httpVersion: protocol,
    cookies: [],
    headers: requestHeaders,
    queryString: queryString(draft.url, options.sanitize),
    headersSize: -1,
    bodySize: draft.postData === undefined ? -1 : byteLength(draft.postData),
  };
  if (draft.postData !== undefined) {
    request.postData = {
      mimeType: headerValue(requestHeaders, "content-type") ?? "application/octet-stream",
      text: draft.postData,
    };
  }
  const contentSize =
    draft.responseBody?.decodedBytes ??
    numberValue(response.encodedDataLength) ??
    draft.encodedDataLength ??
    0;
  const content: Record<string, unknown> = { size: Math.max(0, Math.round(contentSize)), mimeType };
  if (draft.responseBody) {
    content.text = draft.responseBody.body;
    if (draft.responseBody.base64Encoded) content.encoding = "base64";
  }
  const entry: Record<string, unknown> = {
    startedDateTime: draft.startedDateTime,
    time: totalTime,
    request,
    response: {
      status: Math.trunc(numberValue(response.status) ?? 0),
      statusText: stringValue(response.statusText) ?? "",
      httpVersion: protocol,
      cookies: [],
      headers: responseHeaders,
      content,
      redirectURL: headerValue(responseHeaders, "location") ?? "",
      headersSize: -1,
      bodySize: Math.round(
        draft.encodedDataLength ?? numberValue(response.encodedDataLength) ?? -1,
      ),
    },
    cache: {},
    timings,
    _requestId: draft.requestId,
  };
  if (draft.resourceType) entry._resourceType = draft.resourceType;
  if (draft.error) entry._error = draft.error;
  if (draft.bodyOmitted) entry._bodyOmitted = draft.bodyOmitted;
  const remote = stringValue(response.remoteIPAddress);
  if (remote) entry.serverIPAddress = remote;
  const connection = response.connectionId;
  if (typeof connection === "number" || typeof connection === "string") {
    entry.connection = String(connection);
  }
  if (response.fromDiskCache === true) entry._fromDiskCache = true;
  if (response.fromServiceWorker === true) entry._fromServiceWorker = true;
  return entry;
}

function makeTimings(
  draft: RequestDraft,
  response: Record<string, unknown>,
): Record<string, number> {
  const timing = asRecord(response.timing);
  const total = Math.max(
    0,
    ((draft.finishedTimestamp ?? draft.responseTimestamp ?? draft.startedTimestamp) -
      draft.startedTimestamp) *
      1000,
  );
  const dns = duration(timing.dnsStart, timing.dnsEnd);
  const connect = duration(timing.connectStart, timing.connectEnd);
  const ssl = duration(timing.sslStart, timing.sslEnd);
  const send = nonNegativeDuration(timing.sendStart, timing.sendEnd);
  const wait =
    duration(timing.sendEnd, timing.receiveHeadersEnd) >= 0
      ? duration(timing.sendEnd, timing.receiveHeadersEnd)
      : Math.max(
          0,
          ((draft.responseTimestamp ?? draft.startedTimestamp) - draft.startedTimestamp) * 1000,
        );
  const receive = Math.max(
    0,
    ((draft.finishedTimestamp ?? draft.responseTimestamp ?? draft.startedTimestamp) -
      (draft.responseTimestamp ?? draft.finishedTimestamp ?? draft.startedTimestamp)) *
      1000,
  );
  const known = positive(dns) + positive(connect) + send + wait + receive;
  return {
    blocked: roundMs(Math.max(0, total - known)),
    dns: roundMs(dns),
    connect: roundMs(connect),
    ssl: roundMs(ssl),
    send: roundMs(send),
    wait: roundMs(wait),
    receive: roundMs(receive),
  };
}

function sumTimings(timings: Record<string, number>): number {
  return roundMs(
    timings.blocked +
      positive(timings.dns) +
      positive(timings.connect) +
      timings.send +
      timings.wait +
      timings.receive,
  );
}

function duration(start: unknown, end: unknown): number {
  const a = numberValue(start);
  const b = numberValue(end);
  return a === undefined || b === undefined || a < 0 || b < 0 ? -1 : Math.max(0, b - a);
}

function nonNegativeDuration(start: unknown, end: unknown): number {
  return Math.max(0, duration(start, end));
}

function positive(value: number): number {
  return value < 0 ? 0 : value;
}

function roundMs(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function toHarHeaders(
  headers: Record<string, unknown>,
  sanitize: boolean,
): Array<{ name: string; value: string }> {
  return Object.entries(headers).map(([name, raw]) => ({
    name,
    value: sanitize && SENSITIVE_HEADERS.has(name.toLowerCase()) ? REDACTED : headerText(raw),
  }));
}

function headerText(value: unknown): string {
  if (Array.isArray(value)) return value.map(String).join("\n");
  return value === undefined || value === null ? "" : String(value);
}

function headerValue(
  headers: Array<{ name: string; value: string }>,
  name: string,
): string | undefined {
  return headers.find((header) => header.name.toLowerCase() === name)?.value;
}

function responseHasNoBody(draft: RequestDraft): boolean {
  if (draft.method.toUpperCase() === "HEAD") return true;
  const status = Math.trunc(numberValue(draft.response?.status) ?? 0);
  if ((status >= 100 && status < 200) || status === 204 || status === 205 || status === 304) {
    return true;
  }
  const contentLength = Object.entries(draft.responseHeaders ?? {}).find(
    ([name]) => name.toLowerCase() === "content-length",
  )?.[1];
  return headerText(contentLength).trim() === "0";
}

function queryString(url: string, sanitize: boolean): Array<{ name: string; value: string }> {
  try {
    return Array.from(new URL(url).searchParams.entries()).map(([name, value]) => ({
      name,
      value: sanitize && isSensitiveQueryName(name) ? REDACTED : value,
    }));
  } catch {
    return [];
  }
}

function sanitizeUrl(url: string, sanitize: boolean): string {
  if (!sanitize) return url;
  try {
    const parsed = new URL(url);
    const sanitized = new URLSearchParams();
    for (const [name, value] of parsed.searchParams.entries()) {
      sanitized.append(name, isSensitiveQueryName(name) ? REDACTED : value);
    }
    parsed.search = sanitized.toString();
    return parsed.toString();
  } catch {
    return url;
  }
}

function isSensitiveQueryName(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    SENSITIVE_QUERY_NAMES.has(lower) ||
    /(?:^|[_-])(token|secret|password|passwd|signature)(?:$|[_-])/.test(lower)
  );
}

function boundedInteger(
  value: number | undefined,
  defaultValue: number,
  maxValue: number,
  field: string,
  allowZero = false,
): number {
  if (value === undefined) return defaultValue;
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new Error(`${field} must be ${allowZero ? "a non-negative" : "a positive"} integer`);
  }
  return Math.min(value, maxValue);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function base64DecodedLength(value: string): number {
  const clean = value.replace(/\s/g, "");
  const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((clean.length * 3) / 4) - padding);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function appendOmission(existing: string | undefined, next: string): string {
  return existing ? `${existing}; ${next}` : next;
}
