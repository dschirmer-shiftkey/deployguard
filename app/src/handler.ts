import { createAppAuth } from "@octokit/auth-app";
import crypto from "node:crypto";
import { computeRiskScore, decideGate, type FileInfo } from "./risk-engine.js";

// ---------------------------------------------------------------------------
// Configuration from environment
// ---------------------------------------------------------------------------

function getConfig() {
  return {
    appId: process.env.GITHUB_APP_ID ?? "",
    privateKey: (process.env.GITHUB_APP_PRIVATE_KEY ?? "").replace(/\\n/g, "\n"),
    webhookSecret: process.env.GITHUB_WEBHOOK_SECRET ?? "",
    riskThreshold: parseInt(process.env.RISK_THRESHOLD ?? "70", 10),
    warnThreshold: parseInt(process.env.WARN_THRESHOLD ?? "55", 10),
  };
}

// ---------------------------------------------------------------------------
// Webhook signature verification
// ---------------------------------------------------------------------------

export function verifySignature(
  payload: string,
  signature: string,
  secret: string,
): boolean {
  if (!secret || !signature) return !secret;
  const expected = `sha256=${crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("hex")}`;
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DeploymentProtectionPayload {
  action: string;
  environment: string;
  deployment: {
    id: number;
    ref: string;
    sha: string;
    creator: { login: string };
  };
  deployment_callback_url: string;
  installation: { id: number };
  repository: {
    full_name: string;
    default_branch: string;
  };
}

interface PullRequest {
  number: number;
  title: string;
  changed_files: number;
  additions: number;
  deletions: number;
  user: { login: string };
}

// ---------------------------------------------------------------------------
// GitHub API helpers
// ---------------------------------------------------------------------------

async function findPrForSha(
  token: string,
  owner: string,
  repo: string,
  sha: string,
): Promise<PullRequest | null> {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/commits/${sha}/pulls`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );
    if (!res.ok) return null;
    const prs = (await res.json()) as PullRequest[];
    return prs[0] ?? null;
  } catch {
    return null;
  }
}

async function fetchChangedFiles(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<FileInfo[]> {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=300`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );
    if (!res.ok) return [];
    return (await res.json()) as FileInfo[];
  } catch {
    return [];
  }
}

async function fetchRepoConfig(
  token: string,
  owner: string,
  repo: string,
): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/.deployguard.yml`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      content?: string;
      type?: string;
    };
    if (data.type !== "file" || !data.content) return null;
    const content = Buffer.from(data.content, "base64").toString("utf-8");
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export async function handleDeploymentProtectionRule(
  payload: DeploymentProtectionPayload,
  rawBody: string,
  signature: string,
): Promise<void> {
  const config = getConfig();

  if (config.webhookSecret) {
    if (!verifySignature(rawBody, signature, config.webhookSecret)) {
      throw new Error("Invalid webhook signature");
    }
  }

  const [owner, repo] = payload.repository.full_name.split("/");

  const auth = createAppAuth({
    appId: config.appId,
    privateKey: config.privateKey,
    installationId: payload.installation.id,
  });

  const { token } = await auth({ type: "installation" });

  const [pr, repoConfigRaw] = await Promise.all([
    findPrForSha(token, owner, repo, payload.deployment.sha),
    fetchRepoConfig(token, owner, repo),
  ]);

  const files = pr ? await fetchChangedFiles(token, owner, repo, pr.number) : [];

  const envConfig = repoConfigRaw?.environments as
    | Record<string, { risk?: number; warn?: number }>
    | undefined;
  const envOverrides = envConfig?.[payload.environment];
  const effectiveRiskThreshold = envOverrides?.risk ?? config.riskThreshold;
  const effectiveWarnThreshold = envOverrides?.warn ?? config.warnThreshold;

  const { score, factors } = computeRiskScore(files);
  const decision = decideGate(score, 100, effectiveRiskThreshold, effectiveWarnThreshold);

  const factorSummary =
    factors.length > 0
      ? factors
          .sort((a, b) => b.score - a.score)
          .slice(0, 3)
          .map((f) => `${f.type.replace(/_/g, " ")}: ${f.score}/100`)
          .join(", ")
      : "No risk factors";

  const prRef = pr ? `PR #${pr.number}` : payload.deployment.sha.substring(0, 7);
  const envName = payload.environment;

  let state: "approved" | "rejected";
  let comment: string;

  if (decision === "block") {
    state = "rejected";
    comment =
      `**DeployGuard: BLOCKED** deployment to \`${envName}\`\n\n` +
      `Risk score **${score}/100** exceeds threshold (${effectiveRiskThreshold}) for ${prRef}.\n\n` +
      `**Top factors:** ${factorSummary}\n\n` +
      `> Review the changes and reduce risk before deploying.`;
  } else if (decision === "warn") {
    state = "approved";
    comment =
      `**DeployGuard: WARNING** — approving deployment to \`${envName}\` with elevated risk.\n\n` +
      `Risk score **${score}/100** (warn threshold: ${effectiveWarnThreshold}) for ${prRef}.\n\n` +
      `**Top factors:** ${factorSummary}`;
  } else {
    state = "approved";
    comment =
      `**DeployGuard: APPROVED** deployment to \`${envName}\`\n\n` +
      `Risk score **${score}/100** for ${prRef}. ${factorSummary}`;
  }

  const callbackUrl = payload.deployment_callback_url;

  await fetch(callbackUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      environment_name: envName,
      state,
      comment,
    }),
  });

  console.log(
    `[DeployGuard] ${state.toUpperCase()} ${envName} — ${prRef} risk=${score} (threshold=${effectiveRiskThreshold})`,
  );
}
