export interface HealthCheckResult {
  target: string;
  status: "healthy" | "degraded" | "down";
  latencyMs: number;
  detail: Record<string, unknown>;
}

export interface HealthCheckAdapter {
  name: string;
  detect(): boolean;
  check(): Promise<HealthCheckResult>;
}
