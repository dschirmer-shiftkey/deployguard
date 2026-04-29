export type { HealthCheckAdapter, HealthCheckResult } from "./types.js";
export { registerAdapter, clearAdapters, getAdapter, getAvailableAdapters, listAdapterNames, runAllAvailable, } from "./registry.js";
export { vercelAdapter } from "./vercel.js";
export { supabaseAdapter } from "./supabase.js";
export { awsEcsAdapter } from "./aws-ecs.js";
export { flyIoAdapter } from "./fly-io.js";
export { cloudflareAdapter } from "./cloudflare.js";
export declare function registerAllAdapters(): void;
