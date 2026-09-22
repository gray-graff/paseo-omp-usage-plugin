import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState, type ComponentType, type ReactNode } from "react";
import { Text, View } from "react-native";
import type { PaseoProviderUsageResult } from "@getpaseo/client";
import type { PluginTheme } from "@getpaseo/plugin";
import { usePaseo, useRpc } from "@getpaseo/plugin/client";
import * as pluginUi from "@getpaseo/plugin/client/ui";
import {
  OMP_USAGE_REFRESH_MS,
  cardWindows,
  formatAmount,
  formatReset,
  formatStale,
  ompUsageRpc,
  percentOf,
  providerPlanUrl,
  toneForPercent,
  type OmpUsagePayload,
  type UsageTone,
} from "../shared/usage";
import { getPillManager } from "./pills";

/**
 * `ExternalLink` arrived in Paseo 0.9; on 0.8 the host exports nothing under
 * that name. Read it off the namespace so the plugin keeps loading on 0.8 and
 * simply omits the link there.
 */
const ExternalLink = (
  pluginUi as {
    ExternalLink?: ComponentType<{ href: string; children: ReactNode; accessibilityLabel?: string }>;
  }
).ExternalLink;

export interface UsageWindowView {
  id: string;
  label: string;
  /** Null when OMP reported no fraction for this window. */
  percent: number | null;
  tone: UsageTone;
  /** Absolute spend, only when it adds information beyond the percentage. */
  amountText: string | null;
  resetsAt: number | null;
  /** True for model-scoped quotas (Spark, gpt-reserve) shown apart from plan-wide ones. */
  special: boolean;
}

export interface UsageCard {
  key: string;
  providerId: string;
  title: string;
  planLabel: string | null;
  email: string | null;
  sourceLabel: string | null;
  errorText: string | null;
  /** Set when OMP is serving a snapshot it could not refresh; the numbers are old. */
  staleText: string | null;
  /** Vendor page where the plan is managed, offered alongside `staleText`. */
  planUrl: string | null;
  windows: UsageWindowView[];
}
export function useOmpUsage() {
  const fetchUsage = useRpc(ompUsageRpc);
  const queryClient = useQueryClient();
  const [isRefreshing, setIsRefreshing] = useState(false);
  const query = useQuery({
    queryKey: ["omp-usage"],
    queryFn: () => fetchUsage({}),
    refetchInterval: OMP_USAGE_REFRESH_MS,
    staleTime: 60_000,
    retry: 1,
  });
  /** Manual refresh; `force` bypasses the daemon-side 60s cache. */
  const refresh = useCallback(
    async (force = true) => {
      setIsRefreshing(true);
      try {
        const payload = await fetchUsage({ force });
        queryClient.setQueryData(["omp-usage"], payload);
        await getPillManager()?.refreshUsage(force);
        return payload;
      } finally {
        setIsRefreshing(false);
      }
    },
    [fetchUsage, queryClient],
  );
  return { ...query, refresh, isRefreshing };
}

export function useNativeUsage() {
  const paseo = usePaseo();
  return useQuery({
    queryKey: ["native-usage"],
    queryFn: () => paseo.providers.listUsage(),
    refetchInterval: 60_000,
    staleTime: 30_000,
    retry: 1,
  });
}

export function ompCards(data: OmpUsagePayload | undefined): UsageCard[] {
  if (!data) return [];
  return data.reports.map((report) => ({
    key: `omp:${report.provider}`,
    providerId: report.provider,
    title: report.displayName,
    planLabel: report.planLabel,
    email: report.email,
    sourceLabel: "via Oh My Pi",
    errorText: null,
    staleText: formatStale(report.fetchedAt, data.generatedAt),
    planUrl: providerPlanUrl(report.provider),
    windows: cardWindows(report).map((window) => {
      const percent = percentOf(window.usedFraction);
      return {
        id: window.id,
        label: window.label,
        percent,
        tone: toneForPercent(percent),
        // `22 / 100 percent` says nothing `22%` does not; credit counts do.
        amountText: window.unit === "percent" ? null : formatAmount(window.used, window.limit, window.unit),
        resetsAt: window.resetsAt,
        special: window.tier !== null,
      };
    }),
  }));
}

