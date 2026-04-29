import type { HealthCheckAdapter, HealthCheckResult } from "./types.js";

const TIMEOUT_MS = 10_000;

export const supabaseAdapter: HealthCheckAdapter = {
  name: "supabase",

  detect(): boolean {
    return !!(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY);
  },

  async check(): Promise<HealthCheckResult> {
    const supabaseUrl = process.env.SUPABASE_URL ?? "";
    const anonKey = process.env.SUPABASE_ANON_KEY ?? "";

    const start = Date.now();
    try {
      const response = await fetch(`${supabaseUrl}/rest/v1/`, {
        method: "GET",
        headers: {
          apikey: anonKey,
          Authorization: `Bearer ${anonKey}`,
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const latencyMs = Date.now() - start;

      return {
        target: "supabase:rest",
        status: response.ok ? "healthy" : "degraded",
        latencyMs,
        detail: { httpStatus: response.status, provider: "supabase" },
      };
    } catch (error) {
      return {
        target: "supabase:rest",
        status: "down",
        latencyMs: Date.now() - start,
        detail: { error: String(error), provider: "supabase" },
      };
    }
  },
};
