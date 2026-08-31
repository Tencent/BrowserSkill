// Browser-native text entry for live editing sessions. Unlike fill, this
// module does not assume that the focused editable retains a DOM value: a
// Canvas editor may use an input/textarea only as a transient keyboard/IME
// sink and clear it after consuming each event.

import type { RpcError } from "@/transport/types";
import type { CdpRunner } from "./shared";

function cancelled(signal: AbortSignal | undefined): RpcError | null {
  return signal?.aborted ? { code: "cancelled", message: "type aborted" } : null;
}

interface KeyDescriptor {
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  nativeVirtualKeyCode?: number;
  modifiers: number;
}

function asciiKeyDescriptor(character: string): KeyDescriptor {
  if (/^[a-z]$/.test(character)) {
    return {
      key: character,
      code: `Key${character.toUpperCase()}`,
      windowsVirtualKeyCode: character.toUpperCase().charCodeAt(0),
      modifiers: 0,
    };
  }
  if (/^[A-Z]$/.test(character)) {
    return {
      key: character,
      code: `Key${character}`,
      windowsVirtualKeyCode: character.charCodeAt(0),
      modifiers: 8,
    };
  }
  if (/^[0-9]$/.test(character)) {
    return {
      key: character,
      code: `Digit${character}`,
      windowsVirtualKeyCode: character.charCodeAt(0),
      modifiers: 0,
    };
  }
  if (character === " ") {
    return { key: " ", code: "Space", windowsVirtualKeyCode: 32, modifiers: 0 };
  }
  return {
    key: character,
    code: "",
    windowsVirtualKeyCode: character.charCodeAt(0),
    modifiers: 0,
  };
}

/**
 * Run one complete browser key transaction and always release the key. The
 * commit callback owns the text-producing phase: a `char` event for a
 * keyboard character, or `Input.insertText` for committed IME text.
 */
async function dispatchKeyTransaction(
  cdp: CdpRunner,
  tabId: number,
  descriptor: KeyDescriptor,
  commit: () => Promise<void>,
  signal?: AbortSignal,
): Promise<RpcError | null> {
  let keyDown = false;
  try {
    await cdp.send(tabId, "Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      ...descriptor,
    });
    keyDown = true;
    const abortedAfterDown = cancelled(signal);
    if (!abortedAfterDown) await commit();
    await cdp.send(tabId, "Input.dispatchKeyEvent", {
      type: "keyUp",
      ...descriptor,
    });
    keyDown = false;
    return abortedAfterDown ?? cancelled(signal);
  } catch (err) {
    if (keyDown) {
      try {
        await cdp.send(tabId, "Input.dispatchKeyEvent", {
          type: "keyUp",
          ...descriptor,
        });
      } catch {
        // Best-effort cleanup keeps the page from observing a stuck key.
      }
    }
    throw err;
  }
}

async function typeAsciiCharacter(
  cdp: CdpRunner,
  tabId: number,
  character: string,
  signal?: AbortSignal,
): Promise<RpcError | null> {
  const descriptor = asciiKeyDescriptor(character);
  return dispatchKeyTransaction(
    cdp,
    tabId,
    descriptor,
    async () => {
      await cdp.send(tabId, "Input.dispatchKeyEvent", {
        type: "char",
        ...descriptor,
        text: character,
        unmodifiedText: character,
      });
    },
    signal,
  );
}

async function typeImeSegment(
  cdp: CdpRunner,
  tabId: number,
  text: string,
  signal?: AbortSignal,
): Promise<RpcError | null> {
  const abortedBefore = cancelled(signal);
  if (abortedBefore) return abortedBefore;

  // A committed IME value is still part of a keyboard transaction. The
  // Process key (VK_PROCESSKEY / 229) is the platform-neutral signal that an
  // IME owns the keystroke. It lets selection-based editors enter text mode
  // before insertText commits the Unicode value, without inventing a visible
  // ASCII prefix or leaving a composition transaction open.
  const processKey: KeyDescriptor = {
    key: "Process",
    code: "",
    windowsVirtualKeyCode: 229,
    nativeVirtualKeyCode: 229,
    modifiers: 0,
  };
  return dispatchKeyTransaction(
    cdp,
    tabId,
    processKey,
    () => cdp.send(tabId, "Input.insertText", { text }).then(() => undefined),
    signal,
  );
}

/**
 * Dispatch text through the browser's keyboard/IME pipelines. ASCII runs are
 * delivered as physical-key-shaped events; non-ASCII runs use CDP's committed
 * IME/software-keyboard insertion path. Successful return means the browser
 * accepted the input commands, not that a DOM value retained the text.
 */
export async function dispatchTextInput(
  cdp: CdpRunner,
  tabId: number,
  text: string,
  signal?: AbortSignal,
): Promise<RpcError | null> {
  const abortedBefore = cancelled(signal);
  if (abortedBefore) return abortedBefore;

  const segments: Array<{ ime: boolean; text: string }> = [];
  for (const character of text) {
    const ime = character.codePointAt(0)! > 0x7f;
    const previous = segments.at(-1);
    if (previous?.ime === ime) previous.text += character;
    else segments.push({ ime, text: character });
  }

  try {
    for (const segment of segments) {
      if (segment.ime) {
        const error = await typeImeSegment(cdp, tabId, segment.text, signal);
        if (error) return error;
        continue;
      }
      for (const character of segment.text) {
        const error = await typeAsciiCharacter(cdp, tabId, character, signal);
        if (error) return error;
      }
    }
    return null;
  } catch (err) {
    return {
      code: "cdp_failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
