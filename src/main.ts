import * as core from "@actions/core";
import * as github from "@actions/github";
import { evaluateGate, formatGateReport, postPrComment } from "./gate.js";
import { registerHealer, attemptRepair } from "./healers/index.js";
import { jestHealer } from "./healers/jest.js";
import { playwrightHealer } from "./healers/playwright.js";
import { cypressHealer } from "./healers/cypress.js";
import type { DeployGuardConfig, TestRepairResult } from "./types.js";

function initHealers(): void {
  registerHealer(jestHealer);
  registerHealer(playwrightHealer);
  registerHealer(cypressHealer);
}

async function runSelfHeal(
  config: DeployGuardConfig,
  prNumber: number,
): Promise<TestRepairResult[]> {
  const results: TestRepairResult[] = [];
  const testFailures = process.env.DEPLOYGUARD_TEST_FAILURES;
  if (!testFailures) return results;

  let failures: Array<{ file: string; error: string }>;
  try {
    failures = JSON.parse(testFailures) as Array<{ file: string; error: string }>;
  } catch {
    core.debug("Could not parse DEPLOYGUARD_TEST_FAILURES — skipping self-heal");
    return results;
  }

  for (const { file, error } of failures) {
    const repairResult = await attemptRepair(file, error);
    if (repairResult) {
      results.push(repairResult);
      if (repairResult.success && repairResult.diff && config.githubToken) {
        try {
          const octokit = github.getOctokit(config.githubToken);
          const { owner, repo } = github.context.repo;
          await octokit.rest.issues.createComment({
            owner,
            repo,
            issue_number: prNumber,
            body: [
              `### DeployGuard Self-Heal Suggestion`,
              ``,
              `Test file \`${repairResult.testFile}\` failed ` +
                `(\`${repairResult.failureType}\`). ` +
                `Strategy **${repairResult.strategy}** produced a fix:`,
              ``,
              "```diff",
              repairResult.diff,
              "```",
              ``,
              `> This is a suggestion — review before applying.`,
            ].join("\n"),
          });
        } catch (err) {
          core.debug(`Failed to post self-heal suggestion: ${err}`);
        }
      }
    }
  }

  return results;
}

async function run(): Promise<void> {
  try {
    initHealers();

    const config: DeployGuardConfig = {
      apiKey: core.getInput("api-key", { required: true }),
      apiUrl:
        process.env.DEPLOYGUARD_API_URL ?? "https://api.komatik.xyz/deploy/evaluate",
      githubToken: core.getInput("github-token") || process.env.GITHUB_TOKEN || undefined,
      healthCheckUrl: core.getInput("health-check-url") || undefined,
      riskThreshold: parseInt(core.getInput("risk-threshold") || "70", 10),
      failMode: (core.getInput("fail-mode") as "open" | "closed") || "open",
      selfHeal: core.getInput("self-heal") !== "false",
    };

    const context = github.context;
    const commitSha = context.sha;
    const prNumber = context.payload.pull_request?.number;

    core.info(`Evaluating deployment gate for ${commitSha.substring(0, 7)}`);

    const evaluation = await evaluateGate(config, commitSha, prNumber);

    core.setOutput("health-score", evaluation.healthScore.toString());
    core.setOutput("risk-score", evaluation.riskScore.toString());
    core.setOutput("gate-decision", evaluation.gateDecision);
    if (evaluation.reportUrl) {
      core.setOutput("report-url", evaluation.reportUrl);
    }

    const report = formatGateReport(evaluation);

    if (prNumber && config.githubToken) {
      await postPrComment(report, prNumber, config.githubToken);
    }

    switch (evaluation.gateDecision) {
      case "allow":
        core.info(report);
        break;
      case "warn":
        core.warning(report);
        if (config.selfHeal && prNumber) {
          const repairs = await runSelfHeal(config, prNumber);
          if (repairs.length > 0) {
            core.info(
              `Self-heal attempted ${repairs.length} repair(s): ` +
                `${repairs.filter((r) => r.success).length} succeeded`,
            );
          }
        }
        break;
      case "block":
        if (config.selfHeal && prNumber) {
          const repairs = await runSelfHeal(config, prNumber);
          const successes = repairs.filter((r) => r.success);
          if (successes.length > 0) {
            core.info(
              `Self-heal repaired ${successes.length}/${repairs.length} test failure(s) — ` +
                `review suggestions in PR comments`,
            );
          }
        }
        core.setFailed(
          `Deployment blocked: health=${evaluation.healthScore}, ` +
            `risk=${evaluation.riskScore} (threshold: ${config.riskThreshold})`,
        );
        break;
      default: {
        const _exhaustive: never = evaluation.gateDecision;
        throw new Error(`Unknown gate decision: ${_exhaustive}`);
      }
    }
  } catch (error) {
    const failMode = core.getInput("fail-mode") || "open";
    if (failMode === "open") {
      core.warning(
        `DeployGuard evaluation failed — proceeding with deployment (fail-open). Error: ${error}`,
      );
    } else {
      core.setFailed(
        `DeployGuard evaluation failed — blocking deployment (fail-closed). Error: ${error}`,
      );
    }
  }
}

run();
