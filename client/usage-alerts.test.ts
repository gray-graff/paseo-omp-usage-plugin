import assert from "node:assert/strict";
import { test } from "node:test";
import { STALE_AFTER_MS, isStale, pillText, type OmpUsageReport } from "../shared/usage.ts";
import { collectUsageAlerts } from "./usage-alerts.ts";

const HOUR_MS = 60 * 60 * 1000;

function entry(percent: number | null): { key: string; subject: string; percent: number | null; tone: "normal" | "warning" | "danger" } {
  const tone = percent === null ? "normal" : percent >= 90 ? "danger" : percent >= 70 ? "warning" : "normal";
  return { key: "zai|zai:5h", subject: "Z.AI 5h", percent, tone };
}

test("alerts fire on the edge into a higher tone, not on every refresh", () => {
  const seen = new Map<string, "normal" | "warning" | "danger">();

  const first = collectUsageAlerts(seen, [entry(74)]);
  assert.deepEqual(first, [{ key: "zai|zai:5h", message: "Z.AI 5h 74% used", variant: "warning" }]);

  assert.deepEqual(collectUsageAlerts(seen, [entry(78)]), [], "the same tone stays quiet");
  assert.deepEqual(collectUsageAlerts(seen, [entry(95)]), [
    { key: "zai|zai:5h", message: "Z.AI 5h 95% used", variant: "error" },
  ]);
  assert.deepEqual(collectUsageAlerts(seen, [entry(96)]), [], "danger reports once");
});

test("a quota recovering to normal re-arms its alert", () => {
  const seen = new Map<string, "normal" | "warning" | "danger">();
  collectUsageAlerts(seen, [entry(95)]);
  assert.deepEqual(collectUsageAlerts(seen, [entry(20)]), []);
  assert.equal(collectUsageAlerts(seen, [entry(91)]).length, 1, "the next crossing speaks again");
});

test("a quota without a percentage never alerts", () => {
  const seen = new Map<string, "normal" | "warning" | "danger">();
  assert.deepEqual(collectUsageAlerts(seen, [entry(null)]), []);
});

test("staleness starts one threshold after the last successful fetch", () => {
  const fetchedAt = 1_700_000_000_000;
  assert.equal(isStale(fetchedAt, fetchedAt + STALE_AFTER_MS - 1), false);
  assert.equal(isStale(fetchedAt, fetchedAt + STALE_AFTER_MS), true);
  assert.equal(isStale(null, fetchedAt), false, "a report OMP never stamped is not stale");
});

const report: OmpUsageReport = {
  provider: "zai",
  displayName: "Z.AI",
  fetchedAt: 1_700_000_000_000,
  planLabel: null,
  email: null,
  windows: [
    {
      id: "zai:5h",
      label: "5h",
      windowId: "5h",
      durationMs: 5 * HOUR_MS,
      tier: null,
      modelId: null,
      used: 22,
      limit: 100,
      unit: "percent",
      usedFraction: 0.22,
      resetsAt: null,
    },
  ],
};

test("the pill marks percentages that come from a snapshot OMP could not refresh", () => {
  assert.equal(pillText(report, null), "Z.AI 22%");
  assert.equal(pillText(report, null, true), "Z.AI ~22%");
});

test("the pill shows a dash rather than a made-up zero when no window has a fraction", () => {
  const unknown: OmpUsageReport = {
    ...report,
    windows: [{ ...report.windows[0], usedFraction: null }],
  };
  assert.equal(pillText(unknown, null), "Z.AI —");
  assert.equal(pillText(unknown, null, true), "Z.AI —", "a stale dash gains nothing from a marker");
});
