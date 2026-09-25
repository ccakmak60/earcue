import { describe, expect, it } from "vitest";
import {
  applyPanelAction,
  band,
  FALLBACK_PANELS,
  fingerprintText,
  MAX_PANELS,
  parsePanelKey,
  pickPanels,
  type PanelScore,
} from "@/lib/shared/dashboard";

const scores = (entries: Record<string, [number, number]>) =>
  new Map<string, PanelScore>(Object.entries(entries).map(([k, [useful, central]]) => [k, { useful, central }]));

describe("parsePanelKey", () => {
  it("takes the catalog's types and entity cards, nothing else", () => {
    expect(parsePanelKey("replies_owed")).toEqual({ type: "replies_owed", entityId: null });
    expect(parsePanelKey("entity:412")).toEqual({ type: "entity", entityId: "412" });
    for (const bad of ["entity", "entity:", "entity:0", "entity:1x", "<script>", "", null, 3]) expect(parsePanelKey(bad)).toBeNull();
  });
});

describe("pickPanels", () => {
  const candidates = ["recommendations", "replies_owed", "upcoming", "entity:1", "entity:2", "entity:3", "entity:4", "entity:5", "projects", "topics"];

  it("keeps what the model found useful, by useful plus central, pins first", () => {
    const { panels, filled } = pickPanels(
      candidates,
      scores({ recommendations: [0.9, 0.2], replies_owed: [0.6, 0.9], upcoming: [0.3, 1], projects: [0.8, 0.8], topics: [0.5, 0] }),
      ["topics"]
    );
    expect(panels).toEqual(["topics", "projects", "replies_owed", "recommendations"]);
    expect(filled).toBe(0);
  });

  it("caps entity cards at four and the page at eight", () => {
    const all = Object.fromEntries(candidates.map((k) => [k, [0.9, 0.5] as [number, number]]));
    const { panels } = pickPanels(candidates, scores(all), []);
    expect(panels.filter((k) => k.startsWith("entity:"))).toHaveLength(4);
    expect(panels).toHaveLength(MAX_PANELS);
    expect(panels).not.toContain("entity:5");
  });

  it("fills up to three from the fallback order when too few pass", () => {
    expect(pickPanels(candidates, scores({ projects: [0.9, 1] }), [])).toEqual({ panels: ["projects", "recommendations", "replies_owed"], filled: 2 });
  });

  it("keeps the fallback order, two entity cards at most, when the call failed", () => {
    const { panels } = pickPanels(candidates, null, ["entity:5"]);
    expect(panels).toEqual(["entity:5", "recommendations", "replies_owed", "upcoming", "entity:1", "projects"]);
    expect(panels).toHaveLength(FALLBACK_PANELS);
  });

  it("drops a pin that is no longer a candidate", () => {
    expect(pickPanels(["upcoming"], null, ["entity:9"]).panels).toEqual(["upcoming"]);
  });
});

describe("the fingerprint", () => {
  it("changes with a band, not with every count", () => {
    expect([0, 1, 2, 3, 5, 6, 40].map(band)).toEqual([0, 1, 1, 3, 3, 6, 6]);
    const a = fingerprintText([{ key: "replies_owed", count: 3 }, { key: "upcoming", count: 1 }], []);
    expect(fingerprintText([{ key: "upcoming", count: 2 }, { key: "replies_owed", count: 5 }], [])).toBe(a);
    expect(fingerprintText([{ key: "upcoming", count: 2 }, { key: "replies_owed", count: 6 }], [])).not.toBe(a);
    expect(fingerprintText([{ key: "upcoming", count: 2 }, { key: "replies_owed", count: 5 }], ["upcoming"])).not.toBe(a);
  });
});

describe("applyPanelAction", () => {
  const prefs = { panels: ["recommendations", "replies_owed", "entity:1"], pinned: [], hidden: ["topics"] };

  it("pins to the top, with earlier pins first", () => {
    const once = applyPanelAction(prefs, "entity:1", "pin");
    expect(once.panels).toEqual(["entity:1", "recommendations", "replies_owed"]);
    const twice = applyPanelAction(once, "replies_owed", "pin");
    expect(twice).toEqual({ panels: ["entity:1", "replies_owed", "recommendations"], pinned: ["entity:1", "replies_owed"], hidden: ["topics"] });
  });

  it("pinning a hidden panel unhides it and shows it", () => {
    expect(applyPanelAction(prefs, "topics", "pin")).toEqual({ panels: ["topics", "recommendations", "replies_owed", "entity:1"], pinned: ["topics"], hidden: [] });
  });

  it("hides from the page and the pins, and reset forgets both", () => {
    const hidden = applyPanelAction(applyPanelAction(prefs, "replies_owed", "pin"), "replies_owed", "hide");
    expect(hidden).toEqual({ panels: ["recommendations", "entity:1"], pinned: [], hidden: ["topics", "replies_owed"] });
    expect(applyPanelAction(hidden, "replies_owed", "reset")).toEqual({ panels: ["recommendations", "entity:1"], pinned: [], hidden: ["topics"] });
  });
});
