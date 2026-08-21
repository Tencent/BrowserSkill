export const RECORD_DOCUMENT_ATTRIBUTE = "data-bsk-record-document";

const RECORDING_DOCUMENT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RECORDING_DOCUMENT_MARKER_PREFIX = "bsk:";

export function recordingDocumentMarkerValue(identity: string): string {
  if (!RECORDING_DOCUMENT_ID_PATTERN.test(identity)) {
    throw new TypeError("recording Document identity must be a random UUID");
  }
  return `${RECORDING_DOCUMENT_MARKER_PREFIX}${identity}`;
}

/** Read BrowserSkill's opaque per-Document recording identity from captured attributes. */
export function readRecordingDocumentIdentity(
  attrs: Readonly<Record<string, string>>,
): string | undefined {
  const marker = attrs[RECORD_DOCUMENT_ATTRIBUTE];
  if (!marker?.startsWith(RECORDING_DOCUMENT_MARKER_PREFIX)) return undefined;
  const identity = marker.slice(RECORDING_DOCUMENT_MARKER_PREFIX.length);
  return identity && RECORDING_DOCUMENT_ID_PATTERN.test(identity) ? identity : undefined;
}
