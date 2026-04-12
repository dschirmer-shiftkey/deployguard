import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@actions/core", () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
}));

vi.mock("@actions/github", () => ({
  context: {
    repo: { owner: "test-org", repo: "test-repo" },
  },
  getOctokit: vi.fn(),
}));

import * as github from "@actions/github";
import {
  fetchCodeScanningAlerts,
  computeSecurityRiskFactor,
  formatSecuritySection,
} from "../security.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("fetchCodeScanningAlerts", () => {
  it("returns empty counts when API returns no alerts", async () => {
    const octokit = {
      request: vi.fn().mockResolvedValue({ data: [] }),
    };
    vi.mocked(github.getOctokit).mockReturnValue(
      octokit as unknown as ReturnType<typeof github.getOctokit>,
    );

    const result = await fetchCodeScanningAlerts("ghp_test");
    expect(result.total).toBe(0);
    expect(result.critical).toBe(0);
  });

  it("counts alerts by severity", async () => {
    const alerts = [
      {
        number: 1,
        state: "open",
        rule: {
          id: "js/xss",
          severity: "error",
          security_severity_level: "critical",
          description: "XSS vulnerability",
        },
        tool: { name: "CodeQL" },
        most_recent_instance: { ref: "main", state: "open" },
      },
      {
        number: 2,
        state: "open",
        rule: {
          id: "js/sql-injection",
          severity: "error",
          security_severity_level: "high",
          description: "SQL injection",
        },
        tool: { name: "CodeQL" },
        most_recent_instance: { ref: "main", state: "open" },
      },
      {
        number: 3,
        state: "open",
        rule: {
          id: "js/unused-var",
          severity: "warning",
          description: "Unused variable",
        },
        tool: { name: "CodeQL" },
        most_recent_instance: { ref: "main", state: "open" },
      },
    ];

    const octokit = {
      request: vi.fn().mockResolvedValue({ data: alerts }),
    };
    vi.mocked(github.getOctokit).mockReturnValue(
      octokit as unknown as ReturnType<typeof github.getOctokit>,
    );

    const result = await fetchCodeScanningAlerts("ghp_test");
    expect(result.total).toBe(3);
    expect(result.critical).toBe(1);
    expect(result.high).toBe(1);
    expect(result.medium).toBe(1);
  });

  it("respects ignore_rules config", async () => {
    const alerts = [
      {
        number: 1,
        state: "open",
        rule: {
          id: "js/xss",
          severity: "error",
          security_severity_level: "high",
          description: "XSS",
        },
        tool: { name: "CodeQL" },
        most_recent_instance: { ref: "main", state: "open" },
      },
      {
        number: 2,
        state: "open",
        rule: {
          id: "js/unused-var",
          severity: "warning",
          description: "Unused",
        },
        tool: { name: "CodeQL" },
        most_recent_instance: { ref: "main", state: "open" },
      },
    ];

    const octokit = {
      request: vi.fn().mockResolvedValue({ data: alerts }),
    };
    vi.mocked(github.getOctokit).mockReturnValue(
      octokit as unknown as ReturnType<typeof github.getOctokit>,
    );

    const result = await fetchCodeScanningAlerts("ghp_test", {
      severity_threshold: "warning",
      block_on_critical: true,
      ignore_rules: ["js/unused-var"],
    });
    expect(result.total).toBe(1);
    expect(result.high).toBe(1);
  });

  it("handles 403/404 gracefully", async () => {
    const octokit = {
      request: vi.fn().mockRejectedValue(new Error("403 Forbidden")),
    };
    vi.mocked(github.getOctokit).mockReturnValue(
      octokit as unknown as ReturnType<typeof github.getOctokit>,
    );

    const result = await fetchCodeScanningAlerts("ghp_test");
    expect(result.total).toBe(0);
  });
});

describe("computeSecurityRiskFactor", () => {
  it("returns null for zero alerts", () => {
    const result = computeSecurityRiskFactor({
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
      total: 0,
    });
    expect(result).toBeNull();
  });

  it("computes score from alert counts", () => {
    const result = computeSecurityRiskFactor({
      critical: 1,
      high: 2,
      medium: 3,
      low: 0,
      total: 6,
    });
    expect(result).not.toBeNull();
    expect(result?.type).toBe("security_alerts");
    expect(result?.score).toBe(75);
  });

  it("boosts score on critical with block_on_critical", () => {
    const result = computeSecurityRiskFactor(
      { critical: 1, high: 0, medium: 0, low: 0, total: 1 },
      { severity_threshold: "warning", block_on_critical: true, ignore_rules: [] },
    );
    expect(result?.score).toBe(90);
  });
});

describe("formatSecuritySection", () => {
  it("returns empty string for no alerts", () => {
    expect(
      formatSecuritySection({
        critical: 0,
        high: 0,
        medium: 0,
        low: 0,
        total: 0,
      }),
    ).toBe("");
  });

  it("renders markdown table", () => {
    const section = formatSecuritySection({
      critical: 1,
      high: 2,
      medium: 3,
      low: 0,
      total: 6,
      topRules: ["js/xss (3)", "js/sql-injection (2)"],
    });

    expect(section).toContain("Security Alerts");
    expect(section).toContain("Critical");
    expect(section).toContain("High");
    expect(section).toContain("Medium");
    expect(section).toContain("**6**");
    expect(section).toContain("js/xss");
  });
});
