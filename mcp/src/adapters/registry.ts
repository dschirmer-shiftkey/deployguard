import type { HealthCheckAdapter, HealthCheckResult } from "./types.js";

let adapters: HealthCheckAdapter[] = [];

export function registerAdapter(adapter: HealthCheckAdapter): void {
  adapters.push(adapter);
}

export function clearAdapters(): void {
  adapters = [];
}

export function getAdapter(name: string): HealthCheckAdapter | undefined {
  return adapters.find((a) => a.name === name);
}

export function getAvailableAdapters(): HealthCheckAdapter[] {
  return adapters.filter((a) => a.detect());
}

export function listAdapterNames(): string[] {
  return adapters.map((a) => a.name);
}

export async function runAllAvailable(): Promise<HealthCheckResult[]> {
  const available = getAvailableAdapters();
  return Promise.all(available.map((a) => a.check()));
}
