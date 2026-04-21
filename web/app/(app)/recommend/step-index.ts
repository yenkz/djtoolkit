export type Step = "entry" | "venue-browse" | "venue-detail" | "mood" | "seeds" | "results";

export const STEP_LABELS = ["Entry", "Venue", "Setup", "Seeds", "Results"] as const;

export function stepToIndex(step: Step): number {
  switch (step) {
    case "entry":        return 0;
    case "venue-browse": return 1;
    case "mood":         return 1;
    case "venue-detail": return 2;
    case "seeds":        return 3;
    case "results":      return 4;
  }
}
