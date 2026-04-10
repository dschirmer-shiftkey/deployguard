import { createAppAuth } from "@octokit/auth-app";
import crypto from "node:crypto";

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

function verifySignature(payload: string, signature: string, secret: string): boolean {
  if (!secret || !signature) return !secret;
  const expected = `sha256=${crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("hex")}`;
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

// ---------------------------------------------------------------------------
// Lightweight risk scoring (mirrors core engine logic for standalone use)
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
): Promise<Array<{ filename: string; changes: number }>> {
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
    return (await res.json()) as Array<{ filename: string; changes: number }>;
  } catch {
    return [];
  }
}

const SENSITIVE = [
  /migrations?\//i,
  /auth/i,
  /payment/i,
  /billing/i,
  /\.github\/workflows/i,
  /secrets/i,
  /\.env/i,
];

function computeQuickRisk(
  files: Array<{ filename: string; changes: number }>,
  pr: PullRequest | null,
): { score: number; summary: string } {
  if (files.length === 0 && !pr) {
    return { score: 0, summary: "No PR data available — low risk assumed." };
  }

  let score = 0;
  const reasons: string[] = [];

  const totalChanges = files.reduce((s, f) => s + f.changes, 0);
  const churnScore = Math.min(40, Math.round(10 * Math.log2(1 + totalChanges / 50)));
  score += churnScore;
  if (churnScore > 20) reasons.push(`High code churn (${totalChanges} lines)`);

  const fileCountScore = Math.min(30, Math.round(10 * Math.log2(1 + files.length)));
  score += fileCountScore;
  if (files.length > 15) reasons.push(`${files.length} files changed`);

  const sensitiveFiles = files.filter((f) => SENSITIVE.some((p) => p.test(f.filename)));
  if (sensitiveFiles.length > 0) {
    const sensitiveScore = Math.min(30, sensitiveFiles.length * 10);
    score += sensitiveScore;
    reasons.push(`${sensitiveFiles.length} sensitive file(s) touched`);
  }

  score = Math.min(100, score);
  const summary =
    reasons.length > 0
      ? reasons.join("; ")
      : `Low risk (${files.length} files, ${totalChanges} lines)`;

  return { score, summary };
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export async function handleDeploymentProtectionRule(
  payload: DeploymentProtectionPayload,
  _signature: string,
): Promise<void> {
  const config = getConfig();
  const [owner, repo] = payload.repository.full_name.split("/");

  const auth = createAppAuth({
    appId: config.appId,
    privateKey: config.privateKey,
    installationId: payload.installation.id,
  });

  const { token } = await auth({ type: "installation" });

  const pr = await findPrForSha(token, owner, repo, payload.deployment.sha);
  const files = pr
    ? await fetchChangedFiles(token, owner, repo, pr.number)
    : [];

  const { score, summary } = computeQuickRisk(files, pr);

  const prRef = pr ? `PR #${pr.number}` : payload.deployment.sha.substring(0, 7);
  const envName = payload.environment;

  let state: "approved" | "rejected";
  let comment: string;

  if (score > config.riskThreshold) {
    state = "rejected";
    comment =
      `**DeployGuard: BLOCKED** deployment to \`${envName}\`\n\n` +
      `Risk score **${score}/100** exceeds threshold (${config.riskThreshold}) for ${prRef}.\n\n` +
      `**Reason:** ${summary}\n\n` +
      `> Review the changes and reduce risk before deploying.`;
  } else if (score > config.warnThreshold) {
    state = "approved";
    comment =
      `**DeployGuard: WARNING** — approving deployment to \`${envName}\` with elevated risk.\n\n` +
      `Risk score **${score}/100** (warn threshold: ${config.warnThreshold}) for ${prRef}.\n\n` +
      `**Note:** ${summary}`;
  } else {
    state = "approved";
    comment =
      `**DeployGuard: APPROVED** deployment to \`${envName}\`\n\n` +
      `Risk score **${score}/100** for ${prRef}. ${summary}`;
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
    `[DeployGuard] ${state.toUpperCase()} ${envName} — ${prRef} risk=${score} (threshold=${config.riskThreshold})`,
  );
}
