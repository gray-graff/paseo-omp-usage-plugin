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
        /** When OMP last reached the provider; older than `generatedAt` means a cached snapshot. */
        fetchedAt: z.number().nullable(),
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

/** Verified from `omp models --json` at OMP 18.1.20; unknown models never guess Spark. */
const CONFIRMED_CODEX_SPARK_MODEL_IDS: Record<string, true> = {
  gpt53codexspark: true,
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

function normalizeModelRef(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
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
  return normalizeModelRef(model).includes(normalizeModelRef(window.modelId));
}

/** Spark is a model property, not a property of whatever usage windows arrived. */
function isConfirmedCodexSparkModel(model: string | null | undefined): boolean {
  if (!model || modelProviderPrefix(model) !== "openai-codex") return false;
  const slash = model.indexOf("/");
  const modelId = slash === -1 ? model : model.slice(slash + 1);
  return CONFIRMED_CODEX_SPARK_MODEL_IDS[normalizeModelRef(modelId)] === true;
}

/**
 * Windows that apply to the model, shortest first: 5 hours, then week, then month.
 *
 * Codex mirrors OMP v18.1.20's `scopeCodexLimitsForRequest`: a Spark model
 * consumes only `openai-codex:spark:*`; every other Codex model consumes only
 * the chat windows `primary` and `secondary`.
 */
export function pillWindows(report: OmpUsageReport, model: string | null | undefined): OmpUsageWindow[] {
  let windows: OmpUsageWindow[];
  if (report.provider === "openai-codex") {
    const isSparkModel = isConfirmedCodexSparkModel(model);
    windows = isSparkModel
      ? report.windows.filter((window) => window.id.startsWith("openai-codex:spark:"))
      : report.windows.filter(
          (window) =>
            window.id === "openai-codex:primary" || window.id === "openai-codex:secondary",
        );
  } else {
    windows = report.windows.filter((window) => windowAppliesToModel(window, model));
  }
  return windows.sort((a, b) => windowRank(a) - windowRank(b) || a.id.localeCompare(b.id));
}
/**
 * Windows the compact indicator can represent. The text and tick gauge share
 * this list, so a missing fraction never shifts their positions or gains color.
 */
export function pillDisplayWindows(
  report: OmpUsageReport,
  model: string | null | undefined,
): OmpUsageWindow[] {
  return pillWindows(report, model).filter((window) => window.usedFraction !== null);
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
 * Percentages join with `/` under a single `%`; the matching tick gauge uses
 * the same known-fraction windows.
 */
export function pillText(report: OmpUsageReport, model: string | null | undefined): string {
  const percents = pillDisplayWindows(report, model)
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

/**
 * OMP keeps serving a provider's last successful snapshot when its API stops
 * answering (expired subscription, revoked key) without flagging it, so treat a
 * report much older than the snapshot itself as stale. The threshold sits above
 * OMP's own per-provider refresh interval to avoid crying stale on fresh data.
 */
export const STALE_AFTER_MS = 30 * 60 * 1000;

function formatAge(ms: number): string {
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/** Age note for a report OMP could not refresh, or null while the data is current. */
export function formatStale(fetchedAt: number | null, referenceAt: number | null): string | null {
  if (fetchedAt === null) return null;
  const reference = referenceAt ?? Date.now();
  const age = reference - fetchedAt;
  if (age < STALE_AFTER_MS) return null;
  return `stale · OMP last reached this provider ${formatAge(age)} ago`;
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
