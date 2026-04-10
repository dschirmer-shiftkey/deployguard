import * as core from "@actions/core";
import * as github from "@actions/github";

// ---------------------------------------------------------------------------
// DORA rating bands (per dora.dev 2024 benchmarks)
// ---------------------------------------------------------------------------

export type DoraRating = "elite" | "high" | "medium" | "low";

export interface DoraMetrics {
  deploymentFrequency: {
    deploysPerWeek: number;
    rating: DoraRating;
    window: number;
  };
  changeFailureRate: {
    percentage: number;
    failures: number;
    total: number;
    rating: DoraRating;
    window: number;
  };
  leadTimeToChange: {
    medianHours: number;
    rating: DoraRating;
    prCount: number;
  };
  overallRating: DoraRating;
}

function rateDeploymentFrequency(deploysPerWeek: number): DoraRating {
  if (deploysPerWeek >= 7) return "elite";
  if (deploysPerWeek >= 1) return "high";
  if (deploysPerWeek >= 1 / 4) return "medium";
  return "low";
}

function rateChangeFailureRate(percentage: number): DoraRating {
  if (percentage <= 5) return "elite";
  if (percentage <= 10) return "high";
  if (percentage <= 15) return "medium";
  return "low";
}

function rateLeadTime(medianHours: number): DoraRating {
  if (medianHours <= 24) return "elite";
  if (medianHours <= 168) return "high";
  if (medianHours <= 720) return "medium";
  return "low";
}

function overallDoraRating(metrics: Omit<DoraMetrics, "overallRating">): DoraRating {
  const ratings = [
    metrics.deploymentFrequency.rating,
    metrics.changeFailureRate.rating,
    metrics.leadTimeToChange.rating,
  ];
  const order: DoraRating[] = ["elite", "high", "medium", "low"];
  const worst = ratings.reduce(
    (acc, r) => (order.indexOf(r) > order.indexOf(acc) ? r : acc),
    "elite" as DoraRating,
  );
  const best = ratings.reduce(
    (acc, r) => (order.indexOf(r) < order.indexOf(acc) ? r : acc),
    "low" as DoraRating,
  );
  if (worst === best) return worst;
  const midIndex = Math.round(
    ratings.reduce((sum, r) => sum + order.indexOf(r), 0) / ratings.length,
  );
  return order[Math.min(midIndex, order.length - 1)];
}

// ---------------------------------------------------------------------------
// Deployment Frequency — count workflow runs on default branch
// ---------------------------------------------------------------------------

async function computeDeploymentFrequency(
  token: string,
  windowDays: number,
): Promise<DoraMetrics["deploymentFrequency"]> {
  try {
    const octokit = github.getOctokit(token);
    const { owner, repo } = github.context.repo;

    const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();

    const { data } = await octokit.rest.actions.listWorkflowRunsForRepo({
      owner,
      repo,
      status: "success",
      created: `>=${since}`,
      per_page: 100,
      event: "push",
    });

    const { data: repoInfo } = await octokit.rest.repos.get({ owner, repo });
    const defaultBranch = repoInfo.default_branch;

    const deployRuns = data.workflow_runs.filter(
      (r) => r.head_branch === defaultBranch,
    );

    const deployCount = deployRuns.length;
    const weeks = windowDays / 7;
    const deploysPerWeek = weeks > 0 ? Math.round((deployCount / weeks) * 100) / 100 : 0;

    return {
      deploysPerWeek,
      rating: rateDeploymentFrequency(deploysPerWeek),
      window: windowDays,
    };
  } catch (error) {
    core.debug(`DORA deployment frequency failed: ${error}`);
    return { deploysPerWeek: 0, rating: "low", window: windowDays };
  }
}

// ---------------------------------------------------------------------------
// Change Failure Rate — ratio of reverts/hotfixes to total merges
// ---------------------------------------------------------------------------

async function computeChangeFailureRate(
  token: string,
  windowDays: number,
): Promise<DoraMetrics["changeFailureRate"]> {
  try {
    const octokit = github.getOctokit(token);
    const { owner, repo } = github.context.repo;

    const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();

    const merged = await octokit.rest.pulls.list({
      owner,
      repo,
      state: "closed",
      sort: "updated",
      direction: "desc",
      per_page: 100,
    });

    const mergedInWindow = merged.data.filter(
      (pr) =>
        pr.merged_at &&
        new Date(pr.merged_at).toISOString() >= since,
    );

    const total = mergedInWindow.length;
    if (total === 0) {
      return { percentage: 0, failures: 0, total: 0, rating: "elite", window: windowDays };
    }

    const FAILURE_PATTERNS = [
      /\brevert\b/i,
      /\brollback\b/i,
      /\bhotfix\b/i,
      /\bfix.*prod/i,
      /\bemergency\b/i,
      /\bincident\b/i,
    ];

    const failures = mergedInWindow.filter((pr) => {
      const text = `${pr.title} ${pr.body ?? ""}`;
      return FAILURE_PATTERNS.some((p) => p.test(text));
    }).length;

    const percentage = Math.round((failures / total) * 1000) / 10;

    return {
      percentage,
      failures,
      total,
      rating: rateChangeFailureRate(percentage),
      window: windowDays,
    };
  } catch (error) {
    core.debug(`DORA change failure rate failed: ${error}`);
    return { percentage: 0, failures: 0, total: 0, rating: "low", window: windowDays };
  }
}

