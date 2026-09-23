import type { UsageTone } from "../shared/usage";

/**
 * Pure threshold-alert logic, kept free of runtime imports so `node --test` can
 * load it directly (see `usage-alerts.test.ts`).
 */

export interface AlertEntry {
  /** Stable identity of the quota: the same plan reports once, whatever is watching it. */
  key: string;
  subject: string;
  percent: number | null;
  tone: UsageTone;
}

export interface UsageAlert {
  key: string;
  message: string;
  variant: "warning" | "error";
}

/**
 * Alerts on the edge into `warning` or `danger`, per quota. `seen` is the
 * caller's memory of the last reported tone: an unchanged tone never reports
 * twice, and a quota that falls back to `normal` re-arms — so a plan that
 * oscillates around 70% speaks once per crossing rather than once per refresh.
 * Quotas without a percentage report nothing.
 */
export function collectUsageAlerts(
  seen: Map<string, UsageTone>,
  entries: readonly AlertEntry[],
): UsageAlert[] {
  const alerts: UsageAlert[] = [];
  for (const entry of entries) {
    if (seen.get(entry.key) === entry.tone) continue;
    seen.set(entry.key, entry.tone);
    if (entry.tone === "normal" || entry.percent === null) continue;
    alerts.push({
      key: entry.key,
      message: `${entry.subject} ${entry.percent}% used`,
      variant: entry.tone === "danger" ? "error" : "warning",
    });
  }
  return alerts;
}
