import type { PluginClientContext } from "@getpaseo/plugin/client";
import { createPillManager, setPillManager, stopPillManager } from "./client/pills";
import { OmpUsagePanel } from "./client/usage-panel";
import { OmpUsageSettings } from "./client/usage-settings";
import { ompUsageRpc } from "./shared/usage";

export default function contribute(client: PluginClientContext) {
  const pillManager = createPillManager({
    paseo: client.paseo,
    fetchUsage: (input) => client.rpc(ompUsageRpc, input),
    addComposerPill: client.addComposerPill.bind(client),
  });
  setPillManager(pillManager);
  pillManager.start();

  client.addWorkspacePanel({
    id: "omp-usage",
    title: "Plan usage",
    icon: "Gauge",
    context: "agent",
    locations: ["workspace", "explorer"],
    Component: OmpUsagePanel,
  });
  client.addSettingsScreen({
    id: "omp-usage",
    title: "Plan usage",
    icon: "Gauge",
    Component: OmpUsageSettings,
  });
  client.addCommandCenterItem({
    id: "open-omp-usage",
    title: "Open plan usage",
    icon: "Gauge",
    context: "agent",
    keywords: ["usage", "quota", "plan", "omp"],
    onSelect({ openPanel }) {
      openPanel("omp-usage");
    },
  });

  return () => {
    stopPillManager();
  };
}
