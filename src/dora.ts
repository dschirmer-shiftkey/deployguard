import * as core from "@actions/core";
import * as github from "@actions/github";

// ---------------------------------------------------------------------------
// DORA rating bands (per dora.dev benchmarks)
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
  failedDeployRecoveryTime: {
    medianHours: number;
    rating: DoraRating;
    incidentCount: number;
  };
  changeReworkRate: {
    percentage: number;
    reworkPrs: number;
    total: number;
    rating: DoraRating;
  };
  overallRating: DoraRating;
  environment?: string;
  service?: string;
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

function rateFDRT(medianHours: number): DoraRating {
  if (medianHours <= 1) return "elite";
  if (medianHours <= 24) return "high";
  if (medianHours <= 168) return "medium";
  return "low";
}

function rateReworkRate(percentage: number): DoraRating {
  if (percentage <= 5) return "elite";
  if (percentage <= 10) return "high";
  if (percentage <= 20) return "medium";
  return "low";
}

function overallDoraRating(
  metrics: Omit<DoraMetrics, "overallRating" | "environment" | "service">,
): DoraRating {
  const ratings = [
    metrics.deploymentFrequency.rating,
    metrics.changeFailureRate.rating,
    metrics.leadTimeToChange.rating,
    metrics.failedDeployRecoveryTime.rating,
    metrics.changeReworkRate.rating,
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
// Deployment Frequency
// ---------------------------------------------------------------------------

async function computeDeploymentFrequency(
  token: string,
  windowDays: number,
  environment?: string,
): Promise<DoraMetrics["deploymentFrequency"]> {
  try {
    const octokit = github.getOctokit(token);
    const { owner, repo } = github.context.repo;

    const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();

    if (environment) {
      const { data: deployments } = await octokit.request(
        "GET /repos/{owner}/{repo}/deployments",
        {
          owner,
          repo,
          environment,
          per_page: 100,
        },
      );

      const deploymentsInWindow = deployments.filter(
        (d: { created_at: string }) => new Date(d.created_at).toISOString() >= since,
      );

      const weeks = windowDays / 7;
      const deploysPerWeek =
        weeks > 0 ? Math.round((deploymentsInWindow.length / weeks) * 100) / 100 : 0;

      return {
        deploysPerWeek,
        rating: rateDeploymentFrequency(deploysPerWeek),
        window: windowDays,
      };
    }

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

    const deployRuns = data.workflow_runs.filter((r) => r.head_branch === defaultBranch);

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
// Change Failure Rate
// ---------------------------------------------------------------------------

const FAILURE_PATTERNS = [
  /\brevert\b/i,
  /\brollback\b/i,
  /\bhotfix\b/i,
  /\bfix.*prod/i,
  /\bemergency\b/i,
  /\bincident\b/i,
];

async function computeChangeFailureRate(
  token: string,
  windowDays: number,
  servicePaths?: string[],
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

    let mergedInWindow = merged.data.filter(
      (pr) => pr.merged_at && new Date(pr.merged_at).toISOString() >= since,
    );

    if (servicePaths && servicePaths.length > 0) {
      mergedInWindow = await filterPrsByServicePaths(
        octokit,
        owner,
        repo,
        mergedInWindow,
        servicePaths,
      );
    }

    const total = mergedInWindow.length;
    if (total === 0) {
      return {
        percentage: 0,
        failures: 0,
        total: 0,
        rating: "elite",
        window: windowDays,
      };
    }

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
    return {
      percentage: 0,
      failures: 0,
      total: 0,
      rating: "low",
      window: windowDays,
    };
  }
}

// ---------------------------------------------------------------------------
// Lead Time to Change
// ---------------------------------------------------------------------------

async function computeLeadTimeToChange(
  token: string,
  windowDays: number,
  servicePaths?: string[],
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

    let mergedInWindow = prs.filter(
      (pr) => pr.merged_at && new Date(pr.merged_at).toISOString() >= since,
    );

    if (servicePaths && servicePaths.length > 0) {
      mergedInWindow = await filterPrsByServicePaths(
        octokit,
        owner,
        repo,
        mergedInWindow,
        servicePaths,
      );
    }

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
          const firstCommitDate =
            commits[0].commit.committer?.date ?? commits[0].commit.author?.date;
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
// Failed Deployment Recovery Time (FDRT) — new in DORA-5
// ---------------------------------------------------------------------------

async function computeFailedDeployRecoveryTime(
  token: string,
  windowDays: number,
  environment?: string,
): Promise<DoraMetrics["failedDeployRecoveryTime"]> {
  try {
    const octokit = github.getOctokit(token);
    const { owner, repo } = github.context.repo;

    const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();

    const env = environment ?? "production";

    const { data: deployments } = await octokit.request(
      "GET /repos/{owner}/{repo}/deployments",
      { owner, repo, environment: env, per_page: 50 },
    );

    const deploymentsInWindow = deployments.filter(
      (d: { created_at: string }) => new Date(d.created_at).toISOString() >= since,
    );

    if (deploymentsInWindow.length === 0) {
      return { medianHours: 0, rating: "elite", incidentCount: 0 };
    }

    const recoveryTimesHours: number[] = [];

    for (let i = 0; i < deploymentsInWindow.length; i++) {
      const dep = deploymentsInWindow[i] as {
        id: number;
        created_at: string;
      };
      try {
        const { data: statuses } = await octokit.request(
          "GET /repos/{owner}/{repo}/deployments/{deployment_id}/statuses",
          { owner, repo, deployment_id: dep.id, per_page: 10 },
        );

        const hasFailure = statuses.some(
          (s: { state: string }) => s.state === "failure" || s.state === "error",
        );

        if (hasFailure) {
          const failureTime = new Date(dep.created_at).getTime();
          let recoveryTime: number | null = null;

          for (let j = i - 1; j >= 0; j--) {
            const nextDep = deploymentsInWindow[j] as {
              id: number;
              created_at: string;
            };
            const { data: nextStatuses } = await octokit.request(
              "GET /repos/{owner}/{repo}/deployments/{deployment_id}/statuses",
              { owner, repo, deployment_id: nextDep.id, per_page: 10 },
            );
            const succeeded = nextStatuses.some(
              (s: { state: string }) => s.state === "success",
            );
            if (succeeded) {
              recoveryTime = new Date(nextDep.created_at).getTime();
              break;
            }
          }

          if (recoveryTime !== null) {
            const hours = (recoveryTime - failureTime) / (1000 * 60 * 60);
            recoveryTimesHours.push(Math.max(0, hours));
          }
        }
      } catch {
        // skip deployments we can't fetch statuses for
      }
    }

    if (recoveryTimesHours.length === 0) {
      return { medianHours: 0, rating: "elite", incidentCount: 0 };
    }

    recoveryTimesHours.sort((a, b) => a - b);
    const mid = Math.floor(recoveryTimesHours.length / 2);
    const medianHours =
      recoveryTimesHours.length % 2 === 0
        ? Math.round(((recoveryTimesHours[mid - 1] + recoveryTimesHours[mid]) / 2) * 10) /
          10
        : Math.round(recoveryTimesHours[mid] * 10) / 10;

    return {
      medianHours,
      rating: rateFDRT(medianHours),
      incidentCount: recoveryTimesHours.length,
    };
  } catch (error) {
    core.debug(`DORA FDRT failed: ${error}`);
    return { medianHours: 0, rating: "low", incidentCount: 0 };
  }
}

// ---------------------------------------------------------------------------
// Change Rework Rate — new in DORA-5
// ---------------------------------------------------------------------------

async function computeChangeReworkRate(
  token: string,
  windowDays: number,
  servicePaths?: string[],
): Promise<DoraMetrics["changeReworkRate"]> {
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
      per_page: 100,
    });

    let mergedInWindow = prs.filter(
      (pr) => pr.merged_at && new Date(pr.merged_at).toISOString() >= since,
    );

    if (servicePaths && servicePaths.length > 0) {
      mergedInWindow = await filterPrsByServicePaths(
        octokit,
        owner,
        repo,
        mergedInWindow,
        servicePaths,
      );
    }

    const total = mergedInWindow.length;
    if (total < 2) {
      return { percentage: 0, reworkPrs: 0, total, rating: "elite" };
    }

    const prFiles = new Map<number, Set<string>>();
    const sampleSize = Math.min(total, 30);

    for (const pr of mergedInWindow.slice(0, sampleSize)) {
      try {
        const { data: files } = await octokit.rest.pulls.listFiles({
          owner,
          repo,
          pull_number: pr.number,
          per_page: 100,
        });
        prFiles.set(pr.number, new Set(files.map((f) => f.filename)));
      } catch {
        // skip PRs we can't fetch files for
      }
    }

    const REWORK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
    let reworkCount = 0;

    const sortedPrs = mergedInWindow
      .slice(0, sampleSize)
      .sort(
        (a, b) =>
          new Date(a.merged_at ?? 0).getTime() - new Date(b.merged_at ?? 0).getTime(),
      );

    for (let i = 1; i < sortedPrs.length; i++) {
      const currentFiles = prFiles.get(sortedPrs[i].number);
      if (!currentFiles || currentFiles.size === 0) continue;

      const currentMergedAt = new Date(sortedPrs[i].merged_at ?? 0).getTime();

      for (let j = i - 1; j >= 0; j--) {
        const prevMergedAt = new Date(sortedPrs[j].merged_at ?? 0).getTime();
        if (currentMergedAt - prevMergedAt > REWORK_WINDOW_MS) break;

        const prevFiles = prFiles.get(sortedPrs[j].number);
        if (!prevFiles) continue;

        const overlap = [...currentFiles].filter((f) => prevFiles.has(f));
        if (overlap.length > 0) {
          reworkCount++;
          break;
        }
      }
    }

    const percentage =
      sampleSize > 0 ? Math.round((reworkCount / sampleSize) * 1000) / 10 : 0;

    return {
      percentage,
      reworkPrs: reworkCount,
      total: sampleSize,
      rating: rateReworkRate(percentage),
    };
  } catch (error) {
    core.debug(`DORA rework rate failed: ${error}`);
    return { percentage: 0, reworkPrs: 0, total: 0, rating: "low" };
  }
}

// ---------------------------------------------------------------------------
// Per-service PR filter helper
// ---------------------------------------------------------------------------

type OctokitInstance = ReturnType<typeof github.getOctokit>;

interface PrMinimal {
  number: number;
}

async function filterPrsByServicePaths<T extends PrMinimal>(
  octokit: OctokitInstance,
  owner: string,
  repo: string,
  prs: T[],
  servicePaths: string[],
): Promise<T[]> {
  const pathPatterns = servicePaths.map((p) => {
    const escaped = p
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*/g, "<<GLOBSTAR>>")
      .replace(/\*/g, "[^/]*")
      .replace(/<<GLOBSTAR>>/g, ".*");
    return new RegExp(`^${escaped}$`, "i");
  });

  const filtered: T[] = [];
  const sampleSize = Math.min(prs.length, 30);

  for (const pr of prs.slice(0, sampleSize)) {
    try {
      const { data: files } = await octokit.rest.pulls.listFiles({
        owner,
        repo,
        pull_number: pr.number,
        per_page: 100,
      });

      const touchesService = files.some((f) =>
        pathPatterns.some((p) => p.test(f.filename)),
      );

      if (touchesService) {
        filtered.push(pr);
      }
    } catch {
      // skip PRs we can't fetch files for
    }
  }

  return filtered;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface DoraOptions {
  windowDays?: number;
  environment?: string;
  servicePaths?: string[];
}

export async function computeDoraMetrics(
  token: string,
  windowDaysOrOptions: number | DoraOptions = 30,
): Promise<DoraMetrics> {
  const opts: DoraOptions =
    typeof windowDaysOrOptions === "number"
      ? { windowDays: windowDaysOrOptions }
      : windowDaysOrOptions;

  const windowDays = opts.windowDays ?? 30;
  const environment = opts.environment;
  const servicePaths = opts.servicePaths;

  const [
    deploymentFrequency,
    changeFailureRate,
    leadTimeToChange,
    failedDeployRecoveryTime,
    changeReworkRate,
  ] = await Promise.all([
    computeDeploymentFrequency(token, windowDays, environment),
    computeChangeFailureRate(token, windowDays, servicePaths),
    computeLeadTimeToChange(token, windowDays, servicePaths),
    computeFailedDeployRecoveryTime(token, windowDays, environment),
    computeChangeReworkRate(token, windowDays, servicePaths),
  ]);

  const partial = {
    deploymentFrequency,
    changeFailureRate,
    leadTimeToChange,
    failedDeployRecoveryTime,
    changeReworkRate,
  };

  return {
    ...partial,
    overallRating: overallDoraRating(partial),
    environment,
    service: servicePaths ? "filtered" : undefined,
  };
}

// ---------------------------------------------------------------------------
// Human-readable labels (action outputs + dashboards)
// ---------------------------------------------------------------------------

export function formatDeploymentFrequencyForOutput(deploysPerWeek: number): string {
  if (deploysPerWeek <= 0) {
    return "none in window (no successful default-branch deploy workflows in period)";
  }
  if (deploysPerWeek >= 1) {
    const w = Math.round(deploysPerWeek * 10) / 10;
    return `${w} per week`;
  }
  const perMonth = Math.round(deploysPerWeek * 30 * 10) / 10;
  return `${perMonth} per month`;
}

function formatDeploymentFrequencyCompact(deploysPerWeek: number): string {
  if (deploysPerWeek <= 0) {
    return "none";
  }
  if (deploysPerWeek >= 1) {
    return `${Math.round(deploysPerWeek * 10) / 10}/week`;
  }
  return `${Math.round(deploysPerWeek * 30 * 10) / 10}/month`;
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

function formatHoursLabel(hours: number): string {
  if (hours >= 24) {
    return `${Math.round((hours / 24) * 10) / 10} days`;
  }
  return `${hours} hours`;
}

export function formatDoraReport(metrics: DoraMetrics): string {
  const df = metrics.deploymentFrequency;
  const cfr = metrics.changeFailureRate;
  const lt = metrics.leadTimeToChange;
  const fdrt = metrics.failedDeployRecoveryTime;
  const rework = metrics.changeReworkRate;

  const dfLabel = formatDeploymentFrequencyCompact(df.deploysPerWeek);
  const dfTableLabel = formatDeploymentFrequencyForOutput(df.deploysPerWeek);
  const ltLabel = formatHoursLabel(lt.medianHours);
  const fdrtLabel = fdrt.incidentCount === 0 ? "n/a" : formatHoursLabel(fdrt.medianHours);

  const envSuffix = metrics.environment ? ` — ${metrics.environment}` : "";

  const lines = [
    `### DORA-5 Metrics (${df.window}-day window${envSuffix})`,
    ``,
    [
      shieldBadge("deploy frequency", dfLabel, RATING_COLORS[df.rating]),
      shieldBadge("change failure rate", `${cfr.percentage}%`, RATING_COLORS[cfr.rating]),
      shieldBadge("lead time", ltLabel, RATING_COLORS[lt.rating]),
      shieldBadge("FDRT", fdrtLabel, RATING_COLORS[fdrt.rating]),
      shieldBadge(
        "DORA rating",
        metrics.overallRating.toUpperCase(),
        RATING_COLORS[metrics.overallRating],
      ),
    ].join(" "),
    ``,
    `| Metric | Value | Rating |`,
    `|--------|-------|--------|`,
    `| Deployment Frequency | ${dfTableLabel} | ${df.rating.toUpperCase()} |`,
    `| Change Failure Rate | ${cfr.percentage}% (${cfr.failures}/${cfr.total}) | ${cfr.rating.toUpperCase()} |`,
    `| Lead Time to Change | ${ltLabel} (median, ${lt.prCount} PRs) | ${lt.rating.toUpperCase()} |`,
    `| Failed Deploy Recovery | ${fdrtLabel}${fdrt.incidentCount > 0 ? ` (${fdrt.incidentCount} incident${fdrt.incidentCount === 1 ? "" : "s"})` : ""} | ${fdrt.rating.toUpperCase()} |`,
    `| Change Rework Rate | ${rework.percentage}% (${rework.reworkPrs}/${rework.total}) | ${rework.rating.toUpperCase()} |`,
    `| **Overall** | | **${metrics.overallRating.toUpperCase()}** |`,
    ``,
  ];

  return lines.join("\n");
}
