import { useMemo } from "react";
import { ActivityIndicator, ScrollView, Text, View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { PLUGIN_VERSION } from "../shared/version";
import { UsageCardList, ompCards, useOmpUsage } from "./usage-cards";

/** Settings → Plugins → Plan usage: OMP-backed subscriptions only. */
export function OmpUsageSettings({ theme, layout }: PluginSurfaceProps) {
  const omp = useOmpUsage();
  const ompList = useMemo(() => ompCards(omp.data), [omp.data]);
  const styles = useMemo(
    () => ({
      screen: { gap: layout.compact ? 14 : 18, backgroundColor: theme.colors.surface0 },
      section: { gap: layout.compact ? 8 : 10 },
      title: { color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "600" as const, textTransform: "uppercase" as const, letterSpacing: 0.5 },
      error: { color: theme.colors.statusDanger, fontSize: 12 },
      footnote: { color: theme.colors.foregroundMuted, fontSize: 11 },
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
      <View style={styles.section}>
        <Text style={styles.title}>Via Oh My Pi · v{PLUGIN_VERSION}</Text>
        {omp.data?.error ? <Text style={styles.error}>{omp.data.error}</Text> : null}
        <UsageCardList theme={theme} layoutCompact={layout.compact} cards={ompList} emptyText="No OMP subscriptions found" />
      </View>
      {generatedAt ? <Text style={styles.footnote}>OMP snapshot at {generatedAt}</Text> : null}
    </ScrollView>
  );
}
