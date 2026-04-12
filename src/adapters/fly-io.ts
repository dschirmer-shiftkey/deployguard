import type { HealthCheckAdapter, HealthCheckResult } from "./types.js";

const TIMEOUT_MS = 10_000;

export const flyIoAdapter: HealthCheckAdapter = {
  name: "fly-io",

  detect(): boolean {
    return !!(process.env.FLY_API_TOKEN && process.env.FLY_APP_NAME);
  },

  async check(): Promise<HealthCheckResult> {
    const token = process.env.FLY_API_TOKEN ?? "";
    const appName = process.env.FLY_APP_NAME ?? "";

    const start = Date.now();
    try {
      const response = await fetch(
        `https://api.machines.dev/v1/apps/${encodeURIComponent(appName)}/machines`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
          },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        },
      );
      const latencyMs = Date.now() - start;

      if (!response.ok) {
        return {
          target: `fly:${appName}`,
          status: "degraded",
          latencyMs,
          detail: { httpStatus: response.status, provider: "fly-io" },
        };
      }

      const machines = (await response.json()) as Array<{
        id: string;
        state: string;
        region: string;
        config?: { image?: string };
      }>;

      const running = machines.filter((m) => m.state === "started");
      const total = machines.length;

      return {
        target: `fly:${appName}`,
        status:
          running.length === total && total > 0
            ? "healthy"
            : running.length > 0
              ? "degraded"
              : "down",
        latencyMs,
        detail: {
          provider: "fly-io",
          totalMachines: total,
          runningMachines: running.length,
          regions: [...new Set(machines.map((m) => m.region))],
        },
      };
    } catch (error) {
      return {
        target: `fly:${appName}`,
        status: "down",
        latencyMs: Date.now() - start,
        detail: { error: String(error), provider: "fly-io" },
      };
    }
  },
};
