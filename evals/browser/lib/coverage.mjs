import { OPERATION_CATALOG, WORKFLOW_ACTION_OPERATIONS } from "./operations.mjs";

export function buildOperationCoverage(cases) {
  return OPERATION_CATALOG.map(({ operation, manualNote }) => {
    const agentCases = cases
      .filter((testCase) => testCase.coverage.includes(operation))
      .map(({ id }) => id);
    let smokeCases;
    if (["session.start", "session.stop", "session.list"].includes(operation)) {
      smokeCases = cases.filter(({ smokeSteps }) => smokeSteps.length > 0).map(({ id }) => id);
    } else {
      smokeCases = cases
        .filter(({ smokeSteps }) =>
          smokeSteps.some((step) => WORKFLOW_ACTION_OPERATIONS[step.action] === operation),
        )
        .map(({ id }) => id);
    }
    return {
      operation,
      agentCases,
      smokeCases,
      directSmoke: smokeCases.length > 0,
      note: smokeCases.length === 0 && manualNote ? `manual lane: ${manualNote}` : undefined,
    };
  });
}
