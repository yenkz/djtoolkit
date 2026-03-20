import { describe, it, expect } from "vitest";
import { isStepEnabled, getJobSettings } from "../job-settings";

describe("isStepEnabled", () => {
  it("returns true for fingerprint when not set (default enabled)", () => {
    expect(isStepEnabled({}, "fingerprint")).toBe(true);
  });

  it("returns true for cover_art when not set (default enabled)", () => {
    expect(isStepEnabled({}, "cover_art")).toBe(true);
  });

  it("returns false for audio_analysis when not set (default disabled)", () => {
    expect(isStepEnabled({}, "audio_analysis")).toBe(false);
  });

  it("returns false for loudnorm when not set (default disabled)", () => {
    expect(isStepEnabled({}, "loudnorm")).toBe(false);
  });

  it("respects explicit false for fingerprint", () => {
    expect(isStepEnabled({ fingerprint_enabled: false }, "fingerprint")).toBe(false);
  });

  it("respects explicit true for audio_analysis", () => {
    expect(isStepEnabled({ analysis_enabled: true }, "audio_analysis")).toBe(true);
  });
});

describe("getJobSettings", () => {
  it("returns download settings for download job type", () => {
    const settings = {
      min_score: 0.75,
      duration_tolerance_ms: 3000,
      search_timeout_sec: 20,
      coverart_sources: ["itunes"],
      fingerprint_enabled: false,
    };
    const result = getJobSettings(settings, "download");
    expect(result).toEqual({
      min_score: 0.75,
      duration_tolerance_ms: 3000,
      search_timeout_sec: 20,
    });
  });

  it("returns cover_art settings for cover_art job type", () => {
    const settings = {
      min_score: 0.75,
      coverart_sources: ["itunes", "deezer"],
    };
    const result = getJobSettings(settings, "cover_art");
    expect(result).toEqual({
      coverart_sources: ["itunes", "deezer"],
    });
  });

  it("returns empty object for job types with no tuning params", () => {
    const settings = { min_score: 0.75, coverart_sources: ["itunes"] };
    expect(getJobSettings(settings, "fingerprint")).toEqual({});
    expect(getJobSettings(settings, "metadata")).toEqual({});
    expect(getJobSettings(settings, "audio_analysis")).toEqual({});
  });

  it("returns empty object when settings has no relevant keys", () => {
    expect(getJobSettings({}, "download")).toEqual({});
  });
});
