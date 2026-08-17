/** Attribute written on `<html>` while a document is actively recording. */
export const RECORD_DOCUMENT_TOKEN_ATTR = "data-bsk-record-document";

export function createRecordDocumentToken(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `doc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function stampRecordDocumentToken(token: string): void {
  document.documentElement.setAttribute(RECORD_DOCUMENT_TOKEN_ATTR, token);
}

export function clearRecordDocumentToken(): void {
  document.documentElement.removeAttribute(RECORD_DOCUMENT_TOKEN_ATTR);
}

export function readRecordDocumentTokenFromAttrs(
  attrs: Record<string, string> | undefined,
): string | undefined {
  const token = attrs?.[RECORD_DOCUMENT_TOKEN_ATTR];
  return token?.trim() ? token : undefined;
}
