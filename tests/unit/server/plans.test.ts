import { afterEach, describe, expect, it } from "vitest";
import { isEntitled } from "@/lib/server/entitlement";
import { capsFor, effectivePlan, PLANS } from "@/lib/server/plans";

const POLAR = { POLAR_ACCESS_TOKEN: "t", POLAR_WEBHOOK_SECRET: "s", POLAR_PRODUCT_ID_PRO: "p" };

describe("effectivePlan", () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("gives an unpaid account the free plan while billing is off", () => {
    process.env.BILLING_ENABLED = "0";
    expect(effectivePlan("none")).toBe("free");
    expect(effectivePlan(null)).toBe("free");
    expect(effectivePlan("pro")).toBe("pro");
    expect(isEntitled({ plan: effectivePlan("none") })).toBe(true);
  });

  it("keeps the paywall for an unpaid account once billing is on", () => {
    Object.assign(process.env, POLAR, { BILLING_ENABLED: "1" });
    expect(effectivePlan("none")).toBe("none");
    expect(effectivePlan(null)).toBe("none");
    expect(isEntitled({ plan: effectivePlan("none") })).toBe(false);
  });

  // BILLING_ENABLED=1 with a Polar var missing counts as billing off (billingEnabled in env.ts).
  it("treats half-configured billing as off", () => {
    Object.assign(process.env, { BILLING_ENABLED: "1", POLAR_ACCESS_TOKEN: "" });
    expect(effectivePlan("none")).toBe("free");
  });
});

describe("free plan caps", () => {
  it("allow the recommendation path and no capture", () => {
    const caps = capsFor({ plan: "free" });
    expect(caps).toBe(PLANS.free);
    for (const key of ["audioSeconds", "frames", "watchCalls", "reviews"] as const) expect(caps[key]).toBe(0);
    for (const key of ["assistCalls", "connectorSyncs", "importItems", "distills", "recalls"] as const) {
      expect(caps[key]).toBeGreaterThan(0);
      expect(caps[key]).toBeLessThanOrEqual(PLANS.pro[key]);
    }
  });
});
