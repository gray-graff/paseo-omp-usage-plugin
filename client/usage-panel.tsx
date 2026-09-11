import { useCallback, useMemo, useSyncExternalStore } from "react";
import { ActivityIndicator, ScrollView, Text, View } from "react-native";
import type { PluginAgentPanelProps } from "@getpaseo/plugin/client";
import { usageProvidersForModel } from "../shared/usage";
import { getPillManager, type PillAgentState } from "./pills";
import { UsageCardList, ompCards, useOmpUsage, type UsageCard } from "./usage-cards";

/** Agent panel: plan for the agent's effective (fallback-aware) model, then other OMP plans. */
export function OmpUsagePanel({ theme, layout, agentId }: PluginAgentPanelProps) {
  const subscribe = useCallback(
    (listener: () => void) => getPillManager()?.subscribe(agentId, listener) ?? (() => {}),
    [agentId],
  );
  const getSnapshot = useCallback(
    (): PillAgentState | null => getPillManager()?.getAgent(agentId) ?? null,
    [agentId],
  );
  const agent = useSyncExternalStore(subscribe, getSnapshot, () => null);

  const omp = useOmpUsage();
  const allCards = useMemo<UsageCard[]>(() => ompCards(omp.data), [omp.data]);
  const providerIds = usageProvidersForModel(agent?.effectiveModel, agent?.provider);
  const matched = allCards.filter((card) => providerIds.includes(card.providerId));
  const rest = allCards.filter((card) => !providerIds.includes(card.providerId));

  const styles = useMemo(
    () => ({
      screen: {
        flex: 1,
        padding: layout.compact ? 16 : 24,
        gap: layout.compact ? 12 : 16,
        backgroundColor: theme.colors.surface0,
      },
      section: { gap: layout.compact ? 8 : 10 },
      title: { color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "600" as const, textTransform: "uppercase" as const, letterSpacing: 0.5 },
      model: { color: theme.colors.foreground, fontSize: 13 },
      error: { color: theme.colors.statusDanger, fontSize: 12 },
      loading: { alignSelf: "center" as const, paddingVertical: 16 },
    }),
    [theme, layout.compact],
  );

  if (omp.isPending) {
    return (
      <View style={styles.screen}>
        <ActivityIndicator color={theme.colors.accent} style={styles.loading} />
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.screen}>
      <View style={styles.section}>
        <Text style={styles.title}>Active model</Text>
        <Text style={styles.model}>{agent?.effectiveModel ?? "No model selected"}</Text>
        {omp.data?.error ? <Text style={styles.error}>{omp.data.error}</Text> : null}
        <UsageCardList
          theme={theme}
          layoutCompact={layout.compact}
          cards={matched}
          emptyText={agent?.effectiveModel ? `No plan data for this model's provider` : "Select a model to see its plan"}
        />
      </View>
      <View style={styles.section}>
        <Text style={styles.title}>Other OMP plans</Text>
        <UsageCardList
          theme={theme}
          layoutCompact={layout.compact}
          cards={rest}
          emptyText="No other plans available"
        />
      </View>
    </ScrollView>
  );
}
