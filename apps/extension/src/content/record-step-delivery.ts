import { createRandomUuid } from "@/lib/random-uuid";
import {
  isAcceptedRecordStepAck,
  RECORD_STEP,
  type RecordStepMessage,
  type RecordStepPayload,
} from "@/lib/record-bridge";

export type SendRecordStepMessage = (message: RecordStepMessage) => Promise<unknown>;

export class RecordStepDelivery {
  readonly #requestId: string;
  readonly #producerId: string;
  readonly #send: SendRecordStepMessage;
  readonly #pending = new Map<number, RecordStepPayload>();
  #nextSequence = 1;
  #tail = Promise.resolve();

  constructor(
    requestId: string,
    send: SendRecordStepMessage = (message) => chrome.runtime.sendMessage(message),
    producerId: string = createRandomUuid(),
  ) {
    this.#requestId = requestId;
    this.#producerId = producerId;
    this.#send = send;
  }

  enqueue(step: RecordStepPayload): void {
    const sequence = this.#nextSequence;
    this.#nextSequence += 1;
    this.#pending.set(sequence, step);
    void this.#schedule();
  }

  async flush(): Promise<boolean> {
    await this.#tail;
    await this.#schedule();
    return this.#pending.size === 0;
  }

  #schedule(): Promise<void> {
    const drain = () => this.#drain();
    this.#tail = this.#tail.then(drain, drain);
    return this.#tail;
  }

  async #drain(): Promise<void> {
    for (const [sequence, step] of this.#pending) {
      const message: RecordStepMessage = {
        type: RECORD_STEP,
        requestId: this.#requestId,
        producerId: this.#producerId,
        sequence,
        step,
      };
      try {
        const response = await this.#send(message);
        if (!isAcceptedRecordStepAck(response, sequence)) return;
        this.#pending.delete(sequence);
      } catch {
        return;
      }
    }
  }
}
