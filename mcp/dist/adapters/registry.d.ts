import type { HealthCheckAdapter, HealthCheckResult } from "./types.js";
export declare function registerAdapter(adapter: HealthCheckAdapter): void;
export declare function clearAdapters(): void;
export declare function getAdapter(name: string): HealthCheckAdapter | undefined;
export declare function getAvailableAdapters(): HealthCheckAdapter[];
export declare function listAdapterNames(): string[];
export declare function runAllAvailable(): Promise<HealthCheckResult[]>;
