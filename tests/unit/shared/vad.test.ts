import { describe, expect, it } from "vitest";
import { isVoiced, updateFloor } from "@/lib/shared/vad";

describe("isVoiced", () => {
  it("accepts audio above both floors", () => {
    expect(isVoiced(0.05, 0.004)).toBe(true);
  });
  it("rejects audio below the absolute floor", () => {
    expect(isVoiced(0.006, 0.004)).toBe(false);
  });
  it("rejects audio below 3x a noisy floor", () => {
    expect(isVoiced(0.02, 0.01)).toBe(false);
  });
});

describe("updateFloor", () => {
  it("falls quickly toward a quiet sample", () => {
    expect(updateFloor(0.02, 0.001)).toBeLessThan(0.02);
  });
  it("rises slowly toward a loud sample", () => {
    expect(updateFloor(0.001, 0.02)).toBeLessThan(0.002);
  });
});
