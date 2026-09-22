import type { RemixiconComponentType } from "@remixicon/react";
import { RiHistoryLine, RiRecordCircleLine, RiScreenshot2Line } from "@remixicon/react";

export type PopupFeatureId = "record" | "long-screenshot" | "audit";

export type PopupView = "main" | "features" | PopupFeatureId;

export type PopupFeature = {
  id: PopupFeatureId;
  icon: RemixiconComponentType;
  titleKey: "popup.record.sectionTitle" | "longScreenshot.title" | "audit.title";
  descKey: "popup.record.cardDesc" | "longScreenshot.cardDesc" | "audit.cardDesc";
};

export const POPUP_FEATURES: PopupFeature[] = [
  {
    id: "long-screenshot",
    icon: RiScreenshot2Line,
    titleKey: "longScreenshot.title",
    descKey: "longScreenshot.cardDesc",
  },
  {
    id: "record",
    icon: RiRecordCircleLine,
    titleKey: "popup.record.sectionTitle",
    descKey: "popup.record.cardDesc",
  },
  { id: "audit", icon: RiHistoryLine, titleKey: "audit.title", descKey: "audit.cardDesc" },
];
