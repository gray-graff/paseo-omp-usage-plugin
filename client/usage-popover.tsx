import { useCallback, useMemo, useSyncExternalStore } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import type { PluginButtonContentProps } from "@getpaseo/plugin/client";
import { usageProvidersForModel } from "../shared/usage";
import { getPillManager, type PillAgentState } from "./pills";
import { UsageCardList, ompCards, useOmpUsage, type UsageCard } from "./usage-cards";

/** Composer-pill popover: compact cards for the agent's current model plan. */
export function UsagePopover(props: PluginButtonContentProps) {
  if (props.context !== "agent") return null;
  return <PopoverBody theme={props.theme} layoutCompact={props.layout.compact} agentId={props.agentId} />;
}

interface PopoverBodyProps {
  theme: PluginButtonContentProps["theme"];
  layoutCompact: boolean;
  agentId: string;
}

function PopoverBody({ theme, layoutCompact, agentId }: PopoverBodyProps) {
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
  const providerIds = usageProvidersForModel(agent?.effectiveModel, agent?.provider);
  const cards = useMemo(
    (): UsageCard[] => ompCards(omp.data).filter((card) => providerIds.includes(card.providerId)),
    [omp.data, providerIds.join(",")],
  );

  const refresh = useCallback(() => {
    void omp.refresh(true);
  }, [omp.refresh]);

  const styles = useMemo(
    () => ({
      body: { gap: 10, minWidth: 280, maxWidth: 360 },
      empty: { color: theme.colors.foregroundMuted, fontSize: 12 },
      loading: { alignSelf: "center" as const, paddingVertical: 8 },
      toolbar: { flexDirection: "row" as const, justifyContent: "flex-end" as const },
      refreshButton: { padding: 4 },
      refreshGlyph: { color: theme.colors.foregroundMuted, fontSize: 14, lineHeight: 16 },
    }),
    [theme],
  );

  if (omp.isPending) {
    return (
      <View style={styles.body}>
        <ActivityIndicator color={theme.colors.accent} style={styles.loading} />
      </View>
    );
  }

  return (
    <View style={styles.body}>
      <View style={styles.toolbar}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Refresh usage"
          hitSlop={8}
          onPress={(event) => {
            // The press bubbles through the React tree up to the menu root, which
            // dismisses the surface; cut it off so the popover stays open.
            event.stopPropagation();
            refresh();
          }}
        >
          {omp.isRefreshing ? (
            <ActivityIndicator size="small" color={theme.colors.foregroundMuted} />
          ) : (
            <Text style={styles.refreshGlyph}>↻</Text>
          )}
        </Pressable>
      </View>
      {omp.data?.error ? <Text style={styles.empty}>{omp.data.error}</Text> : null}
      <UsageCardList
        theme={theme}
        layoutCompact={layoutCompact}
        cards={cards}
        emptyText={agent?.effectiveModel ? `No plan data for ${agent.effectiveModel}` : "No model selected"}
      />
    </View>
  );
}
