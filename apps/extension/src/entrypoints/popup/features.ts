import type { RemixiconComponentType } from "@remixicon/react";
import { RiRecordCircleLine } from "@remixicon/react";

export type PopupFeatureId = "record";

export type PopupView = "main" | "features" | PopupFeatureId;

export type PopupFeature = {
  id: PopupFeatureId;
  icon: RemixiconComponentType;
  titleKey: "popup.record.sectionTitle";
  descKey: "popup.record.cardDesc";
};

export const POPUP_FEATURES: PopupFeature[] = [
  {
    id: "record",
    icon: RiRecordCircleLine,
    titleKey: "popup.record.sectionTitle",
    descKey: "popup.record.cardDesc",
  },
];
