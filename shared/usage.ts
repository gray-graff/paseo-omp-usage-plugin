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
            used: z.number().nullable(),
            limit: z.number().nullable(),
            unit: z.string().nullable(),
            usedFraction: z.number(),
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

export function providerDisplayName(provider: string): string {
  return PROVIDER_DISPLAY_NAMES[provider] ?? provider;
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
/** Pill shows the first two windows (short session window, then long period) as NN%/NN%. */
export function pillWindowPercents(report: OmpUsageReport): number[] {
  return report.windows.slice(0, 2).map((window) => window.usedFraction);
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
/** Hottest window fraction of a report, for pill labels. */
export function hottestWindowFraction(report: OmpUsageReport): number {
  let hottest = 0;
  for (const window of report.windows) {
    if (window.usedFraction > hottest) hottest = window.usedFraction;
  }
  return hottest;
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
