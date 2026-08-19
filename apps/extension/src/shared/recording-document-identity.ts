export const RECORD_DOCUMENT_ATTRIBUTE = "data-bsk-record-document";

/** Read BrowserSkill's opaque per-Document recording identity from captured attributes. */
export function readRecordingDocumentIdentity(
  attrs: Readonly<Record<string, string>>,
): string | undefined {
  const identity = attrs[RECORD_DOCUMENT_ATTRIBUTE];
  return identity ? identity : undefined;
}
