import * as core from "@actions/core";
import type { CanaryConfig } from "./types.js";
import {
  computeDeploymentHistoryFactor,
  type DeploymentOutcomeSummary,
  type RiskFactorResult,
} from "./risk-engine.js";

// ---------------------------------------------------------------------------
// Deploy outcome types
// ---------------------------------------------------------------------------

export interface DeployOutcome {
  deploymentId: string;
  environment: string;
  status: "success" | "failure" | "cancelled";
  durationMs?: number;
  url?: string;
  timestamp: string;
  source: "vercel" | "generic";
}

// ---------------------------------------------------------------------------
// Vercel webhook parser
// ---------------------------------------------------------------------------

interface VercelDeploymentPayload {
  id?: string;
  type?: string;
  payload?: {
    deployment?: {
      id?: string;
      name?: string;
      url?: string;
      meta?: Record<string, string>;
    };
    deploymentId?: string;
    name?: string;
    url?: string;
    target?: string;
    readyState?: string;
    state?: string;
    createdAt?: number;
    ready?: number;
  };
}

export function parseVercelWebhook(raw: unknown): DeployOutcome | null {
  try {
    const payload = raw as VercelDeploymentPayload;
    const dep = payload.payload;
    if (!dep) return null;

    const deploymentId =
      dep.deployment?.id ?? dep.deploymentId ?? payload.id ?? "unknown";
    const environment = dep.target ?? "preview";

    const readyState = dep.readyState ?? dep.state;
    let status: DeployOutcome["status"];
    if (readyState === "READY") {
      status = "success";
    } else if (readyState === "ERROR") {
      status = "failure";
    } else if (readyState === "CANCELED") {
      status = "cancelled";
    } else {
      return null;
    }

    const durationMs = dep.createdAt && dep.ready ? dep.ready - dep.createdAt : undefined;

    return {
      deploymentId: String(deploymentId),
      environment,
      status,
      durationMs,
      url: dep.deployment?.url ?? dep.url,
      timestamp: new Date().toISOString(),
      source: "vercel",
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Generic webhook parser (configurable field mapping)
// ---------------------------------------------------------------------------

function resolvePath(obj: unknown, path: string): unknown {
  const parts = path.replace(/^\$\./, "").split(".").filter(Boolean);
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function parseGenericWebhook(
  raw: unknown,
  config: CanaryConfig,
): DeployOutcome | null {
  try {
    const fieldMap = config.field_map;
    if (!fieldMap) return null;

    const statusRaw = String(resolvePath(raw, fieldMap.status ?? "$.status") ?? "");
    const environment = String(
      resolvePath(raw, fieldMap.environment ?? "$.environment") ?? "unknown",
    );
    const url = resolvePath(raw, fieldMap.url ?? "$.url") as string | undefined;
    const deploymentId = String(
      resolvePath(raw, fieldMap.deployment_id ?? "$.id") ?? "unknown",
    );

    let status: DeployOutcome["status"];
    const lower = statusRaw.toLowerCase();
    if (
      lower === "success" ||
      lower === "ready" ||
      lower === "succeeded" ||
      lower === "active"
    ) {
      status = "success";
    } else if (
      lower === "failure" ||
      lower === "error" ||
      lower === "failed" ||
      lower === "crashed"
    ) {
      status = "failure";
    } else if (lower === "cancelled" || lower === "canceled" || lower === "skipped") {
      status = "cancelled";
    } else {
      return null;
    }

    return {
      deploymentId,
      environment,
      status,
      url,
      timestamp: new Date().toISOString(),
      source: "generic",
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Record deploy outcome to store
// ---------------------------------------------------------------------------

export async function recordDeployOutcome(
  storeUrl: string,
  outcome: DeployOutcome,
): Promise<void> {
  try {
    const secret = process.env.EVALUATION_STORE_SECRET;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (secret) {
      headers["Authorization"] = `Bearer ${secret}`;
    }

    const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    if (bypassSecret) {
      headers["x-vercel-protection-bypass"] = bypassSecret;
    }

    const url = storeUrl.replace(/\/store\/?$/, "/deploy-event");

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(outcome),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      core.warning(
        `Deploy outcome store returned ${response.status} — outcome not recorded`,
      );
    }
  } catch (error) {
    core.warning(`Failed to record deploy outcome: ${error}`);
  }
}

// ---------------------------------------------------------------------------
// Fetch recent deploy outcomes from Supabase for risk factor
// ---------------------------------------------------------------------------

export async function fetchRecentDeployOutcomes(
  environment: string,
  limit = 5,
): Promise<DeploymentOutcomeSummary | null> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) return null;

  try {
    const url =
      `${supabaseUrl}/rest/v1/deployguard_evaluations` +
      `?select=deploy_outcome,deployed_at` +
      `&deploy_outcome=neq.null` +
      `&order=deployed_at.desc` +
      `&limit=${limit}`;

    const response = await fetch(url, {
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) return null;

    const rows = (await response.json()) as Array<{
      deploy_outcome: string;
      deployed_at: string;
    }>;

    if (rows.length === 0) return null;

    const recentFailures = rows.filter(
      (r) => r.deploy_outcome === "failure" || r.deploy_outcome === "rollback",
    ).length;

    const lastOutcome = rows[0]?.deploy_outcome;

    return {
      recentFailures,
      recentTotal: rows.length,
      lastDeployFailed: lastOutcome === "failure",
      lastRollback: lastOutcome === "rollback",
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Compute canary risk factor
// ---------------------------------------------------------------------------

export function computeCanaryRiskFactor(
  outcomes: DeploymentOutcomeSummary,
): RiskFactorResult | null {
  return computeDeploymentHistoryFactor(outcomes);
}
