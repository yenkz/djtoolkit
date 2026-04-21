import { describe, it, expect } from "vitest";
import { getGreeting } from "./greeting";

describe("getGreeting", () => {
  it("returns 'Good morning' for 00:00–11:59", () => {
    expect(getGreeting(0)).toBe("Good morning");
    expect(getGreeting(11)).toBe("Good morning");
  });
  it("returns 'Good afternoon' for 12:00–17:59", () => {
    expect(getGreeting(12)).toBe("Good afternoon");
    expect(getGreeting(17)).toBe("Good afternoon");
  });
  it("returns 'Good evening' for 18:00–23:59", () => {
    expect(getGreeting(18)).toBe("Good evening");
    expect(getGreeting(23)).toBe("Good evening");
  });
});
