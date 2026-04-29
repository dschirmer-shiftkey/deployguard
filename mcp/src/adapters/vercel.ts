import type { HealthCheckAdapter, HealthCheckResult } from "./types.js";

const TIMEOUT_MS = 10_000;

export const vercelAdapter: HealthCheckAdapter = {
  name: "vercel",

  detect(): boolean {
    return !!(process.env.VERCEL_TOKEN && process.env.VERCEL_PROJECT_ID);
  },

  async check(): Promise<HealthCheckResult> {
    const token = process.env.VERCEL_TOKEN ?? "";
    const projectId = process.env.VERCEL_PROJECT_ID ?? "";
    const teamId = process.env.VERCEL_TEAM_ID;

    const start = Date.now();
    try {
      const params = new URLSearchParams({
        projectId,
        target: "production",
        limit: "1",
      });
      if (teamId) params.append("teamId", teamId);

      const url = `https://api.vercel.com/v6/deployments?${params.toString()}`;
      const response = await fetch(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const latencyMs = Date.now() - start;

      if (!response.ok) {
        return {
          target: "vercel:production",
          status: "degraded",
          latencyMs,
          detail: { httpStatus: response.status, provider: "vercel" },
        };
      }

      const body = (await response.json()) as {
        deployments?: Array<{
          readyState?: string;
          url?: string;
          createdAt?: number;
        }>;
      };
      const deployment = body?.deployments?.[0];

      return {
        target: "vercel:production",
        status: deployment?.readyState === "READY" ? "healthy" : "degraded",
        latencyMs,
        detail: {
          provider: "vercel",
          readyState: deployment?.readyState ?? "unknown",
          url: deployment?.url,
          createdAt: deployment?.createdAt
            ? new Date(deployment.createdAt).toISOString()
            : undefined,
        },
      };
    } catch (error) {
      return {
        target: "vercel:production",
        status: "down",
        latencyMs: Date.now() - start,
        detail: { error: String(error), provider: "vercel" },
      };
    }
  },
};
