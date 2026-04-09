#!/usr/bin/env npx tsx
/**
 * Local simulation of the DeployGuard gate evaluation.
 *
 * Usage:
 *   npx tsx scripts/simulate.ts
 *   npx tsx scripts/simulate.ts --repo dschirmer-shiftkey/Komatik --pr 625
 *   npx tsx scripts/simulate.ts --health-url https://api.example.com/health
 *   npx tsx scripts/simulate.ts --threshold 50
 *
 * Environment variables (optional):
 *   GITHUB_TOKEN       — enables PR file fetching
 *   PR_NUMBER          — pull request number to evaluate
 */

function parseArgs() {
  const args = process.argv.slice(2);
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.replace(/^--/, "");
    const val = args[i + 1];
    if (key && val) flags[key] = val;
  }
  return flags;
}

async function main() {
  const flags = parseArgs();

  const targetRepo =
    flags["repo"] ??
    process.env.DEPLOYGUARD_TARGET_REPO ??
    process.env.GITHUB_REPOSITORY ??
    "dschirmer-shiftkey/deployguard";

  const [owner, repo] = targetRepo.split("/");

  process.env.GITHUB_REPOSITORY = `${owner}/${repo}`;

  if (!process.env.GITHUB_ACTION) {
    process.env.GITHUB_ACTION = "local-simulate";
  }
  if (!process.env.GITHUB_EVENT_NAME) {
    process.env.GITHUB_EVENT_NAME = "push";
  }

  const { evaluateGate, formatGateReport } = await import("../src/gate.js");

  type DeployGuardConfig = import("../src/types.js").DeployGuardConfig;

  const config: DeployGuardConfig = {
    apiKey: "local-simulation",
    apiUrl: "https://api.komatik.xyz/deploy/evaluate",
    githubToken: process.env.GITHUB_TOKEN,
    healthCheckUrl: flags["health-url"] || undefined,
    riskThreshold: parseInt(flags["threshold"] ?? "70", 10),
    failMode: "open",
    selfHeal: false,
    addRiskLabels: false,
    reviewersOnRisk: [],
    webhookEvents: [],
  };

  const commitSha = flags["sha"] ?? "0000000000000000000000000000000000000000";
  const prNumber = flags["pr"]
    ? parseInt(flags["pr"], 10)
    : process.env.PR_NUMBER
      ? parseInt(process.env.PR_NUMBER, 10)
      : undefined;

  console.log("--- DeployGuard Local Simulation ---");
  console.log(`  repo:      ${owner}/${repo}`);
  console.log(`  commit:    ${commitSha.substring(0, 7)}`);
  console.log(`  PR:        ${prNumber ?? "(none)"}`);
  console.log(`  threshold: ${config.riskThreshold}`);
  console.log(`  health:    ${config.healthCheckUrl ?? "(none)"}`);
  console.log(`  token:     ${config.githubToken ? "***" : "(none)"}`);
  console.log();

  const evaluation = await evaluateGate(config, commitSha, prNumber);
  const report = formatGateReport(evaluation);

  console.log(report);
  console.log();
  console.log(`Raw evaluation (${evaluation.evaluationMs}ms):`);
  console.log(JSON.stringify(evaluation, null, 2));

  process.exit(evaluation.gateDecision === "block" ? 1 : 0);
}

main().catch((err) => {
  console.error("Simulation failed:", err);
  process.exit(2);
});