export function nativeCards(payload: PaseoProviderUsageResult | undefined): UsageCard[] {
  if (!payload) return [];
  return payload.providers.map((provider) => ({
    key: `native:${provider.providerId}`,
    providerId: provider.providerId,
    title: provider.displayName,
    planLabel: provider.planLabel,
    email: null,
    sourceLabel: provider.sourceLabel ?? null,
    errorText:
      provider.status === "error"
        ? (provider.error ?? "Usage unavailable")
        : provider.status === "unavailable"
          ? "Not configured"
          : null,
    staleText: null,
    planUrl: null,
    windows: provider.windows.map((window) => {
      const percent = window.usedPct ?? null;
      return {
        id: window.id,
        label: window.label,
        percent,
        tone: toneForPercent(percent),
        amountText: null,
        resetsAt: window.resetsAt != null ? Date.parse(window.resetsAt) : null,
        special: false,
      };
    }),
  }));
}

type ToneColor = "statusSuccess" | "statusWarning" | "statusDanger";

/** Fill color for the usage bar, on the same thresholds as the percentage text. */
export function toneFor(fraction: number | null): ToneColor {
  const tone = toneForPercent(percentOf(fraction));
  if (tone === "danger") return "statusDanger";
  if (tone === "warning") return "statusWarning";
  return "statusSuccess";
}

/** Below the warning threshold the percentage keeps the ordinary text color. */
function percentTextColor(theme: PluginTheme, tone: UsageTone): string {
  if (tone === "danger") return theme.colors.statusDanger;
  if (tone === "warning") return theme.colors.statusWarning;
  return theme.colors.foreground;
}

interface BarProps {
  theme: PluginTheme;
  fraction: number | null;
}

export function UsageBar({ theme, fraction }: BarProps) {
  const pct = percentOf(fraction) ?? 0;
  return (
    <View style={{ height: 6, borderRadius: 3, backgroundColor: theme.colors.surface2, overflow: "hidden" }}>
      <View
        style={{
          height: "100%",
          width: `${pct}%`,
          borderRadius: 3,
          backgroundColor: theme.colors[toneFor(fraction)],
        }}
      />
    </View>
  );
}

interface WindowRowProps {
  theme: PluginTheme;
  window: UsageWindowView;
}

export function UsageWindowRow({ theme, window }: WindowRowProps) {
  const reset = formatReset(window.resetsAt);
  const styles = useMemo(
    () => ({
      row: { gap: 6 },
      header: { flexDirection: "row" as const, justifyContent: "space-between" as const, gap: 12 },
      label: { color: theme.colors.foreground, fontSize: 13, fontWeight: "600" as const, flex: 1 },
      percent: {
        color: percentTextColor(theme, window.tone),
        fontSize: 13,
        fontWeight: "600" as const,
      },
      footer: { flexDirection: "row" as const, justifyContent: "space-between" as const, gap: 12 },
      amount: { color: theme.colors.foregroundMuted, fontSize: 12, flex: 1 },
      reset: { color: theme.colors.foregroundMuted, fontSize: 11 },
    }),
    [theme, window.tone],
  );

  return (
    <View style={styles.row}>
      <View style={styles.header}>
        <Text style={styles.label}>{window.label}</Text>
        <Text style={styles.percent}>{window.percent === null ? "—" : `${window.percent}%`}</Text>
      </View>
      <UsageBar theme={theme} fraction={window.percent === null ? null : window.percent / 100} />
      {window.amountText || reset ? (
        <View style={styles.footer}>
          <Text style={styles.amount}>{window.amountText ?? ""}</Text>
          {reset ? <Text style={styles.reset}>{reset}</Text> : null}
        </View>
      ) : null}
    </View>
  );
}

