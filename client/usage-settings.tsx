import { useCallback, useMemo } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { SettingsCard, SettingsRow, SettingsSection } from "@getpaseo/plugin/client/ui";
import { PLUGIN_VERSION } from "../shared/version";
import { UsageCardList, ompCards, useOmpUsage } from "./usage-cards";

/** Settings → Plugins → Plan usage: OMP-backed subscriptions only. */
export function OmpUsageSettings({ theme, layout }: PluginSurfaceProps) {
  const omp = useOmpUsage();
  const ompList = useMemo(() => ompCards(omp.data), [omp.data]);
  const refresh = useCallback(() => {
    void omp.refresh(true);
  }, [omp.refresh]);
  const styles = useMemo(
    () => ({
      screen: { gap: layout.compact ? 14 : 18, backgroundColor: theme.colors.surface0 },
      list: { gap: layout.compact ? 8 : 10 },
      refreshButton: { padding: 4 },
      refreshGlyph: { color: theme.colors.foregroundMuted, fontSize: 14, lineHeight: 16 },
      error: { color: theme.colors.statusDanger, fontSize: 12 },
      loading: { alignSelf: "center" as const, paddingVertical: 24 },
    }),
    [theme, layout.compact],
  );
  if (omp.isPending) {
    return <View><ActivityIndicator color={theme.colors.accent} style={styles.loading} /></View>;
  }
  const generatedAt = omp.data?.generatedAt ? new Date(omp.data.generatedAt).toLocaleTimeString() : null;
  return (
    <ScrollView contentContainerStyle={styles.screen}>
      <SettingsSection
        title="Plan usage"
        info="Quotas as reported by the local omp CLI."
        trailing={
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Refresh usage"
            hitSlop={8}
            disabled={omp.isRefreshing}
            style={styles.refreshButton}
            onPress={(event) => {
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
        }
      >
        <View style={styles.list}>
          {omp.data?.error ? <Text style={styles.error}>{omp.data.error}</Text> : null}
          <UsageCardList theme={theme} layoutCompact={layout.compact} cards={ompList} emptyText="No OMP subscriptions found" />
        </View>
        <SettingsCard>
          <SettingsRow label="OMP snapshot" hint={generatedAt ?? "not fetched yet"} />
          <SettingsRow label="Plugin version" hint={`v${PLUGIN_VERSION}`} />
        </SettingsCard>
      </SettingsSection>
    </ScrollView>
  );
}
