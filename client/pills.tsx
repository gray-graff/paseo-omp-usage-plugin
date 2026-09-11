import type { ComponentType } from "react";
import type { PaseoApi } from "@getpaseo/client";
import type { PluginButtonIconProps, PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { View } from "react-native";
import {
  OMP_USAGE_REFRESH_MS,
  fallbackModelFromTimeline,
  hottestWindowFraction,
  pillWindowPercents,
  usageProvidersForModel,
  type OmpUsagePayload,
} from "../shared/usage";
import { toneFor } from "./usage-cards";
import { UsagePopover } from "./usage-popover";

interface AgentEntry {
  id: string;
  workspaceId: string | null;
  baseModel: string | null;
  fallbackModel: string | null;
  provider: string;
  /** True while the daemon reports an active turn for this agent. */
  running: boolean;
}

export interface PillAgentState extends AgentEntry {
  effectiveModel: string | null;
}

type UsageFetcher = (input: { force?: boolean }) => Promise<OmpUsagePayload>;

export interface PillManagerDeps {
  paseo: PaseoApi;
  fetchUsage: UsageFetcher;
  addComposerPill: PluginClientContext["addComposerPill"];
}

export interface PillManager {
  start(): void;
  stop(): void;
  getAgent(agentId: string): PillAgentState | null;
  subscribe(agentId: string, listener: () => void): () => void;
  /** Refetch usage reports; `force` bypasses the daemon-side 60s cache. */
  refreshUsage(force?: boolean): Promise<void>;
}

let activeManager: PillManager | null = null;

export function setPillManager(manager: PillManager): void {
  activeManager = manager;
}

export function getPillManager(): PillManager | null {
  return activeManager;
}

export function stopPillManager(): void {
  activeManager?.stop();
  activeManager = null;
}

/** Host renders custom icon components; a status dot is the one place pill color is ours. */
function statusDotIcon(fraction: number): ComponentType<PluginButtonIconProps> {
  return function PillStatusDot({ theme, size }: PluginButtonIconProps) {
    return (
      <View
        style={{
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: theme.colors[toneFor(fraction)],
        }}
      />
    );
  };
}

export function createPillManager({ paseo, fetchUsage, addComposerPill }: PillManagerDeps): PillManager {
  const agents = new Map<string, AgentEntry>();
  const pills = new Map<string, PluginButtonRegistration>();
  /** Last published pill chrome; skip redundant updates so an open popover survives refreshes. */
  const pillChrome = new Map<string, string>();
  let unsubAgents: (() => void) | null = null;
  const unsubTimelines = new Map<string, () => void>();
  const timelineRefreshes = new Map<string, Promise<void>>();
  const listeners = new Map<string, Set<() => void>>();
  let started = false;
  let stopped = false;

  // Module-private interval handle; the runtime type differs between Node and RN.
  let timer: ReturnType<typeof setInterval> | null = null;
  let reports: OmpUsagePayload["reports"] = [];

  // useSyncExternalStore requires a referentially stable snapshot; cache the
  // derived state per entry instead of recomputing on every read.
  const snapshots = new Map<string, PillAgentState>();

  function notify(agentId: string): void {
    for (const listener of listeners.get(agentId) ?? []) listener();
  }

  function setAgent(entry: AgentEntry): void {
    agents.set(entry.id, entry);
    snapshots.set(entry.id, { ...entry, effectiveModel: entry.fallbackModel ?? entry.baseModel });
    notify(entry.id);
  }

  function syncPill(agent: AgentEntry): void {
    const providerIds = usageProvidersForModel(agent.fallbackModel ?? agent.baseModel, agent.provider);
    const report = reports.find((entry) => providerIds.includes(entry.provider));
    const existing = pills.get(agent.id);
    if (!report || !agent.workspaceId) {
      existing?.remove();
      pills.delete(agent.id);
      pillChrome.delete(agent.id);
      return;
    }
    const title = `${report.displayName} plan usage`;
    const icon = statusDotIcon(hottestWindowFraction(report));
    const label = `${report.displayName} ${pillWindowPercents(report).map((fraction) => Math.round(fraction * 100)).join("/")}%`;
    const chrome = `${title}|${label}|${hottestWindowFraction(report)}`;
    if (existing) {
      if (pillChrome.get(agent.id) !== chrome) {
        pillChrome.set(agent.id, chrome);
        existing.update({ title, label, icon });
      }
      return;
    }
    pillChrome.set(agent.id, chrome);
    pills.set(
      agent.id,
      addComposerPill({
        id: "omp-usage",
        workspaceId: agent.workspaceId,
        agentId: agent.id,
        button: {
          title,
          icon,
          label,
          behavior: { kind: "popover", Content: UsagePopover },
        },
      }),
    );
  }

  function syncPills(): void {
    for (const agent of agents.values()) syncPill(agent);
  }

  /**
   * OMP fallback is sticky per agent process, and the timeline keeps old
   * fallback events forever, so a stale event survives daemon restarts. The
   * daemon exposes no "current model" field, so freshness is inferred:
   * live timeline events (arrived while this manager is connected) always
   * count; replayed history counts only while the agent is mid-turn.
   */
  function queueFallbackRefresh(agentId: string, live: boolean): void {
    const previous = timelineRefreshes.get(agentId) ?? Promise.resolve();
    const refresh = previous
      .catch(() => {})
      .then(async () => {
        if (stopped || !agents.has(agentId)) return;
        const page = await paseo.agents.ref(agentId).timeline.refetch();
        const current = agents.get(agentId);
        if (!current || stopped) return;
        const fallback = fallbackModelFromTimeline(page);
        if (fallback && (live || current.running || current.fallbackModel === fallback)) {
          setAgent({ ...current, fallbackModel: fallback });
          syncPill(agents.get(agentId) ?? current);
        }
      })
      .catch((error) => {
        console.warn("omp-usage: timeline refresh failed", error);
      });
    timelineRefreshes.set(agentId, refresh);
    void refresh.finally(() => {
      if (timelineRefreshes.get(agentId) === refresh) timelineRefreshes.delete(agentId);
    });
  }

  function watchTimeline(agentId: string): void {
    if (unsubTimelines.has(agentId)) return;
    const subscription = paseo.agents.ref(agentId).timeline.subscribe(() => {
      queueFallbackRefresh(agentId, true);
    });
    unsubTimelines.set(agentId, subscription);
    void subscription.ready
      .then(() => queueFallbackRefresh(agentId, false))
      .catch((error) => console.warn("omp-usage: timeline subscription failed", error));
  }

  let refreshingAgents = false;

  async function refreshAgents(): Promise<void> {
    if (stopped || refreshingAgents) return;
    refreshingAgents = true;
    try {
      const result = await paseo.agents.list();
      for (const { agent } of result.entries) {
        const current = agents.get(agent.id);
        setAgent({
          id: agent.id,
          workspaceId: agent.workspaceId ?? current?.workspaceId ?? null,
          baseModel: agent.model ?? current?.baseModel ?? null,
          fallbackModel: current?.fallbackModel ?? null,
          provider: agent.provider,
          running: agent.status === "running",
        });
        watchTimeline(agent.id);
      }
      const freshIds = new Set(result.entries.map(({ agent }) => agent.id));
      for (const agentId of [...agents.keys()]) {
        if (freshIds.has(agentId)) continue;
        pills.get(agentId)?.remove();
        pills.delete(agentId);
        pillChrome.delete(agentId);
        agents.delete(agentId);
        snapshots.delete(agentId);
        notify(agentId);
        unsubTimelines.get(agentId)?.();
        unsubTimelines.delete(agentId);
        timelineRefreshes.delete(agentId);
      }
      syncPills();
    } catch (error) {
      console.warn("omp-usage: agent list failed", error);
    } finally {
      refreshingAgents = false;
    }
  }

  async function refreshUsage(force = false): Promise<void> {
    if (stopped) return;
    try {
      const payload = await fetchUsage({ force });
      reports = payload.reports;
    } catch {
      // Keep the last reports; the RPC output already carries an error field
      // that surfaces in panels.
    }
    syncPills();
  }

  function start(): void {
    if (started || stopped) return;
    started = true;

    unsubAgents = paseo.agents.subscribe((update) => {
      if (update.kind === "remove") {
        pills.get(update.agentId)?.remove();
        pills.delete(update.agentId);
        pillChrome.delete(update.agentId);
        agents.delete(update.agentId);
        snapshots.delete(update.agentId);
        notify(update.agentId);
        unsubTimelines.get(update.agentId)?.();
        unsubTimelines.delete(update.agentId);
        timelineRefreshes.delete(update.agentId);
        return;
      }
      const current = agents.get(update.agent.id);
      // Live snapshots can omit `model`; never erase a known model with a gap.
      const entry: AgentEntry = {
        id: update.agent.id,
        baseModel: update.agent.model ?? current?.baseModel ?? null,
        fallbackModel: current?.fallbackModel ?? null,
        workspaceId: update.agent.workspaceId ?? current?.workspaceId ?? null,
        provider: update.agent.provider,
        running: update.agent.status === "running",
      };
      setAgent(entry);
      watchTimeline(entry.id);
      syncPill(entry);
    });
    void refreshAgents();
    void refreshUsage();
    timer = setInterval(() => {
      void refreshAgents();
      void refreshUsage();
    }, OMP_USAGE_REFRESH_MS);
  }

  function stop(): void {
    stopped = true;
    unsubAgents?.();
    unsubAgents = null;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    for (const registration of pills.values()) registration.remove();
    pills.clear();
    pillChrome.clear();
    agents.clear();
    snapshots.clear();
    for (const unsubscribe of unsubTimelines.values()) unsubscribe();
    unsubTimelines.clear();
    timelineRefreshes.clear();
    listeners.clear();
  }

  function getAgent(agentId: string): PillAgentState | null {
    return snapshots.get(agentId) ?? null;
  }

  function subscribe(agentId: string, listener: () => void): () => void {
    const agentListeners = listeners.get(agentId) ?? new Set<() => void>();
    agentListeners.add(listener);
    listeners.set(agentId, agentListeners);
    return () => {
      agentListeners.delete(listener);
      if (agentListeners.size === 0) listeners.delete(agentId);
    };
  }

  return {
    start,
    stop,
    getAgent,
    subscribe,
    refreshUsage,
  };
}
