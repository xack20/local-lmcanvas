import type { ReasoningEffort } from "@shared/types";

export const LABEL_BY_EFFORT: Record<ReasoningEffort, string> = {
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "extra high",
  max: "max",
  ultra: "ultra",
};

export const SHORT_LABEL_BY_EFFORT: Record<ReasoningEffort, string> = {
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "x-high",
  max: "max",
  ultra: "ultra",
};
