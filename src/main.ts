import * as core from "@actions/core";
import * as github from "@actions/github";
import { evaluateGate, formatGateReport } from "./gate.js";
import type { DeployGuardConfig } from "./types.js";

async function run(): Promise<void> {
  try {
    const config: DeployGuardConfig = {
      apiKey: core.getInput("api-key", { required: true }),
      apiUrl:
        process.env.DEPLOYGUARD_API_URL ??
        "https://api.komatik.xyz/deploy/evaluate",
      healthCheckUrl: core.getInput("health-check-url") || undefined,
      riskThreshold: parseInt(core.getInput("risk-threshold") || "70", 10),
      failMode:
        (core.getInput("fail-mode") as "open" | "closed") || "open",
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

    switch (evaluation.gateDecision) {
      case "allow":
        core.info(report);
        break;
      case "warn":
        core.warning(report);
        break;
      case "block":
        core.setFailed(
          `Deployment blocked: health=${evaluation.healthScore}, risk=${evaluation.riskScore} (threshold: ${config.riskThreshold})`
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
        `DeployGuard evaluation failed — proceeding with deployment (fail-open). Error: ${error}`
      );
    } else {
      core.setFailed(
        `DeployGuard evaluation failed — blocking deployment (fail-closed). Error: ${error}`
      );
    }
  }
}

run();
