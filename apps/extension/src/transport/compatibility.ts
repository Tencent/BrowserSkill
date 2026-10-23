import { compareProtocol, parseProtocolMajor } from "@/lib/semver";
import { type FeatureName, featureRequirements } from "./generated/methods";

/** Requirements are generated from the Rust catalog, including popup guidance. */
export function supportsFeature(
  feature: FeatureName,
  peer: "daemon" | "extension",
  protocol: string,
): boolean {
  const requirement = featureRequirements.find((entry) => entry.feature === feature);
  if (!requirement) return false;
  const required = requirement[peer];
  const order = compareProtocol(protocol, required);
  return (
    order !== null && order >= 0 && parseProtocolMajor(protocol) === parseProtocolMajor(required)
  );
}
