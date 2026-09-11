import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import type { PaseoProviderUsageResult } from "@getpaseo/client";
import type { PluginTheme } from "@getpaseo/plugin";
import { usePaseo, useRpc } from "@getpaseo/plugin/client";
import {
  OMP_USAGE_REFRESH_MS,
  formatAmount,
  formatReset,
  ompUsageRpc,
  type OmpUsagePayload,
} from "../shared/usage";
import { getPillManager } from "./pills";

export interface UsageWindowView {
  id: string;
  label: string;
  usedFraction: number | null;
  amountText: string | null;
  resetsAt: number | null;
}

export interface UsageCard {
  key: string;
  providerId: string;
  title: string;
  planLabel: string | null;
  email: string | null;
  sourceLabel: string | null;
  errorText: string | null;
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
    windows: report.windows.map((window) => ({
      id: window.id,
      label: window.label,
      usedFraction: window.usedFraction,
      amountText: formatAmount(window.used, window.limit, window.unit),
      resetsAt: window.resetsAt,
    })),
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
    windows: provider.windows.map((window) => ({
      id: window.id,
      label: window.label,
      usedFraction: window.usedPct != null ? window.usedPct / 100 : null,
      amountText: null,
      resetsAt: window.resetsAt != null ? Date.parse(window.resetsAt) : null,
    })),
  }));
}

type ToneColor = "statusSuccess" | "statusWarning" | "statusDanger";

export function toneFor(fraction: number | null): ToneColor {
  if (fraction === null) return "statusSuccess";
  if (fraction >= 0.9) return "statusDanger";
  if (fraction >= 0.7) return "statusWarning";
  return "statusSuccess";
}

interface BarProps {
  theme: PluginTheme;
  fraction: number | null;
}

export function UsageBar({ theme, fraction }: BarProps) {
  const pct = fraction === null ? 0 : Math.round(Math.min(1, Math.max(0, fraction)) * 100);
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
  layoutCompact: boolean;
  window: UsageWindowView;
}

export function UsageWindowRow({ theme, layoutCompact, window }: WindowRowProps) {
  const reset = formatReset(window.resetsAt);
  const styles = useMemo(
    () => ({
      row: { gap: 6 },
      header: { flexDirection: "row" as const, justifyContent: "space-between" as const, gap: 12 },
      label: { color: theme.colors.foreground, fontSize: 13, fontWeight: "600" as const, flex: 1 },
      amount: { color: theme.colors.foregroundMuted, fontSize: 12 },
      reset: { color: theme.colors.foregroundMuted, fontSize: 11, textAlign: "right" as const },
    }),
    [theme],
  );

  return (
    <View style={styles.row}>
      <View style={styles.header}>
        <Text style={styles.label}>{window.label}</Text>
        {window.amountText ? <Text style={styles.amount}>{window.amountText}</Text> : null}
      </View>
      <UsageBar theme={theme} fraction={window.usedFraction} />
      {reset ? <Text style={styles.reset}>{reset}</Text> : null}
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
      error: { color: theme.colors.statusDanger, fontSize: 12 },
      windows: { gap: layoutCompact ? 10 : 12 },
    }),
    [theme, layoutCompact],
  );

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Text style={styles.title}>{card.title}</Text>
        {card.planLabel ? <Text style={styles.chip}>{card.planLabel}</Text> : null}
      </View>
      {meta ? <Text style={styles.meta}>{meta}</Text> : null}
      {card.errorText ? <Text style={styles.error}>{card.errorText}</Text> : null}
      {card.windows.length > 0 ? (
        <View style={styles.windows}>
          {card.windows.map((window) => (
            <UsageWindowRow key={window.id} theme={theme} layoutCompact={layoutCompact} window={window} />
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
