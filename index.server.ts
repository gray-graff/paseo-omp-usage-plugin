import type { PluginServerContext } from "@getpaseo/plugin/server";
import { getOmpUsage } from "./server/omp-usage";
import { ompUsageRpc } from "./shared/usage";

export default function contribute(server: PluginServerContext) {
  server.handle(ompUsageRpc, getOmpUsage);
  return () => {};
}