// ---------------------------------------------------------------------------
// Lead Time to Change — time from first commit to merge
// ---------------------------------------------------------------------------

async function computeLeadTimeToChange(
  token: string,
  windowDays: number,
): Promise<DoraMetrics["leadTimeToChange"]> {
  try {
    const octokit = github.getOctokit(token);
    const { owner, repo } = github.context.repo;

    const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();

    const { data: prs } = await octokit.rest.pulls.list({
      owner,
      repo,
      state: "closed",
      sort: "updated",
      direction: "desc",
      per_page: 50,
    });

    const mergedInWindow = prs.filter(
      (pr) =>
        pr.merged_at &&
        new Date(pr.merged_at).toISOString() >= since,
    );

    if (mergedInWindow.length === 0) {
      return { medianHours: 0, rating: "elite", prCount: 0 };
    }

    const leadTimesHours: number[] = [];
    const sampleSize = Math.min(mergedInWindow.length, 20);

    for (const pr of mergedInWindow.slice(0, sampleSize)) {
      try {
        const { data: commits } = await octokit.rest.pulls.listCommits({
          owner,
          repo,
          pull_number: pr.number,
          per_page: 1,
        });

        if (commits.length > 0 && pr.merged_at) {
          const firstCommitDate = commits[0].commit.committer?.date ??
            commits[0].commit.author?.date;
          if (firstCommitDate) {
            const leadMs =
              new Date(pr.merged_at).getTime() - new Date(firstCommitDate).getTime();
            leadTimesHours.push(Math.max(0, leadMs / (1000 * 60 * 60)));
          }
        }
      } catch {
        // skip PRs we can't fetch commits for
      }
    }

    if (leadTimesHours.length === 0) {
      return { medianHours: 0, rating: "elite", prCount: 0 };
    }

    leadTimesHours.sort((a, b) => a - b);
    const mid = Math.floor(leadTimesHours.length / 2);
    const medianHours =
      leadTimesHours.length % 2 === 0
        ? Math.round(((leadTimesHours[mid - 1] + leadTimesHours[mid]) / 2) * 10) / 10
        : Math.round(leadTimesHours[mid] * 10) / 10;

    return {
      medianHours,
      rating: rateLeadTime(medianHours),
      prCount: leadTimesHours.length,
    };
  } catch (error) {
    core.debug(`DORA lead time failed: ${error}`);
    return { medianHours: 0, rating: "low", prCount: 0 };
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function computeDoraMetrics(
  token: string,
  windowDays = 30,
): Promise<DoraMetrics> {
  const [deploymentFrequency, changeFailureRate, leadTimeToChange] =
    await Promise.all([
      computeDeploymentFrequency(token, windowDays),
      computeChangeFailureRate(token, windowDays),
      computeLeadTimeToChange(token, windowDays),
    ]);

  const partial = { deploymentFrequency, changeFailureRate, leadTimeToChange };

  return {
    ...partial,
    overallRating: overallDoraRating(partial),
  };
}

// ---------------------------------------------------------------------------
// Badge + Job Summary formatting
// ---------------------------------------------------------------------------

const RATING_COLORS: Record<DoraRating, string> = {
  elite: "brightgreen",
  high: "green",
  medium: "yellow",
  low: "red",
};

function shieldBadge(label: string, value: string, color: string): string {
  const l = encodeURIComponent(label);
  const v = encodeURIComponent(value);
  return `![${label}](https://img.shields.io/badge/${l}-${v}-${color})`;
}

export function formatDoraReport(metrics: DoraMetrics): string {
  const df = metrics.deploymentFrequency;
  const cfr = metrics.changeFailureRate;
  const lt = metrics.leadTimeToChange;

  const dfLabel = df.deploysPerWeek >= 1
    ? `${df.deploysPerWeek}/week`
    : `${Math.round(df.deploysPerWeek * 30 * 10) / 10}/month`;

  const ltLabel = lt.medianHours >= 24
    ? `${Math.round((lt.medianHours / 24) * 10) / 10} days`
    : `${lt.medianHours} hours`;

  const lines = [
    `### DORA Metrics (${df.window}-day window)`,
    ``,
    [
      shieldBadge("deploy frequency", dfLabel, RATING_COLORS[df.rating]),
      shieldBadge("change failure rate", `${cfr.percentage}%`, RATING_COLORS[cfr.rating]),
      shieldBadge("lead time", ltLabel, RATING_COLORS[lt.rating]),
      shieldBadge("DORA rating", metrics.overallRating.toUpperCase(), RATING_COLORS[metrics.overallRating]),
    ].join(" "),
    ``,
    `| Metric | Value | Rating |`,
    `|--------|-------|--------|`,
    `| Deployment Frequency | ${dfLabel} | ${df.rating.toUpperCase()} |`,
    `| Change Failure Rate | ${cfr.percentage}% (${cfr.failures}/${cfr.total}) | ${cfr.rating.toUpperCase()} |`,
    `| Lead Time to Change | ${ltLabel} (median, ${lt.prCount} PRs) | ${lt.rating.toUpperCase()} |`,
    `| **Overall** | | **${metrics.overallRating.toUpperCase()}** |`,
    ``,
  ];

  return lines.join("\n");
}
