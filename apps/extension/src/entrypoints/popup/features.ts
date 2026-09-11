import type { RemixiconComponentType } from "@remixicon/react";
import { RiHistoryLine, RiRecordCircleLine } from "@remixicon/react";

export type PopupFeatureId = "record" | "audit";

export type PopupView = "main" | "features" | PopupFeatureId;

export type PopupFeature = {
  id: PopupFeatureId;
  icon: RemixiconComponentType;
  titleKey: "popup.record.sectionTitle" | "audit.title";
  descKey: "popup.record.cardDesc" | "audit.cardDesc";
};

export const POPUP_FEATURES: PopupFeature[] = [
  {
    id: "record",
    icon: RiRecordCircleLine,
    titleKey: "popup.record.sectionTitle",
    descKey: "popup.record.cardDesc",
  },
  { id: "audit", icon: RiHistoryLine, titleKey: "audit.title", descKey: "audit.cardDesc" },
];
