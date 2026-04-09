import type { TestRepairResult } from "../types.js";

export interface TestHealer {
  name: string;
  canHandle(testFile: string, errorOutput: string): boolean;
  repair(testFile: string, errorOutput: string): Promise<TestRepairResult>;
}

let healers: TestHealer[] = [];

export function registerHealer(healer: TestHealer): void {
  healers.push(healer);
}

export function clearHealers(): void {
  healers = [];
}

export function getHealerFor(
  testFile: string,
  errorOutput: string,
): TestHealer | undefined {
  return healers.find((h) => h.canHandle(testFile, errorOutput));
}

export async function attemptRepair(
  testFile: string,
  errorOutput: string,
): Promise<TestRepairResult | null> {
  const healer = getHealerFor(testFile, errorOutput);
  if (!healer) return null;
  return healer.repair(testFile, errorOutput);
}
