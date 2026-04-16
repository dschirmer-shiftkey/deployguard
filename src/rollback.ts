import * as core from "@actions/core";
import * as github from "@actions/github";
import type { DeployOutcome } from "./canary.js";

// ---------------------------------------------------------------------------
// Rollback strategy types
// ---------------------------------------------------------------------------

export interface RollbackResult {
  triggered: boolean;
  strategy: "github-deployment" | "vercel" | "workflow-dispatch" | "none";
  targetRef?: string;
  detail: string;
  timestamp: string;
}

interface DeploymentRecord {
  id: number;
  ref: string;
  sha: string;
  environment: string;
  created_at: string;
  creator: { login: string };
  payload?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Find the last successful deployment SHA for an environment
// ---------------------------------------------------------------------------

async function findLastGoodDeployment(
  token: string,
  environment: string,
): Promise<DeploymentRecord | null> {
  try {
    const octokit = github.getOctokit(token);
    const { owner, repo } = github.context.repo;

    const { data: deployments } = await octokit.rest.repos.listDeployments({
      owner,
      repo,
      environment,
      per_page: 10,
    });

    for (const dep of deployments) {
      const { data: statuses } = await octokit.rest.repos.listDeploymentStatuses({
        owner,
        repo,
        deployment_id: dep.id,
        per_page: 1,
      });

      const latest = statuses[0];
      if (latest && latest.state === "success") {
        return {
          id: dep.id,
          ref: dep.ref,
          sha: dep.sha,
          environment: dep.environment,
          created_at: dep.created_at,
          creator: { login: dep.creator?.login ?? "unknown" },
          payload: dep.payload as Record<string, unknown> | undefined,
        };
      }
    }

    return null;
  } catch (error) {
    core.debug(`Failed to find last good deployment: ${error}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// GitHub Deployments API rollback
// ---------------------------------------------------------------------------

async function rollbackViaGitHubDeployment(
  token: string,
  environment: string,
  targetDeployment: DeploymentRecord,
): Promise<RollbackResult> {
  try {
    const octokit = github.getOctokit(token);
    const { owner, repo } = github.context.repo;

    const { data: newDeployment } = await octokit.rest.repos.createDeployment({
      owner,
      repo,
      ref: targetDeployment.sha,
      environment,
      auto_merge: false,
      required_contexts: [],
      description: `DeployGuard rollback to ${targetDeployment.sha.substring(0, 7)}`,
      payload: {
        rollback: true,
        rollbackFromSha: github.context.sha,
        triggeredBy: "deployguard",
      } as unknown as string,
    });

    if ("id" in newDeployment) {
      await octokit.rest.repos.createDeploymentStatus({
        owner,
        repo,
        deployment_id: newDeployment.id,
        state: "queued",
        description: "DeployGuard initiated rollback",
      });

      return {
        triggered: true,
        strategy: "github-deployment",
        targetRef: targetDeployment.sha.substring(0, 7),
        detail: `Created rollback deployment #${newDeployment.id} targeting ${targetDeployment.sha.substring(0, 7)}`,
        timestamp: new Date().toISOString(),
      };
    }

    return {
      triggered: false,
      strategy: "github-deployment",
      detail: "Deployment creation returned a merge conflict or auto-merge response",
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    return {
      triggered: false,
      strategy: "github-deployment",
      detail: `GitHub deployment rollback failed: ${error}`,
      timestamp: new Date().toISOString(),
    };
  }
}

// ---------------------------------------------------------------------------
// Vercel rollback (promote previous deployment)
// ---------------------------------------------------------------------------

async function rollbackViaVercel(): Promise<RollbackResult> {
  const token = process.env.VERCEL_TOKEN;
  const projectId = process.env.VERCEL_PROJECT_ID;
  const teamId = process.env.VERCEL_TEAM_ID;

  if (!token || !projectId) {
    return {
      triggered: false,
      strategy: "vercel",
      detail: "Missing VERCEL_TOKEN or VERCEL_PROJECT_ID",
      timestamp: new Date().toISOString(),
    };
  }

  try {
    const params = new URLSearchParams({
      projectId,
      target: "production",
      limit: "5",
      state: "READY",
    });
    if (teamId) params.append("teamId", teamId);

    const listUrl = `https://api.vercel.com/v6/deployments?${params.toString()}`;
    const listRes = await fetch(listUrl, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });

    if (!listRes.ok) {
      return {
        triggered: false,
        strategy: "vercel",
        detail: `Vercel API returned ${listRes.status} when listing deployments`,
        timestamp: new Date().toISOString(),
      };
    }

    const body = (await listRes.json()) as {
      deployments?: Array<{ uid: string; url?: string; meta?: Record<string, string> }>;
    };

    const previous = body.deployments?.[1];
    if (!previous) {
      return {
        triggered: false,
        strategy: "vercel",
        detail: "No previous successful deployment found to roll back to",
        timestamp: new Date().toISOString(),
      };
    }

    const promoteParams = teamId ? `?teamId=${teamId}` : "";
    const promoteUrl = `https://api.vercel.com/v10/deployments/${previous.uid}/promote${promoteParams}`;
    const promoteRes = await fetch(promoteUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (promoteRes.ok || promoteRes.status === 202) {
      return {
        triggered: true,
        strategy: "vercel",
        targetRef: previous.uid.substring(0, 10),
        detail: `Promoted previous deployment ${previous.uid} (${previous.url ?? "unknown url"})`,
        timestamp: new Date().toISOString(),
      };
    }

    return {
      triggered: false,
      strategy: "vercel",
      detail: `Vercel promote returned ${promoteRes.status}`,
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    return {
      triggered: false,
      strategy: "vercel",
      detail: `Vercel rollback failed: ${error}`,
      timestamp: new Date().toISOString(),
    };
  }
}

// ---------------------------------------------------------------------------
// Workflow dispatch rollback (triggers a user-defined rollback workflow)
// ---------------------------------------------------------------------------

async function rollbackViaWorkflowDispatch(
  token: string,
  targetSha: string,
  environment: string,
): Promise<RollbackResult> {
  const workflowFile = process.env.DEPLOYGUARD_ROLLBACK_WORKFLOW ?? "rollback.yml";

  try {
    const octokit = github.getOctokit(token);
    const { owner, repo } = github.context.repo;

    await octokit.rest.actions.createWorkflowDispatch({
      owner,
      repo,
      workflow_id: workflowFile,
      ref: "main",
      inputs: {
        target_sha: targetSha,
        environment,
        reason: "deployguard-auto-rollback",
        triggered_by: `deployguard:${github.context.sha.substring(0, 7)}`,
      },
    });

    return {
      triggered: true,
      strategy: "workflow-dispatch",
      targetRef: targetSha.substring(0, 7),
      detail: `Dispatched ${workflowFile} for ${environment} targeting ${targetSha.substring(0, 7)}`,
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    return {
      triggered: false,
      strategy: "workflow-dispatch",
      detail: `Workflow dispatch failed: ${error}`,
      timestamp: new Date().toISOString(),
    };
  }
}

// ---------------------------------------------------------------------------
// Strategy selection
// ---------------------------------------------------------------------------

type RollbackStrategy = "auto" | "github-deployment" | "vercel" | "workflow-dispatch";

function detectStrategy(): RollbackStrategy {
  const explicit = process.env.DEPLOYGUARD_ROLLBACK_STRATEGY as
    | RollbackStrategy
    | undefined;
  if (
    explicit &&
    ["github-deployment", "vercel", "workflow-dispatch"].includes(explicit)
  ) {
    return explicit;
  }

  if (process.env.VERCEL_TOKEN && process.env.VERCEL_PROJECT_ID) {
    return "vercel";
  }

  if (process.env.DEPLOYGUARD_ROLLBACK_WORKFLOW) {
    return "workflow-dispatch";
  }

  return "github-deployment";
}

// ---------------------------------------------------------------------------
// Main rollback entry point
// ---------------------------------------------------------------------------

export async function executeRollback(
  outcome: DeployOutcome,
  token?: string,
): Promise<RollbackResult> {
  if (outcome.status !== "failure") {
    return {
      triggered: false,
      strategy: "none",
      detail: `No rollback needed — deployment status is "${outcome.status}"`,
      timestamp: new Date().toISOString(),
    };
  }

  core.warning(
    `DeployGuard: deployment ${outcome.deploymentId} failed in ${outcome.environment} — evaluating rollback`,
  );

  const strategy = detectStrategy();
  core.info(`Rollback strategy: ${strategy}`);

  switch (strategy) {
    case "vercel": {
      const result = await rollbackViaVercel();
      if (result.triggered) {
        core.info(`Vercel rollback succeeded: ${result.detail}`);
      } else {
        core.warning(`Vercel rollback failed: ${result.detail}`);
      }
      return result;
    }

    case "workflow-dispatch": {
      if (!token) {
        return {
          triggered: false,
          strategy: "workflow-dispatch",
          detail: "No GitHub token available for workflow dispatch",
          timestamp: new Date().toISOString(),
        };
      }
      const lastGood = await findLastGoodDeployment(token, outcome.environment);
      const targetSha = lastGood?.sha ?? "HEAD~1";
      const result = await rollbackViaWorkflowDispatch(
        token,
        targetSha,
        outcome.environment,
      );
      if (result.triggered) {
        core.info(`Workflow dispatch rollback succeeded: ${result.detail}`);
      } else {
        core.warning(`Workflow dispatch rollback failed: ${result.detail}`);
      }
      return result;
    }

    case "github-deployment":
    default: {
      if (!token) {
        return {
          triggered: false,
          strategy: "github-deployment",
          detail: "No GitHub token available for deployment rollback",
          timestamp: new Date().toISOString(),
        };
      }
      const lastGood = await findLastGoodDeployment(token, outcome.environment);
      if (!lastGood) {
        return {
          triggered: false,
          strategy: "github-deployment",
          detail: `No previous successful deployment found for environment "${outcome.environment}"`,
          timestamp: new Date().toISOString(),
        };
      }
      const result = await rollbackViaGitHubDeployment(
        token,
        outcome.environment,
        lastGood,
      );
      if (result.triggered) {
        core.info(`GitHub deployment rollback succeeded: ${result.detail}`);
      } else {
        core.warning(`GitHub deployment rollback failed: ${result.detail}`);
      }
      return result;
    }
  }
}

// ---------------------------------------------------------------------------
// Post rollback notification as PR/issue comment
// ---------------------------------------------------------------------------

export async function notifyRollback(
  result: RollbackResult,
  token: string,
  issueNumber?: number,
): Promise<void> {
  if (!issueNumber) return;

  try {
    const octokit = github.getOctokit(token);
    const { owner, repo } = github.context.repo;

    const icon = result.triggered ? "🔄" : "⚠️";
    const status = result.triggered
      ? "Rollback triggered"
      : "Rollback attempted (failed)";

    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: issueNumber,
      body: [
        `### ${icon} DeployGuard Auto-Rollback`,
        ``,
        `**Status:** ${status}`,
        `**Strategy:** ${result.strategy}`,
        result.targetRef ? `**Target:** \`${result.targetRef}\`` : "",
        `**Detail:** ${result.detail}`,
        `**Time:** ${result.timestamp}`,
        ``,
        result.triggered
          ? "> Rollback was automatically triggered due to deployment failure. Please verify the rollback succeeded and investigate the root cause."
          : "> Automatic rollback failed. Manual intervention may be required.",
      ]
        .filter(Boolean)
        .join("\n"),
    });
  } catch (error) {
    core.debug(`Failed to post rollback notification: ${error}`);
  }
}
