import type { PhaseOneRuntime, ToolRegistrar } from "./phase-one-runtime";
import { registerPhaseOneInteractionTools } from "./phase-one-tools-interaction";
import { registerPhaseOneNavigationTools } from "./phase-one-tools-navigation";
import { registerPhaseOneSupportTools } from "./phase-one-tools-support";
import { registerPhaseOneTabTools } from "./phase-one-tools-tabs";
import type { ToolDeps } from "./tools";

/** Register the first DSH capability-parity tranche on the existing runtime. */
export function registerPhaseOneTools(
  deps: ToolDeps,
  register: ToolRegistrar,
  runtime: PhaseOneRuntime,
): void {
  registerPhaseOneInteractionTools(deps, register, runtime);
  registerPhaseOneTabTools(deps, register, runtime);
  registerPhaseOneNavigationTools(deps, register, runtime);
  registerPhaseOneSupportTools(deps, register, runtime);
}
