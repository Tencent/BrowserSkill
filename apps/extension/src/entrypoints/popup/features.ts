import type { RemixiconComponentType } from "@remixicon/react";
import {
  RiBugLine,
  RiHistoryLine,
  RiRecordCircleLine,
  RiScreenshot2Line,
  RiVideoLine,
} from "@remixicon/react";

export type PopupFeatureId = "record" | "video" | "long-screenshot" | "audit" | "debug";

export type PopupView = "main" | "features" | PopupFeatureId;

export type PopupFeature = {
  id: PopupFeatureId;
  icon: RemixiconComponentType;
  titleKey:
    | "video.title"
    | "popup.record.sectionTitle"
    | "longScreenshot.title"
    | "audit.title"
    | "debug.title";
  descKey:
    | "video.cardDesc"
    | "popup.record.cardDesc"
    | "longScreenshot.cardDesc"
    | "audit.cardDesc"
    | "debug.cardDesc";
};

export const POPUP_FEATURES: PopupFeature[] = [
  { id: "video", icon: RiVideoLine, titleKey: "video.title", descKey: "video.cardDesc" },
  { id: "debug", icon: RiBugLine, titleKey: "debug.title", descKey: "debug.cardDesc" },
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
