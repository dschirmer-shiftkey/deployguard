export interface DeployOutcome {
  deploymentId: string;
  environment: string;
  status: "success" | "failure" | "cancelled";
  durationMs?: number;
  url?: string;
  timestamp: string;
  source: "vercel" | "generic";
}

export interface RollbackResult {
  triggered: boolean;
  strategy: string;
  targetRef?: string;
  detail: string;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Parse Vercel deploy event payload
// ---------------------------------------------------------------------------

interface VercelPayload {
  type?: string;
  payload?: {
    deployment?: { id?: string; url?: string };
    deploymentId?: string;
    target?: string;
    readyState?: string;
    state?: string;
    createdAt?: number;
    ready?: number;
  };
}

export function parseVercelPayload(raw: unknown): DeployOutcome | null {
  try {
    const payload = raw as VercelPayload;
    const dep = payload.payload;
    if (!dep) return null;

    const deploymentId = dep.deployment?.id ?? dep.deploymentId ?? "unknown";
    const environment = dep.target ?? "preview";

    const readyState = dep.readyState ?? dep.state;
    let status: DeployOutcome["status"];
    if (readyState === "READY") status = "success";
    else if (readyState === "ERROR") status = "failure";
    else if (readyState === "CANCELED") status = "cancelled";
    else return null;

    return {
      deploymentId: String(deploymentId),
      environment,
      status,
      durationMs: dep.createdAt && dep.ready ? dep.ready - dep.createdAt : undefined,
      url: dep.deployment?.url,
      timestamp: new Date().toISOString(),
      source: "vercel",
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Parse generic deploy event payload
// ---------------------------------------------------------------------------

export function parseGenericPayload(raw: unknown): DeployOutcome | null {
  try {
    const obj = raw as Record<string, unknown>;
    const statusRaw = String(obj.status ?? "").toLowerCase();

    let status: DeployOutcome["status"];
    if (["success", "ready", "succeeded", "active"].includes(statusRaw)) {
      status = "success";
    } else if (["failure", "error", "failed", "crashed"].includes(statusRaw)) {
      status = "failure";
    } else if (["cancelled", "canceled", "skipped"].includes(statusRaw)) {
      status = "cancelled";
    } else {
      return null;
    }

    return {
      deploymentId: String(obj.id ?? obj.deployment_id ?? "unknown"),
      environment: String(obj.environment ?? "unknown"),
      status,
      url: obj.url as string | undefined,
      timestamp: new Date().toISOString(),
      source: "generic",
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Vercel rollback — promote previous production deployment
// ---------------------------------------------------------------------------

async function rollbackVercel(): Promise<RollbackResult> {
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

    const listRes = await fetch(
      `https://api.vercel.com/v6/deployments?${params.toString()}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10_000),
      },
    );

    if (!listRes.ok) {
      return {
        triggered: false,
        strategy: "vercel",
        detail: `Vercel API returned ${listRes.status}`,
        timestamp: new Date().toISOString(),
      };
    }

    const body = (await listRes.json()) as {
      deployments?: Array<{ uid: string; url?: string }>;
    };
    const previous = body.deployments?.[1];
    if (!previous) {
      return {
        triggered: false,
        strategy: "vercel",
        detail: "No previous deployment to roll back to",
        timestamp: new Date().toISOString(),
      };
    }

    const promoteParams = teamId ? `?teamId=${teamId}` : "";
    const promoteRes = await fetch(
      `https://api.vercel.com/v10/deployments/${previous.uid}/promote${promoteParams}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout(15_000),
      },
    );

    if (promoteRes.ok || promoteRes.status === 202) {
      return {
        triggered: true,
        strategy: "vercel",
        targetRef: previous.uid.substring(0, 10),
        detail: `Promoted previous deployment ${previous.uid}`,
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
      detail: `Rollback failed: ${error}`,
      timestamp: new Date().toISOString(),
    };
  }
}

// ---------------------------------------------------------------------------
// GitHub deployment rollback
// ---------------------------------------------------------------------------

async function rollbackGitHub(
  token: string,
  owner: string,
  repo: string,
  environment: string,
): Promise<RollbackResult> {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };

  try {
    const listRes = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/deployments?environment=${encodeURIComponent(environment)}&per_page=10`,
      { headers, signal: AbortSignal.timeout(10_000) },
    );
    if (!listRes.ok) {
      return {
        triggered: false,
        strategy: "github-deployment",
        detail: `Failed to list deployments: ${listRes.status}`,
        timestamp: new Date().toISOString(),
      };
    }

    const deployments = (await listRes.json()) as Array<{
      id: number;
      sha: string;
    }>;

    for (const dep of deployments) {
      const statusRes = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/deployments/${dep.id}/statuses?per_page=1`,
        { headers, signal: AbortSignal.timeout(10_000) },
      );
      if (!statusRes.ok) continue;
      const statuses = (await statusRes.json()) as Array<{ state: string }>;
      if (statuses[0]?.state === "success") {
        const createRes = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/deployments`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              ref: dep.sha,
              environment,
              auto_merge: false,
              required_contexts: [],
              description: `DeployGuard rollback to ${dep.sha.substring(0, 7)}`,
              payload: { rollback: true, triggeredBy: "deployguard-app" },
            }),
            signal: AbortSignal.timeout(10_000),
          },
        );

        if (createRes.ok || createRes.status === 201) {
          return {
            triggered: true,
            strategy: "github-deployment",
            targetRef: dep.sha.substring(0, 7),
            detail: `Created rollback deployment targeting ${dep.sha.substring(0, 7)}`,
            timestamp: new Date().toISOString(),
          };
        }
      }
    }

    return {
      triggered: false,
      strategy: "github-deployment",
      detail: "No previous successful deployment found",
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    return {
      triggered: false,
      strategy: "github-deployment",
      detail: `Rollback failed: ${error}`,
      timestamp: new Date().toISOString(),
    };
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function executeRollback(
  outcome: DeployOutcome,
  githubToken?: string,
  repoFullName?: string,
): Promise<RollbackResult> {
  if (outcome.status !== "failure") {
    return {
      triggered: false,
      strategy: "none",
      detail: `No rollback needed — status is "${outcome.status}"`,
      timestamp: new Date().toISOString(),
    };
  }

  console.log(
    `[DeployGuard] Deployment ${outcome.deploymentId} failed in ${outcome.environment} — initiating rollback`,
  );

  if (process.env.VERCEL_TOKEN && process.env.VERCEL_PROJECT_ID) {
    return rollbackVercel();
  }

  if (githubToken && repoFullName) {
    const [owner, repo] = repoFullName.split("/");
    return rollbackGitHub(githubToken, owner, repo, outcome.environment);
  }

  return {
    triggered: false,
    strategy: "none",
    detail:
      "No rollback strategy available — set VERCEL_TOKEN/VERCEL_PROJECT_ID or provide GitHub token",
    timestamp: new Date().toISOString(),
  };
}
