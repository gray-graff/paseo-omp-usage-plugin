import { spawn } from "node:child_process";
import type { RpcInput } from "@getpaseo/plugin";
import { z } from "zod";
import { ompUsageRpc, providerDisplayName, type OmpUsagePayload } from "../shared/usage.js";

const OMP_COMMAND = process.env.OMP_COMMAND ?? "omp";
const TIMEOUT_MS = 15_000;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const CACHE_TTL_MS = 60_000;

/**
 * One snapshot serves every caller: omp refreshes per provider internally and
 * today emits exactly one report per provider id, so we fetch all providers in
 * a single spawn and cache the parsed payload.
 */
let cache: { at: number; value: OmpUsagePayload } | null = null;

// Boundary schema for `omp usage --json`: validate once, then read typed values.
const OmpAmountSchema = z
  .object({
    used: z.number().nullish(),
    limit: z.number().nullish(),
    usedFraction: z.number().nullish(),
    unit: z.string().nullish(),
  })
  .passthrough();

const OmpLimitSchema = z
  .object({
    id: z.string().optional(),
    label: z.string().optional(),
    amount: OmpAmountSchema.nullish(),
    window: z.object({ resetsAt: z.number().nullish() }).passthrough().nullish(),
  })
  .passthrough();

const OmpReportSchema = z
  .object({
    provider: z.string(),
    metadata: z
      .object({ planType: z.unknown().nullish(), email: z.unknown().nullish() })
      .passthrough()
      .nullish(),
    limits: z.array(OmpLimitSchema).nullish(),
  })
  .passthrough();

const OmpUsageOutputSchema = z
  .object({ generatedAt: z.number().nullish(), reports: z.array(OmpReportSchema) })
  .passthrough();

function runOmpUsageJson(): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const child = spawn(OMP_COMMAND, ["usage", "--json"], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  let settled = false;

  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    child.kill("SIGKILL");
    reject(new Error(`omp usage timed out after ${TIMEOUT_MS / 1000}s`));
  }, TIMEOUT_MS);

  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
    if (Buffer.byteLength(stdout, "utf8") > MAX_OUTPUT_BYTES && !settled) {
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      reject(new Error("omp usage output exceeded 10 MB"));
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  child.on("error", (error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    reject(new Error(`failed to run ${OMP_COMMAND}: ${error.message}`));
  });
  child.on("close", (code) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (code === 0) {
      resolve(stdout);
    } else {
      const trimmed = stderr.trim();
      if (trimmed) console.error(`omp usage stderr (exit ${code}):`, trimmed);
      reject(new Error(`omp usage exited with ${code}`));
    }
  });

  return promise;
}

function mapPayload(raw: unknown): OmpUsagePayload {
  const parsed = OmpUsageOutputSchema.safeParse(raw);
  if (!parsed.success) {
    return { generatedAt: null, reports: [], error: "omp usage output did not match the expected shape" };
  }
  const output = parsed.data;

  const reports: OmpUsagePayload["reports"] = [];
  for (const report of output.reports) {
    const metadata = report.metadata ?? {};
    const planLabel = typeof metadata.planType === "string" ? metadata.planType : null;
    const email = typeof metadata.email === "string" ? metadata.email : null;

    const windows: OmpUsagePayload["reports"][number]["windows"] = [];
    for (const limit of report.limits ?? []) {
      const amount = limit.amount;
      if (!amount || typeof amount.usedFraction !== "number") continue;
      windows.push({
        id: limit.id ?? `${report.provider}:${windows.length}`,
        label: limit.label && limit.label.length > 0 ? limit.label : "Usage",
        used: amount.used ?? null,
        limit: amount.limit ?? null,
        unit: amount.unit ?? null,
        usedFraction: Math.max(0, Math.min(1, amount.usedFraction)),
        resetsAt: limit.window?.resetsAt ?? null,
      });
    }

    reports.push({ provider: report.provider, displayName: providerDisplayName(report.provider), planLabel, email, windows });
  }

  return { generatedAt: output.generatedAt ?? null, reports, error: null };
}

export async function getOmpUsage(input: RpcInput<typeof ompUsageRpc>): Promise<OmpUsagePayload> {
  const now = Date.now();
  if (!input.force && cache && now - cache.at < CACHE_TTL_MS) return cache.value;

  try {
    const stdout = await runOmpUsageJson();
    const value = mapPayload(JSON.parse(stdout));
    cache = { at: now, value };
    return value;
  } catch (error) {
    console.error("omp usage failed:", error instanceof Error ? error.message : error);
    // Serve stale data when possible; a hard error only when we never succeeded.
    if (cache) return cache.value;
    return {
      generatedAt: null,
      reports: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
