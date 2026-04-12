import type { HealthCheckAdapter, HealthCheckResult } from "./types.js";

const TIMEOUT_MS = 10_000;

export const cloudflareAdapter: HealthCheckAdapter = {
  name: "cloudflare",

  detect(): boolean {
    return !!(
      process.env.CLOUDFLARE_API_TOKEN &&
      process.env.CLOUDFLARE_ACCOUNT_ID &&
      process.env.CLOUDFLARE_WORKER_NAME
    );
  },

  async check(): Promise<HealthCheckResult> {
    const token = process.env.CLOUDFLARE_API_TOKEN ?? "";
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
    const workerName = process.env.CLOUDFLARE_WORKER_NAME ?? "";

    const start = Date.now();
    try {
      const url =
        `https://api.cloudflare.com/client/v4/accounts/${accountId}` +
        `/workers/scripts/${encodeURIComponent(workerName)}`;

      const response = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const latencyMs = Date.now() - start;

      if (!response.ok) {
        return {
          target: `cloudflare:${workerName}`,
          status: response.status === 404 ? "down" : "degraded",
          latencyMs,
          detail: { httpStatus: response.status, provider: "cloudflare" },
        };
      }

      const body = (await response.json()) as {
        success: boolean;
        result?: {
          id?: string;
          modified_on?: string;
          etag?: string;
        };
        errors?: Array<{ code: number; message: string }>;
      };

      if (!body.success) {
        return {
          target: `cloudflare:${workerName}`,
          status: "degraded",
          latencyMs,
          detail: {
            provider: "cloudflare",
            errors: body.errors,
          },
        };
      }

      return {
        target: `cloudflare:${workerName}`,
        status: "healthy",
        latencyMs,
        detail: {
          provider: "cloudflare",
          modifiedOn: body.result?.modified_on,
          etag: body.result?.etag,
        },
      };
    } catch (error) {
      return {
        target: `cloudflare:${workerName}`,
        status: "down",
        latencyMs: Date.now() - start,
        detail: { error: String(error), provider: "cloudflare" },
      };
    }
  },
};
