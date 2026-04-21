import { describe, it, expect } from "vitest";
import { stepToIndex, STEP_LABELS } from "./step-index";

describe("stepToIndex", () => {
  it("maps entry → 0", () => {
    expect(stepToIndex("entry")).toBe(0);
  });

  it("maps venue-browse and mood both to 1 (parallel paths)", () => {
    expect(stepToIndex("venue-browse")).toBe(1);
    expect(stepToIndex("mood")).toBe(1);
  });

  it("maps venue-detail → 2, seeds → 3, results → 4", () => {
    expect(stepToIndex("venue-detail")).toBe(2);
    expect(stepToIndex("seeds")).toBe(3);
    expect(stepToIndex("results")).toBe(4);
  });

  it("exports 5 step labels", () => {
    expect(STEP_LABELS).toEqual(["Entry", "Venue", "Setup", "Seeds", "Results"]);
  });
});
