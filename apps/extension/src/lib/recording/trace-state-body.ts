import type { StepAnnotation } from "./types";

function annotationText(annotation: StepAnnotation, stepId: number): string {
  return ` ⟵ step ${stepId}: ${annotation.op}${annotation.detail ? `: ${annotation.detail}` : ""}`;
}

export function formatTraceStateBody(input: {
  stateId: string;
  url: string;
  title?: string;
  stepIds: number[];
  vomText: string;
  annotations: StepAnnotation[];
  stepIdByDraftId: Map<number, number>;
}): string {
  const lines = ["# bsk-observation 1", `state: ${JSON.stringify(input.stateId)}`];
  lines.push(`url: ${JSON.stringify(input.url)}`);
  if (input.title) lines.push(`title: ${JSON.stringify(input.title)}`);
  if (input.stepIds.length > 0) lines.push(`steps_here: [${input.stepIds.join(", ")}]`);
  lines.push("---");

  const byLine = new Map<number, Array<{ annotation: StepAnnotation; stepId: number }>>();
  for (const annotation of input.annotations) {
    const stepId = input.stepIdByDraftId.get(annotation.draftId);
    if (stepId === undefined) continue;
    const bucket = byLine.get(annotation.line) ?? [];
    bucket.push({ annotation, stepId });
    byLine.set(annotation.line, bucket);
  }

  input.vomText.split("\n").forEach((bodyLine, lineIndex) => {
    let line = bodyLine;
    for (const item of byLine.get(lineIndex) ?? []) {
      line += annotationText(item.annotation, item.stepId);
    }
    lines.push(line);
  });
  return `${lines.join("\n")}\n`;
}
