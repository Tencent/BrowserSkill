import {
  RECORD_DOCUMENT_ATTRIBUTE,
  recordingDocumentMarkerValue,
} from "@/shared/recording-document-identity";

export interface RecordingDocumentMarker {
  restore(): void;
  ensure(): void;
}

export function waitForDocumentElement(): Promise<HTMLElement> {
  if (document.documentElement) return Promise.resolve(document.documentElement);
  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      if (!document.documentElement) return;
      observer.disconnect();
      resolve(document.documentElement);
    });
    observer.observe(document, { childList: true });
  });
}

export function markRecordingDocument(
  producerId: string,
  root: HTMLElement = document.documentElement,
): RecordingDocumentMarker {
  const previous = root.getAttribute(RECORD_DOCUMENT_ATTRIBUTE);
  const markerValue = recordingDocumentMarkerValue(producerId);
  const ensure = () => root.setAttribute(RECORD_DOCUMENT_ATTRIBUTE, markerValue);
  ensure();
  return {
    ensure,
    restore() {
      if (root.getAttribute(RECORD_DOCUMENT_ATTRIBUTE) !== markerValue) return;
      if (previous === null) root.removeAttribute(RECORD_DOCUMENT_ATTRIBUTE);
      else root.setAttribute(RECORD_DOCUMENT_ATTRIBUTE, previous);
    },
  };
}
