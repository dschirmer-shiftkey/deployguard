import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@actions/core", () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
}));

vi.mock("@actions/github", () => ({
  context: {
    repo: { owner: "test-org", repo: "test-repo" },
    sha: "abc1234",
  },
  getOctokit: vi.fn(),
}));

import * as github from "@actions/github";
import {
  computeDoraMetrics,
  formatDoraReport,
  formatDeploymentFrequencyForOutput,
} from "../dora.js";
import type { DoraMetrics } from "../dora.js";

function makeOctokit(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  const daysAgo = (d: number) => new Date(now - d * 24 * 60 * 60 * 1000).toISOString();

  const defaultWorkflowRuns = Array.from({ length: 15 }, (_, i) => ({
    id: i,
    head_branch: "main",
    status: "completed",
    conclusion: "success",
    created_at: daysAgo(i * 2),
  }));

  const defaultPRs = [
    {
      number: 1,
      title: "feat: add login",
      body: "",
      merged_at: daysAgo(2),
      user: { login: "dev1" },
    },
    {
      number: 2,
      title: "fix: patch auth",
      body: "",
      merged_at: daysAgo(5),
      user: { login: "dev2" },
    },
    {
      number: 3,
      title: 'Revert "feat: broken"',
      body: "",
      merged_at: daysAgo(7),
      user: { login: "dev1" },
    },
    {
      number: 4,
      title: "feat: dashboard",
      body: "",
      merged_at: daysAgo(10),
      user: { login: "dev3" },
    },
    {
      number: 5,
      title: "hotfix: prod crash",
      body: "",
      merged_at: daysAgo(12),
      user: { login: "dev1" },
    },
    {
      number: 6,
      title: "chore: update deps",
      body: null,
      merged_at: daysAgo(15),
      user: { login: "dev2" },
    },
    {
      number: 7,
      title: "feat: analytics",
      body: "",
      merged_at: daysAgo(20),
      user: { login: "dev3" },
    },
    {
      number: 8,
      title: "feat: settings",
      body: "",
      merged_at: daysAgo(22),
      user: { login: "dev1" },
    },
    {
      number: 9,
      title: "fix: typo",
      body: "",
      merged_at: daysAgo(25),
      user: { login: "dev2" },
    },
    {
      number: 10,
      title: "feat: onboarding",
      body: "",
      merged_at: daysAgo(28),
      user: { login: "dev3" },
    },
  ];

  const defaultCommits = [
    {
      sha: "abc",
      commit: { author: { date: daysAgo(5) }, committer: { date: daysAgo(5) } },
    },
  ];

  return {
    rest: {
      actions: {
        listWorkflowRunsForRepo: vi.fn().mockResolvedValue({
          data: { workflow_runs: overrides.workflowRuns ?? defaultWorkflowRuns },
        }),
      },
      repos: {
        get: vi.fn().mockResolvedValue({
          data: { default_branch: "main" },
        }),
      },
      pulls: {
        list: vi.fn().mockResolvedValue({
          data: overrides.pullRequests ?? defaultPRs,
        }),
        listCommits: vi.fn().mockResolvedValue({
          data: overrides.commits ?? defaultCommits,
        }),
        listFiles: vi.fn().mockResolvedValue({
          data: overrides.prFiles ?? [{ filename: "src/index.ts", changes: 10 }],
        }),
      },
    },
    request: vi.fn().mockResolvedValue({
      data: overrides.deployments ?? [],
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("computeDoraMetrics", () => {
  it("returns all five metrics with correct structure", async () => {
    const octokit = makeOctokit();
    vi.mocked(github.getOctokit).mockReturnValue(
      octokit as unknown as ReturnType<typeof github.getOctokit>,
    );

    const metrics = await computeDoraMetrics("ghp_test", 30);

    expect(metrics).toHaveProperty("deploymentFrequency");
    expect(metrics).toHaveProperty("changeFailureRate");
    expect(metrics).toHaveProperty("leadTimeToChange");
    expect(metrics).toHaveProperty("failedDeployRecoveryTime");
    expect(metrics).toHaveProperty("changeReworkRate");
    expect(metrics).toHaveProperty("overallRating");

    expect(metrics.deploymentFrequency).toHaveProperty("deploysPerWeek");
    expect(metrics.deploymentFrequency).toHaveProperty("rating");
    expect(metrics.deploymentFrequency).toHaveProperty("window");

    expect(metrics.changeFailureRate).toHaveProperty("percentage");
    expect(metrics.changeFailureRate).toHaveProperty("failures");
    expect(metrics.changeFailureRate).toHaveProperty("total");
    expect(metrics.changeFailureRate).toHaveProperty("rating");

    expect(metrics.leadTimeToChange).toHaveProperty("medianHours");
    expect(metrics.leadTimeToChange).toHaveProperty("rating");
    expect(metrics.leadTimeToChange).toHaveProperty("prCount");

    expect(metrics.failedDeployRecoveryTime).toHaveProperty("medianHours");
    expect(metrics.failedDeployRecoveryTime).toHaveProperty("rating");
    expect(metrics.failedDeployRecoveryTime).toHaveProperty("incidentCount");

    expect(metrics.changeReworkRate).toHaveProperty("percentage");
    expect(metrics.changeReworkRate).toHaveProperty("reworkPrs");
    expect(metrics.changeReworkRate).toHaveProperty("total");
    expect(metrics.changeReworkRate).toHaveProperty("rating");
  });

  it("computes deployment frequency from workflow runs", async () => {
    const octokit = makeOctokit();
    vi.mocked(github.getOctokit).mockReturnValue(
      octokit as unknown as ReturnType<typeof github.getOctokit>,
    );

    const metrics = await computeDoraMetrics("ghp_test", 30);

    expect(metrics.deploymentFrequency.deploysPerWeek).toBeGreaterThan(0);
    expect(metrics.deploymentFrequency.window).toBe(30);
    expect(["elite", "high", "medium", "low"]).toContain(
      metrics.deploymentFrequency.rating,
    );
  });

  it("detects reverts and hotfixes as change failures", async () => {
    const octokit = makeOctokit();
    vi.mocked(github.getOctokit).mockReturnValue(
      octokit as unknown as ReturnType<typeof github.getOctokit>,
    );

    const metrics = await computeDoraMetrics("ghp_test", 30);

    expect(metrics.changeFailureRate.failures).toBe(2);
    expect(metrics.changeFailureRate.total).toBe(10);
    expect(metrics.changeFailureRate.percentage).toBe(20);
  });

  it("handles empty data gracefully", async () => {
    const octokit = makeOctokit({
      workflowRuns: [],
      pullRequests: [],
      commits: [],
    });
    vi.mocked(github.getOctokit).mockReturnValue(
      octokit as unknown as ReturnType<typeof github.getOctokit>,
    );

    const metrics = await computeDoraMetrics("ghp_test", 30);

    expect(metrics.deploymentFrequency.deploysPerWeek).toBe(0);
    expect(metrics.changeFailureRate.percentage).toBe(0);
    expect(metrics.changeFailureRate.total).toBe(0);
    expect(metrics.leadTimeToChange.prCount).toBe(0);
    expect(metrics.failedDeployRecoveryTime.incidentCount).toBe(0);
    expect(metrics.changeReworkRate.total).toBe(0);
  });

  it("assigns correct overall rating", async () => {
    const octokit = makeOctokit();
    vi.mocked(github.getOctokit).mockReturnValue(
      octokit as unknown as ReturnType<typeof github.getOctokit>,
    );

    const metrics = await computeDoraMetrics("ghp_test", 30);

    expect(["elite", "high", "medium", "low"]).toContain(metrics.overallRating);
  });

  it("accepts options object instead of windowDays number", async () => {
    const octokit = makeOctokit();
    vi.mocked(github.getOctokit).mockReturnValue(
      octokit as unknown as ReturnType<typeof github.getOctokit>,
    );

    const metrics = await computeDoraMetrics("ghp_test", {
      windowDays: 14,
      environment: "staging",
    });

    expect(metrics.environment).toBe("staging");
  });
});

describe("formatDeploymentFrequencyForOutput", () => {
  it("explains an empty deploy window", () => {
    expect(formatDeploymentFrequencyForOutput(0)).toContain("none in window");
  });

  it("uses per-week wording when frequency is at least one per week", () => {
    expect(formatDeploymentFrequencyForOutput(1.2)).toContain("per week");
  });
});

describe("formatDoraReport", () => {
  const metrics: DoraMetrics = {
    deploymentFrequency: { deploysPerWeek: 3.5, rating: "high", window: 30 },
    changeFailureRate: {
      percentage: 8,
      failures: 2,
      total: 25,
      rating: "high",
      window: 30,
    },
    leadTimeToChange: { medianHours: 4.2, rating: "elite", prCount: 15 },
    failedDeployRecoveryTime: {
      medianHours: 2.5,
      rating: "high",
      incidentCount: 3,
    },
    changeReworkRate: {
      percentage: 8,
      reworkPrs: 2,
      total: 25,
      rating: "high",
    },
    overallRating: "high",
  };

  it("includes all DORA-5 metrics in the report", () => {
    const report = formatDoraReport(metrics);

    expect(report).toContain("DORA-5 Metrics");
    expect(report).toContain("Deployment Frequency");
    expect(report).toContain("Change Failure Rate");
    expect(report).toContain("Lead Time to Change");
    expect(report).toContain("Failed Deploy Recovery");
    expect(report).toContain("Change Rework Rate");
    expect(report).toContain("3.5%2Fweek");
    expect(report).toContain("3.5 per week");
    expect(report).toContain("8%");
    expect(report).toContain("4.2 hours");
    expect(report).toContain("HIGH");
  });

  it("renders shield.io badges", () => {
    const report = formatDoraReport(metrics);

    expect(report).toContain("img.shields.io/badge");
    expect(report).toContain("deploy%20frequency");
    expect(report).toContain("DORA%20rating");
    expect(report).toContain("FDRT");
  });

  it("formats low-frequency deploys as per-month", () => {
    const lowFreq: DoraMetrics = {
      ...metrics,
      deploymentFrequency: {
        deploysPerWeek: 0.5,
        rating: "medium",
        window: 30,
      },
    };
    const report = formatDoraReport(lowFreq);
    expect(report).toContain("per month");
    expect(report).toContain("%2Fmonth");
  });

  it("explains zero deploy frequency instead of 0 per month", () => {
    const none: DoraMetrics = {
      ...metrics,
      deploymentFrequency: {
        deploysPerWeek: 0,
        rating: "low",
        window: 30,
      },
    };
    const report = formatDoraReport(none);
    expect(report).toContain("none in window");
    expect(report).not.toContain("0 per month");
  });

  it("formats lead time in days when over 24 hours", () => {
    const longLead: DoraMetrics = {
      ...metrics,
      leadTimeToChange: { medianHours: 72, rating: "high", prCount: 10 },
    };
    const report = formatDoraReport(longLead);
    expect(report).toContain("3 days");
  });

  it("shows n/a for FDRT when no incidents", () => {
    const noIncidents: DoraMetrics = {
      ...metrics,
      failedDeployRecoveryTime: {
        medianHours: 0,
        rating: "elite",
        incidentCount: 0,
      },
    };
    const report = formatDoraReport(noIncidents);
    expect(report).toContain("n/a");
  });

  it("shows environment suffix when set", () => {
    const envMetrics: DoraMetrics = {
      ...metrics,
      environment: "production",
    };
    const report = formatDoraReport(envMetrics);
    expect(report).toContain("production");
  });
});
