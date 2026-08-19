export interface RecordedStateEntry {
  id: string;
  url: string;
  title?: string;
  rawVomText: string;
  truncated: boolean;
  stepsHere: number[];
}

function stateIdentity(url: string, body: string): string {
  return `${url}\0${body}`;
}

export class RecordingStateRegistry {
  readonly #entriesById = new Map<string, RecordedStateEntry>();
  readonly #idByIdentity = new Map<string, string>();
  #nextId = 1;

  register(input: {
    url: string;
    title?: string;
    rawVomText: string;
    truncated?: boolean;
  }): RecordedStateEntry {
    const identity = stateIdentity(input.url, input.rawVomText);
    const existingId = this.#idByIdentity.get(identity);
    if (existingId) {
      const existing = this.#entriesById.get(existingId)!;
      if (!existing.title && input.title) existing.title = input.title;
      if (input.truncated) existing.truncated = true;
      return existing;
    }

    const entry: RecordedStateEntry = {
      id: `s${this.#nextId}`,
      url: input.url,
      ...(input.title ? { title: input.title } : {}),
      rawVomText: input.rawVomText,
      truncated: input.truncated ?? false,
      stepsHere: [],
    };
    this.#nextId += 1;
    this.#entriesById.set(entry.id, entry);
    this.#idByIdentity.set(identity, entry.id);
    return entry;
  }

  values(): RecordedStateEntry[] {
    return [...this.#entriesById.values()];
  }

  markStep(stateId: string, draftId: number): void {
    const entry = this.#entriesById.get(stateId);
    if (entry && !entry.stepsHere.includes(draftId)) entry.stepsHere.push(draftId);
  }
}
