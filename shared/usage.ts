import { defineRpc, type RpcOutput } from "@getpaseo/plugin";
import { z } from "zod";

/** How often the client refetches; the daemon-side handler caches harder. */
export const OMP_USAGE_REFRESH_MS = 5 * 60 * 1000;

export const ompUsageRpc = defineRpc({
  name: "omp-usage.get",
  input: z.object({ force: z.boolean().optional() }).strict(),
  output: z.object({
    generatedAt: z.number().nullable(),
    reports: z.array(
      z.object({
        provider: z.string(),
        displayName: z.string(),
        planLabel: z.string().nullable(),
        email: z.string().nullable(),
        windows: z.array(
          z.object({
            id: z.string(),
            label: z.string(),
            /** OMP window id: `5h`, `7d`, `monthly`, …; null when the provider omits it. */
            windowId: z.string().nullable(),
            /** Null for windows OMP reports without a duration, such as `monthly`. */
            durationMs: z.number().nullable(),
            /** Set on quotas that belong to one model instead of the whole account. */
            tier: z.string().nullable(),
            modelId: z.string().nullable(),
            used: z.number().nullable(),
            limit: z.number().nullable(),
            unit: z.string().nullable(),
            usedFraction: z.number().nullable(),
            resetsAt: z.number().nullable(),
          }),
        ),
      }),
    ),
    error: z.string().nullable(),
  }),
});

export type OmpUsagePayload = RpcOutput<typeof ompUsageRpc>;
export type OmpUsageReport = OmpUsagePayload["reports"][number];
export type OmpUsageWindow = OmpUsageReport["windows"][number];

const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  zai: "Z.AI",
  "opencode-go": "OpenCode Go",
  "openai-codex": "Codex",
};

/** Names short enough to survive a phone-width composer pill. */
const PROVIDER_SHORT_NAMES: Record<string, string> = {
  zai: "Z.AI",
  "opencode-go": "Go",
  "openai-codex": "Codex",
};

export function providerDisplayName(provider: string): string {
  return PROVIDER_DISPLAY_NAMES[provider] ?? provider;
}

export function providerShortName(provider: string): string {
  return PROVIDER_SHORT_NAMES[provider] ?? providerDisplayName(provider);
}

/** Model reference `provider/id` → provider segment, or the agent provider itself. */
export function modelProviderPrefix(model: string | null | undefined): string | null {
  if (!model) return null;
  const idx = model.indexOf("/");
  return idx === -1 ? model : model.slice(0, idx);
}

/** Usage provider ids relevant to one agent's current model. */
export function usageProvidersForModel(model: string | null | undefined, agentProvider?: string | null): string[] {
  const prefix = modelProviderPrefix(model);
  if (prefix && model && model.includes("/")) {
    return prefix === "openai-codex" || prefix === "openai"
      ? ["openai-codex", "codex"]
      : [prefix];
  }
  return agentProvider ? [agentProvider] : [];
}

export type UsageTone = "normal" | "warning" | "danger";

/** Rounded percentage the UI shows; null when the window reports no fraction. */
export function percentOf(fraction: number | null): number | null {
  if (fraction === null || !Number.isFinite(fraction)) return null;
  return Math.round(Math.min(1, Math.max(0, fraction)) * 100);
}

/** Tone from the number on screen: under 70% neutral, 70-89% amber, 90% and up red. */
export function toneForPercent(percent: number | null): UsageTone {
  if (percent === null) return "normal";
  if (percent >= 90) return "danger";
  if (percent >= 70) return "warning";
  return "normal";
}

const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

/** OMP omits `durationMs` on some windows (`monthly`); rank those after every timed one. */
function windowRank(window: OmpUsageWindow): number {
  if (window.durationMs !== null) return window.durationMs;
  return window.windowId === "monthly" ? MONTH_MS : Number.MAX_SAFE_INTEGER;
}

/**
 * A quota with a tier belongs to the one model it names. OMP reports that model
 * as a display name (`GPT-5.3-Codex-Spark`) while the agent carries a selector
 * (`openai-codex/gpt-5.3-codex-spark`), so compare normalized text. A tier
 * without a model id stays unproven and never reaches the indicator.
 */
export function windowAppliesToModel(window: OmpUsageWindow, model: string | null | undefined): boolean {
  if (window.tier === null) return true;
  if (!model || !window.modelId) return false;
  const strip = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
  return strip(model).includes(strip(window.modelId));
}

/** Windows that apply to the model, shortest first: 5 hours, then week, then month. */
export function pillWindows(report: OmpUsageReport, model: string | null | undefined): OmpUsageWindow[] {
  return report.windows
    .filter((window) => windowAppliesToModel(window, model))
    .sort((a, b) => windowRank(a) - windowRank(b) || a.id.localeCompare(b.id));
}

/** Card order: account-wide quotas first, then model tiers, shortest window first. */
export function cardWindows(report: OmpUsageReport): OmpUsageWindow[] {
  return [...report.windows].sort(
    (a, b) =>
      Number(a.tier !== null) - Number(b.tier !== null) ||
      windowRank(a) - windowRank(b) ||
      a.id.localeCompare(b.id),
  );
}

/**
 * Composer-pill text: `Codex 22/0%`, or `Codex 22%` when one window applies.
 * Percentages join with `/` under a single `%`; a window without a fraction is
 * skipped rather than reported as 0%.
 */
export function pillText(report: OmpUsageReport, model: string | null | undefined): string {
  const percents = pillWindows(report, model)
    .map((window) => percentOf(window.usedFraction))
    .filter((percent): percent is number => percent !== null);
  const name = providerShortName(report.provider);
  return percents.length === 0 ? `${name} —` : `${name} ${percents.join("/")}%`;
}

type TimelinePage = {
  entries?: readonly {
    item?: { metadata?: { source?: unknown; model?: unknown } };
  }[];
};

/** Latest OMP fallback model from a fetched agent timeline. */
export function fallbackModelFromTimeline(page: unknown): string | null {
  const entries = (page as TimelinePage).entries;
  if (!entries) return null;
  for (const entry of [...entries].reverse()) {
    const metadata = entry.item?.metadata;
    if (metadata?.source === "omp_retry_fallback_succeeded" && typeof metadata.model === "string") {
      return metadata.model;
    }
  }
  return null;
}

export function formatReset(resetsAt: number | null): string | null {
  if (resetsAt === null) return null;
  const ms = resetsAt - Date.now();
  if (ms <= 0) return "resets soon";
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `resets in ${mins}m`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  if (hours < 48) return rem > 0 ? `resets in ${hours}h ${rem}m` : `resets in ${hours}h`;
  return `resets in ${Math.floor(hours / 24)}d`;
}

export function formatAmount(used: number | null, limit: number | null, unit: string | null): string | null {
  if (used === null || limit === null) return null;
  const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
  return unit ? `${fmt(used)} / ${fmt(limit)} ${unit}` : `${fmt(used)} / ${fmt(limit)}`;
}
