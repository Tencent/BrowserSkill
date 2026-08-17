import type { StepV3 } from "@/transport/types";
import { OBSERVATION_FILE_VERSION } from "./record-constants";

export interface ObservationAnnotation {
  stepId: number;
  op: StepV3["op"];
  line: number;
  stateId: string;
  detail?: string;
}

function formatAnnotation({ stepId, op, detail }: ObservationAnnotation): string {
  const suffix = detail ? `: ${detail}` : "";
  return ` ⟵ step ${stepId}: ${op}${suffix}`;
}

/** Serialize a page observation file (front matter + VOM body + step annotations). */
export function formatObservationFile(input: {
  stateId: string;
  url: string;
  title?: string;
  stepsHere: number[];
  body: string;
  annotations?: ObservationAnnotation[];
}): string {
  const lines: string[] = [
    `# bsk-observation ${OBSERVATION_FILE_VERSION}`,
    `state: ${input.stateId}`,
    `url: ${input.url}`,
  ];
  if (input.title) lines.push(`title: ${input.title}`);
  if (input.stepsHere.length > 0) {
    lines.push(`steps_here: [${input.stepsHere.join(", ")}]`);
  }
  lines.push("---");

  const bodyLines = input.body.split("\n");
  const annotationMap = new Map<number, ObservationAnnotation[]>();
  for (const ann of input.annotations ?? []) {
    const bucket = annotationMap.get(ann.line) ?? [];
    bucket.push(ann);
    annotationMap.set(ann.line, bucket);
  }

  for (let i = 0; i < bodyLines.length; i += 1) {
    let line = bodyLines[i] ?? "";
    const anns = annotationMap.get(i);
    if (anns) {
      for (const ann of anns) {
        line += formatAnnotation(ann);
      }
    }
    lines.push(line);
  }

  return `${lines.join("\n")}\n`;
}

/** Hash input: VOM body **before** annotations are inserted. */
export function observationBodyForHash(vomText: string): string {
  return vomText;
}
