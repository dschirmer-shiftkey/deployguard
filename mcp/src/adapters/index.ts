export type { HealthCheckAdapter, HealthCheckResult } from "./types.js";
export {
  registerAdapter,
  clearAdapters,
  getAdapter,
  getAvailableAdapters,
  listAdapterNames,
  runAllAvailable,
} from "./registry.js";
export { vercelAdapter } from "./vercel.js";
export { supabaseAdapter } from "./supabase.js";
export { awsEcsAdapter } from "./aws-ecs.js";
export { flyIoAdapter } from "./fly-io.js";
export { cloudflareAdapter } from "./cloudflare.js";

import { registerAdapter } from "./registry.js";
import { vercelAdapter } from "./vercel.js";
import { supabaseAdapter } from "./supabase.js";
import { awsEcsAdapter } from "./aws-ecs.js";
import { flyIoAdapter } from "./fly-io.js";
import { cloudflareAdapter } from "./cloudflare.js";

export function registerAllAdapters(): void {
  registerAdapter(vercelAdapter);
  registerAdapter(supabaseAdapter);
  registerAdapter(awsEcsAdapter);
  registerAdapter(flyIoAdapter);
  registerAdapter(cloudflareAdapter);
}