interface CardProps {
  theme: PluginTheme;
  layoutCompact: boolean;
  card: UsageCard;
}

export function UsageCardRow({ theme, layoutCompact, card }: CardProps) {
  const meta = [card.sourceLabel, card.email].filter(Boolean).join(" · ");
  const planLabel =
    card.planLabel && card.planLabel.trim().toLowerCase() !== card.title.trim().toLowerCase()
      ? card.planLabel
      : null;
  const general = card.windows.filter((window) => !window.special);
  const special = card.windows.filter((window) => window.special);
  const styles = useMemo(
    () => ({
      card: {
        backgroundColor: theme.colors.surface1,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: theme.colors.border,
        padding: layoutCompact ? 12 : 14,
        gap: layoutCompact ? 10 : 12,
      },
      header: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
      title: { color: theme.colors.foreground, fontSize: 15, fontWeight: "600" as const, flex: 1 },
      chip: {
        color: theme.colors.foregroundMuted,
        fontSize: 11,
        backgroundColor: theme.colors.surface2,
        paddingHorizontal: 8,
        paddingVertical: 3,
        borderRadius: 999,
        overflow: "hidden" as const,
      },
      meta: { color: theme.colors.foregroundMuted, fontSize: 12 },
      stale: { color: theme.colors.statusWarning, fontSize: 11 },
      link: { color: theme.colors.accent, fontSize: 11 },
      error: { color: theme.colors.statusDanger, fontSize: 12 },
      windows: { gap: layoutCompact ? 10 : 12 },
      specialGroup: {
        gap: layoutCompact ? 10 : 12,
        borderTopWidth: 1,
        borderTopColor: theme.colors.border,
        paddingTop: layoutCompact ? 10 : 12,
      },
      specialTitle: {
        color: theme.colors.foregroundMuted,
        fontSize: 11,
        fontWeight: "600" as const,
        textTransform: "uppercase" as const,
        letterSpacing: 0.5,
      },
    }),
    [theme, layoutCompact],
  );

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Text style={styles.title}>{card.title}</Text>
        {planLabel ? <Text style={styles.chip}>{planLabel}</Text> : null}
      </View>
      {meta ? <Text style={styles.meta}>{meta}</Text> : null}
      {card.staleText ? (
        <>
          <Text style={styles.stale}>{card.staleText}</Text>
          {card.planUrl && ExternalLink ? (
            <ExternalLink href={card.planUrl} accessibilityLabel={`Manage the ${card.title} plan`}>
              <Text style={styles.link}>Manage this plan ↗</Text>
            </ExternalLink>
          ) : null}
        </>
      ) : null}
      {card.errorText ? <Text style={styles.error}>{card.errorText}</Text> : null}
      {general.length > 0 ? (
        <View style={styles.windows}>
          {general.map((window) => (
            <UsageWindowRow key={window.id} theme={theme} window={window} />
          ))}
        </View>
      ) : null}
      {special.length > 0 ? (
        <View style={styles.specialGroup}>
          <Text style={styles.specialTitle}>Model quotas</Text>
          {special.map((window) => (
            <UsageWindowRow key={window.id} theme={theme} window={window} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

interface ListProps {
  theme: PluginTheme;
  layoutCompact: boolean;
  cards: UsageCard[];
  emptyText: string;
}

export function UsageCardList({ theme, layoutCompact, cards, emptyText }: ListProps) {
  const styles = useMemo(
    () => ({
      list: { gap: layoutCompact ? 8 : 10 },
      empty: { color: theme.colors.foregroundMuted, fontSize: 13 },
    }),
    [theme, layoutCompact],
  );
  if (cards.length === 0) {
    return <Text style={styles.empty}>{emptyText}</Text>;
  }
  return (
    <View style={styles.list}>
      {cards.map((card) => (
        <UsageCardRow key={card.key} theme={theme} layoutCompact={layoutCompact} card={card} />
      ))}
    </View>
  );
}
