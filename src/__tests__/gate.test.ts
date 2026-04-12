import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  computeRiskScore,
  isSensitiveFile,
  sensitivityWeight,
  suggestSplitBoundaries,
  isInFreezeWindow,
  decideGate,
  checkHealth,
  checkVercelHealth,
  checkSupabaseHealth,
  checkMcpHealth,
  postPrComment,
  createCheckRun,
  managePrLabels,
  requestHighRiskReviewers,
  formatGateReport,
} from "../gate.js";
import type { GateEvaluation } from "../types.js";

const {
  mockListComments,
  mockCreateComment,
  mockUpdateComment,
  mockChecksCreate,
  mockCreateLabel,
  mockListLabelsOnIssue,
  mockRemoveLabel,
  mockAddLabels,
  mockPullsGet,
  mockRequestReviewers,
} = vi.hoisted(() => ({
  mockListComments: vi.fn(),
  mockCreateComment: vi.fn(),
  mockUpdateComment: vi.fn(),
  mockChecksCreate: vi.fn(),
  mockCreateLabel: vi.fn(),
  mockListLabelsOnIssue: vi.fn(),
  mockRemoveLabel: vi.fn(),
  mockAddLabels: vi.fn(),
  mockPullsGet: vi.fn(),
  mockRequestReviewers: vi.fn(),
}));

vi.mock("@actions/core", () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  setFailed: vi.fn(),
  setOutput: vi.fn(),
  getInput: vi.fn().mockReturnValue(""),
}));

vi.mock("@actions/github", () => ({
  context: {
    repo: { owner: "test-owner", repo: "test-repo" },
  },
  getOctokit: () => ({
    rest: {
      issues: {
        listComments: mockListComments,
        createComment: mockCreateComment,
        updateComment: mockUpdateComment,
        createLabel: mockCreateLabel,
        listLabelsOnIssue: mockListLabelsOnIssue,
        removeLabel: mockRemoveLabel,
        addLabels: mockAddLabels,
      },
      checks: {
        create: mockChecksCreate,
      },
      pulls: {
        get: mockPullsGet,
        requestReviewers: mockRequestReviewers,
      },
    },
  }),
}));

// ---------------------------------------------------------------------------
// computeRiskScore
// ---------------------------------------------------------------------------

describe("computeRiskScore", () => {
  it("returns zero score and empty factors for no files", () => {
    const result = computeRiskScore([]);
    expect(result.score).toBe(0);
    expect(result.factors).toHaveLength(0);
  });

  it("produces a low score for a small, well-tested PR", () => {
    const result = computeRiskScore([
      { filename: "src/utils.ts", additions: 5, deletions: 2, changes: 7 },
      {
        filename: "src/__tests__/utils.test.ts",
        additions: 10,
        deletions: 0,
        changes: 10,
      },
    ]);
    expect(result.score).toBeLessThanOrEqual(30);
    expect(result.factors.find((f) => f.type === "file_count")).toBeDefined();
    expect(result.factors.find((f) => f.type === "code_churn")).toBeDefined();
    expect(result.factors.find((f) => f.type === "test_coverage")).toBeDefined();
  });

  it("produces a high score for a large PR with no tests", () => {
    const files = Array.from({ length: 25 }, (_, i) => ({
      filename: `src/module${i}.ts`,
      additions: 50,
      deletions: 20,
      changes: 70,
    }));
    const result = computeRiskScore(files);
    expect(result.score).toBeGreaterThanOrEqual(60);
  });

  it("caps the score at 100", () => {
    const files = Array.from({ length: 50 }, (_, i) => ({
      filename: `src/huge${i}.ts`,
      additions: 500,
      deletions: 500,
      changes: 1000,
    }));
    const result = computeRiskScore(files);
    expect(result.score).toBeLessThanOrEqual(100);
  });

  it("uses logarithmic scale for code_churn", () => {
    const small = computeRiskScore([
      { filename: "src/a.ts", additions: 50, deletions: 0, changes: 50 },
    ]);
    const medium = computeRiskScore([
      { filename: "src/a.ts", additions: 500, deletions: 0, changes: 500 },
    ]);
    const large = computeRiskScore([
      { filename: "src/a.ts", additions: 5000, deletions: 0, changes: 5000 },
    ]);
    const smallChurn = small.factors.find((f) => f.type === "code_churn")!;
    const mediumChurn = medium.factors.find((f) => f.type === "code_churn")!;
    const largeChurn = large.factors.find((f) => f.type === "code_churn")!;
    expect(smallChurn.score).toBeLessThan(mediumChurn.score);
    expect(mediumChurn.score).toBeLessThan(largeChurn.score);
    expect(mediumChurn.score).toBeLessThan(100);
  });

  it("uses logarithmic scale for file_count", () => {
    const makeFiles = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        filename: `src/f${i}.ts`,
        additions: 1,
        deletions: 0,
        changes: 1,
      }));
    const small = computeRiskScore(makeFiles(3));
    const large = computeRiskScore(makeFiles(30));
    const smallCount = small.factors.find((f) => f.type === "file_count")!;
    const largeCount = large.factors.find((f) => f.type === "file_count")!;
    expect(smallCount.score).toBeLessThan(largeCount.score);
    expect(smallCount.score).toBeLessThan(100);
  });

  it("excludes non-source files from test_coverage denominator", () => {
    const result = computeRiskScore([
      { filename: "README.md", additions: 10, deletions: 0, changes: 10 },
      { filename: "schema.json", additions: 5, deletions: 0, changes: 5 },
      { filename: "migrations/001.sql", additions: 20, deletions: 0, changes: 20 },
    ]);
    const testCov = result.factors.find((f) => f.type === "test_coverage");
    expect(testCov).toBeUndefined();
  });

  it("includes test_coverage when source files are present alongside non-source", () => {
    const result = computeRiskScore([
      { filename: "src/app.ts", additions: 50, deletions: 0, changes: 50 },
      { filename: "README.md", additions: 10, deletions: 0, changes: 10 },
    ]);
    const testCov = result.factors.find((f) => f.type === "test_coverage");
    expect(testCov).toBeDefined();
    expect(testCov!.score).toBe(100);
  });

  it("gives lower test_coverage risk when tests are present", () => {
    const noTests = computeRiskScore([
      { filename: "src/a.ts", additions: 10, deletions: 0, changes: 10 },
      { filename: "src/b.ts", additions: 10, deletions: 0, changes: 10 },
    ]);
    const withTests = computeRiskScore([
      { filename: "src/a.ts", additions: 10, deletions: 0, changes: 10 },
      { filename: "src/a.test.ts", additions: 10, deletions: 0, changes: 10 },
    ]);
    const noTestsCov = noTests.factors.find((f) => f.type === "test_coverage")!;
    const withTestsCov = withTests.factors.find((f) => f.type === "test_coverage")!;
    expect(noTestsCov.score).toBeGreaterThan(withTestsCov.score);
  });

  it("detects sensitive files and produces a sensitive_files factor", () => {
    const result = computeRiskScore([
      {
        filename: "supabase/migrations/001.sql",
        additions: 20,
        deletions: 0,
        changes: 20,
      },
      { filename: "src/auth/login.ts", additions: 30, deletions: 0, changes: 30 },
      {
        filename: "src/api/payment/checkout.ts",
        additions: 40,
        deletions: 0,
        changes: 40,
      },
      { filename: "src/utils.ts", additions: 5, deletions: 0, changes: 5 },
    ]);
    const sensitive = result.factors.find((f) => f.type === "sensitive_files");
    expect(sensitive).toBeDefined();
    expect(sensitive!.score).toBe(75);
  });

  it("does not produce sensitive_files factor when none match", () => {
    const result = computeRiskScore([
      { filename: "src/utils.ts", additions: 10, deletions: 0, changes: 10 },
      { filename: "src/helpers.ts", additions: 5, deletions: 0, changes: 5 },
    ]);
    const sensitive = result.factors.find((f) => f.type === "sensitive_files");
    expect(sensitive).toBeUndefined();
  });

  it("weights sensitive_files heavily in the overall score", () => {
    const result = computeRiskScore([
      { filename: "src/auth/login.ts", additions: 5, deletions: 0, changes: 5 },
      { filename: "src/payment/checkout.ts", additions: 5, deletions: 0, changes: 5 },
      { filename: "src/billing/invoice.ts", additions: 5, deletions: 0, changes: 5 },
      { filename: "src/webhook/stripe.ts", additions: 5, deletions: 0, changes: 5 },
    ]);
    const sensitiveF = result.factors.find((f) => f.type === "sensitive_files");
    expect(sensitiveF).toBeDefined();
    expect(sensitiveF!.score).toBe(100);
    expect(result.score).toBeGreaterThanOrEqual(60);
  });

  it("weights auth file churn at 3x (diff-aware scoring)", () => {
    const normal = computeRiskScore([
      { filename: "src/utils.ts", additions: 100, deletions: 0, changes: 100 },
    ]);
    const auth = computeRiskScore([
      { filename: "src/auth/login.ts", additions: 100, deletions: 0, changes: 100 },
    ]);
    const normalChurn = normal.factors.find((f) => f.type === "code_churn")!;
    const authChurn = auth.factors.find((f) => f.type === "code_churn")!;
    expect(authChurn.score).toBeGreaterThan(normalChurn.score);
    const authDetail = authChurn.detail as { weightedChanges: number };
    expect(authDetail.weightedChanges).toBe(300);
  });

  it("weights test file churn at 0.3x (diff-aware scoring)", () => {
    const result = computeRiskScore([
      {
        filename: "src/__tests__/app.test.ts",
        additions: 500,
        deletions: 0,
        changes: 500,
      },
    ]);
    const churn = result.factors.find((f) => f.type === "code_churn")!;
    const detail = churn.detail as { weightedChanges: number };
    expect(detail.weightedChanges).toBe(150);
  });

  it("weights config/non-source file churn at 0.5x", () => {
    const result = computeRiskScore([
      { filename: "README.md", additions: 200, deletions: 0, changes: 200 },
    ]);
    const churn = result.factors.find((f) => f.type === "code_churn")!;
    const detail = churn.detail as { weightedChanges: number };
    expect(detail.weightedChanges).toBe(100);
  });

  it("weights infrastructure file churn at 2x", () => {
    const result = computeRiskScore([
      { filename: ".github/workflows/ci.yml", additions: 50, deletions: 0, changes: 50 },
    ]);
    const churn = result.factors.find((f) => f.type === "code_churn")!;
    const detail = churn.detail as { weightedChanges: number };
    expect(detail.weightedChanges).toBe(100);
  });

  it("includes both totalChanges and weightedChanges in churn detail", () => {
    const result = computeRiskScore([
      { filename: "src/auth/login.ts", additions: 50, deletions: 0, changes: 50 },
      { filename: "src/utils.ts", additions: 50, deletions: 0, changes: 50 },
    ]);
    const churn = result.factors.find((f) => f.type === "code_churn")!;
    const detail = churn.detail as {
      totalChanges: number;
      weightedChanges: number;
    };
    expect(detail.totalChanges).toBe(100);
    expect(detail.weightedChanges).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// sensitivityWeight
// ---------------------------------------------------------------------------

describe("sensitivityWeight", () => {
  it("returns 3 for auth files", () => {
    expect(sensitivityWeight("src/auth/login.ts")).toBe(3);
  });
  it("returns 3 for payment files", () => {
    expect(sensitivityWeight("src/payment/checkout.ts")).toBe(3);
  });
  it("returns 3 for security files", () => {
    expect(sensitivityWeight("lib/security/validate.ts")).toBe(3);
  });
  it("returns 3 for billing files", () => {
    expect(sensitivityWeight("billing/invoice.ts")).toBe(3);
  });
  it("returns 3 for webhook files", () => {
    expect(sensitivityWeight("src/webhook/stripe.ts")).toBe(3);
  });
  it("returns 2 for migration files", () => {
    expect(sensitivityWeight("supabase/migrations/001.sql")).toBe(2);
  });
  it("returns 2 for workflow files", () => {
    expect(sensitivityWeight(".github/workflows/ci.yml")).toBe(2);
  });
  it("returns 2 for .env files", () => {
    expect(sensitivityWeight(".env.production")).toBe(2);
  });
  it("returns 0.3 for test files", () => {
    expect(sensitivityWeight("src/__tests__/utils.test.ts")).toBe(0.3);
  });
  it("returns 0.5 for non-source files", () => {
    expect(sensitivityWeight("README.md")).toBe(0.5);
    expect(sensitivityWeight("package.json")).toBe(0.5);
    expect(sensitivityWeight("styles/main.css")).toBe(0.5);
  });
  it("returns 1 for regular source files", () => {
    expect(sensitivityWeight("src/utils.ts")).toBe(1);
    expect(sensitivityWeight("lib/helpers.js")).toBe(1);
  });
  it("prioritizes test detection over non-source for .test.ts files", () => {
    expect(sensitivityWeight("src/auth.test.ts")).toBe(0.3);
  });
});

// ---------------------------------------------------------------------------
// suggestSplitBoundaries
// ---------------------------------------------------------------------------

describe("suggestSplitBoundaries", () => {
  it("returns empty for fewer than 5 files", () => {
    expect(
      suggestSplitBoundaries(["src/a.ts", "src/b.ts", "lib/c.ts", "lib/d.ts"]),
    ).toEqual([]);
  });

  it("returns empty when all files are in the same group", () => {
    const files = Array.from({ length: 10 }, (_, i) => `src/components/c${i}.tsx`);
    expect(suggestSplitBoundaries(files)).toEqual([]);
  });

  it("suggests splitting two clear groups", () => {
    const files = [
      "src/components/Header.tsx",
      "src/components/Footer.tsx",
      "src/components/Nav.tsx",
      "supabase/migrations/001.sql",
      "supabase/migrations/002.sql",
    ];
    const suggestions = suggestSplitBoundaries(files);
    expect(suggestions.length).toBeGreaterThanOrEqual(1);
    expect(suggestions[0]).toContain("src/components/");
    expect(suggestions[0]).toContain("separate PR");
  });

  it("groups .github files under CI/workflow", () => {
    const files = [
      ".github/workflows/ci.yml",
      ".github/workflows/deploy.yml",
      "src/app/page.tsx",
      "src/app/layout.tsx",
      "src/app/globals.css",
    ];
    const suggestions = suggestSplitBoundaries(files);
    expect(suggestions.length).toBeGreaterThanOrEqual(1);
    expect(suggestions[0]).toContain("CI/workflow");
  });

  it("reports additional groups when more than 2 exist", () => {
    const files = [
      "src/auth/login.ts",
      "src/auth/signup.ts",
      "src/auth/oauth.ts",
      "lib/utils/format.ts",
      "lib/utils/parse.ts",
      "supabase/migrations/001.sql",
      "supabase/migrations/002.sql",
    ];
    const suggestions = suggestSplitBoundaries(files);
    expect(suggestions.length).toBe(2);
    expect(suggestions[1]).toContain("also be separable");
  });
});

// ---------------------------------------------------------------------------
// isSensitiveFile
// ---------------------------------------------------------------------------

describe("isSensitiveFile", () => {
  it("detects migration files", () => {
    expect(isSensitiveFile("supabase/migrations/001.sql")).toBe(true);
  });

  it("detects auth files", () => {
    expect(isSensitiveFile("src/auth/login.ts")).toBe(true);
  });

  it("detects payment/webhook files", () => {
    expect(isSensitiveFile("api/payment/charge.ts")).toBe(true);
    expect(isSensitiveFile("api/webhook/stripe.ts")).toBe(true);
  });

  it("detects CI workflow files", () => {
    expect(isSensitiveFile(".github/workflows/deploy.yml")).toBe(true);
  });

  it("returns false for normal source files", () => {
    expect(isSensitiveFile("src/components/Button.tsx")).toBe(false);
    expect(isSensitiveFile("src/utils/format.ts")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// decideGate
// ---------------------------------------------------------------------------

describe("decideGate", () => {
  it("allows when risk is well below threshold and health is good", () => {
    expect(decideGate(20, 100, 70)).toBe("allow");
  });

  it("warns when risk exceeds warn threshold (default: block - 15)", () => {
    expect(decideGate(56, 100, 70)).toBe("warn");
  });

  it("allows when risk is below the default warn threshold", () => {
    expect(decideGate(54, 100, 70)).toBe("allow");
  });

  it("warns when health is degraded even if risk is low", () => {
    expect(decideGate(10, 40, 70)).toBe("warn");
  });

  it("blocks when risk exceeds threshold", () => {
    expect(decideGate(80, 100, 70)).toBe("block");
  });

  it("blocks when risk equals threshold + 1", () => {
    expect(decideGate(71, 100, 70)).toBe("block");
  });

  it("does not block at exactly the threshold", () => {
    const decision = decideGate(70, 100, 70);
    expect(decision).not.toBe("block");
  });

  it("respects custom warn threshold", () => {
    expect(decideGate(45, 100, 70, 40)).toBe("warn");
    expect(decideGate(35, 100, 70, 40)).toBe("allow");
  });
});

// ---------------------------------------------------------------------------
// checkHealth
// ---------------------------------------------------------------------------

describe("checkHealth", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns allow for a 200 response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const result = await checkHealth("https://api.example.com/health");
    expect(result.status).toBe("allow");
    expect(result.target).toBe("https://api.example.com/health");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("returns warn for a 4xx response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response("not found", { status: 404 }));
    const result = await checkHealth("https://api.example.com/health");
    expect(result.status).toBe("warn");
  });

  it("returns block for a 5xx response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response("error", { status: 500 }));
    const result = await checkHealth("https://api.example.com/health");
    expect(result.status).toBe("block");
  });

  it("returns warn (fail-open) on network error", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const result = await checkHealth("https://api.example.com/health");
    expect(result.status).toBe("warn");
    expect(result.detail).toHaveProperty("error");
  });
});

// ---------------------------------------------------------------------------
// formatGateReport
// ---------------------------------------------------------------------------

describe("formatGateReport", () => {
  const baseEvaluation: GateEvaluation = {
    id: "dg-abc1234-1700000000",
    repoId: "owner/repo",
    commitSha: "abc1234567890",
    healthScore: 100,
    riskScore: 30,
    gateDecision: "allow",
    healthChecks: [],
    riskFactors: [
      {
        type: "code_churn",
        score: 30,
        detail: {
          totalChanges: 150,
          weightedChanges: 150,
          description: "Sensitivity-weighted lines changed",
        },
      },
    ],
    evaluationMs: 42,
  };

  it("shows n/a for health when no checks configured", () => {
    const report = formatGateReport(baseEvaluation);
    expect(report).toContain("n/a (not configured)");
    expect(report).toContain("30/100");
    expect(report).toContain("ALLOW");
  });

  it("shows actual health score when checks are present", () => {
    const evaluation: GateEvaluation = {
      ...baseEvaluation,
      healthChecks: [
        { target: "https://api.example.com/health", status: "allow", latencyMs: 50 },
      ],
    };
    const report = formatGateReport(evaluation);
    expect(report).toContain("100/100");
    expect(report).not.toContain("n/a");
  });

  it("lists risk factors when present", () => {
    const report = formatGateReport(baseEvaluation);
    expect(report).toContain("code_churn");
    expect(report).toContain("Sensitivity-weighted lines changed");
  });

  it("lists health checks when present", () => {
    const evaluation: GateEvaluation = {
      ...baseEvaluation,
      healthChecks: [
        {
          target: "https://api.example.com/health",
          status: "allow",
          latencyMs: 123,
        },
      ],
    };
    const report = formatGateReport(evaluation);
    expect(report).toContain("https://api.example.com/health");
    expect(report).toContain("ALLOW");
    expect(report).toContain("123ms");
  });

  it("includes collapsed file list with sensitive markers", () => {
    const evaluation: GateEvaluation = {
      ...baseEvaluation,
      files: ["src/utils.ts", "src/auth/login.ts", "supabase/migrations/001.sql"],
    };
    const report = formatGateReport(evaluation);
    expect(report).toContain("Files changed (3)");
    expect(report).toContain("`src/utils.ts`");
    expect(report).toContain("`src/auth/login.ts` **⚠ sensitive**");
    expect(report).toContain("`supabase/migrations/001.sql` **⚠ sensitive**");
  });

  it("omits file list when no files are present", () => {
    const report = formatGateReport(baseEvaluation);
    expect(report).not.toContain("Files changed");
  });

  it("includes report URL when provided", () => {
    const evaluation: GateEvaluation = {
      ...baseEvaluation,
      reportUrl: "https://example.com/reports/abc",
    };
    const report = formatGateReport(evaluation);
    expect(report).toContain("[View full report](https://example.com/reports/abc)");
  });

  it("omits sections that have no data", () => {
    const evaluation: GateEvaluation = {
      ...baseEvaluation,
      riskFactors: [],
      healthChecks: [],
    };
    const report = formatGateReport(evaluation);
    expect(report).not.toContain("### Risk Factors");
    expect(report).not.toContain("### Health Checks");
  });

  it("includes score bar when riskThreshold is provided", () => {
    const report = formatGateReport(baseEvaluation, 70);
    expect(report).toContain("30/100 (threshold: 70)");
    expect(report).toContain("█");
    expect(report).toContain("░");
  });

  it("omits score bar when riskThreshold is not provided", () => {
    const report = formatGateReport(baseEvaluation);
    expect(report).not.toContain("threshold:");
  });

  it("includes guidance for block with sensitive files", () => {
    const evaluation: GateEvaluation = {
      ...baseEvaluation,
      gateDecision: "block",
      riskScore: 85,
      riskFactors: [
        { type: "sensitive_files", score: 75, detail: { count: 3 } },
        { type: "code_churn", score: 50, detail: { totalChanges: 300 } },
      ],
    };
    const report = formatGateReport(evaluation);
    expect(report).toContain("### Guidance");
    expect(report).toContain("high-risk files");
  });

  it("includes guidance for warn with high code churn", () => {
    const evaluation: GateEvaluation = {
      ...baseEvaluation,
      gateDecision: "warn",
      riskScore: 60,
      riskFactors: [
        {
          type: "code_churn",
          score: 80,
          detail: {
            totalChanges: 2000,
            weightedChanges: 2000,
            description: "Sensitivity-weighted lines changed",
          },
        },
      ],
    };
    const report = formatGateReport(evaluation);
    expect(report).toContain("### Guidance");
    expect(report).toContain("Large changeset");
  });

  it("includes guidance for warn with no test files", () => {
    const evaluation: GateEvaluation = {
      ...baseEvaluation,
      gateDecision: "warn",
      riskScore: 60,
      riskFactors: [
        {
          type: "test_coverage",
          score: 100,
          detail: { testFiles: 0, sourceFiles: 5, description: "Test coverage" },
        },
      ],
    };
    const report = formatGateReport(evaluation);
    expect(report).toContain("No test files");
  });

  it("includes low test-to-source guidance when some tests exist but ratio is bad", () => {
    const evaluation: GateEvaluation = {
      ...baseEvaluation,
      gateDecision: "warn",
      riskScore: 60,
      riskFactors: [
        {
          type: "test_coverage",
          score: 85,
          detail: { testFiles: 1, sourceFiles: 10, description: "Test coverage" },
        },
      ],
    };
    const report = formatGateReport(evaluation);
    expect(report).toContain("Low test-to-source ratio");
  });

  it("includes guidance for high file count", () => {
    const evaluation: GateEvaluation = {
      ...baseEvaluation,
      gateDecision: "block",
      riskScore: 80,
      riskFactors: [
        {
          type: "file_count",
          score: 90,
          detail: { fileCount: 50, description: "Files changed" },
        },
      ],
    };
    const report = formatGateReport(evaluation);
    expect(report).toContain("Many files changed");
  });

  it("shows generic guidance when decision is warn/block but no specific factor triggers", () => {
    const evaluation: GateEvaluation = {
      ...baseEvaluation,
      gateDecision: "warn",
      riskScore: 60,
      riskFactors: [
        { type: "author_history", score: 80, detail: { description: "New contributor" } },
      ],
    };
    const report = formatGateReport(evaluation);
    expect(report).toContain("### Guidance");
    expect(report).toContain("Risk score exceeds threshold");
  });

  it("omits guidance for allow decision", () => {
    const report = formatGateReport(baseEvaluation);
    expect(report).not.toContain("### Guidance");
  });

  it("includes split boundary suggestions when churn is high and files span multiple directories", () => {
    const evaluation: GateEvaluation = {
      ...baseEvaluation,
      gateDecision: "warn",
      riskScore: 60,
      riskFactors: [
        {
          type: "code_churn",
          score: 80,
          detail: {
            totalChanges: 2000,
            weightedChanges: 2000,
            description: "Sensitivity-weighted lines changed",
          },
        },
      ],
      files: [
        "src/components/Header.tsx",
        "src/components/Footer.tsx",
        "src/components/Nav.tsx",
        "supabase/migrations/001.sql",
        "supabase/migrations/002.sql",
      ],
    };
    const report = formatGateReport(evaluation);
    expect(report).toContain("Suggested split");
    expect(report).toContain("separate PR");
  });
});

// ---------------------------------------------------------------------------
// Exhaustive switch contract — compile-time guarantee
// ---------------------------------------------------------------------------

describe("GateDecision exhaustiveness", () => {
  it("decideGate only returns valid GateDecision values", () => {
    const validDecisions = new Set(["allow", "warn", "block"]);
    const testCases = [
      { risk: 0, health: 100, threshold: 70 },
      { risk: 50, health: 100, threshold: 70 },
      { risk: 56, health: 100, threshold: 70 },
      { risk: 80, health: 100, threshold: 70 },
      { risk: 10, health: 30, threshold: 70 },
    ];
    for (const { risk, health, threshold } of testCases) {
      const decision = decideGate(risk, health, threshold);
      expect(validDecisions.has(decision)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// checkMcpHealth
// ---------------------------------------------------------------------------

describe("checkMcpHealth", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.MCP_GATEWAY_URL;
    delete process.env.MCP_GATEWAY_KEY;
  });

  it("returns null when env vars are not set", async () => {
    const result = await checkMcpHealth();
    expect(result).toBeNull();
  });

  it("returns null when only URL is set without key", async () => {
    process.env.MCP_GATEWAY_URL = "https://mcp.example.com";
    const result = await checkMcpHealth();
    expect(result).toBeNull();
  });

  it("returns allow when MCP reports healthy", async () => {
    process.env.MCP_GATEWAY_URL = "https://mcp.example.com";
    process.env.MCP_GATEWAY_KEY = "test-key";
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ result: { healthy: true } }), {
        status: 200,
      }),
    );
    const result = await checkMcpHealth();
    expect(result).not.toBeNull();
    expect(result!.status).toBe("allow");
    expect(result!.target).toContain("mcp:");
  });

  it("returns warn when MCP reports unhealthy", async () => {
    process.env.MCP_GATEWAY_URL = "https://mcp.example.com";
    process.env.MCP_GATEWAY_KEY = "test-key";
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ result: { healthy: false } }), {
        status: 200,
      }),
    );
    const result = await checkMcpHealth();
    expect(result!.status).toBe("warn");
  });

  it("returns warn when MCP returns non-200", async () => {
    process.env.MCP_GATEWAY_URL = "https://mcp.example.com";
    process.env.MCP_GATEWAY_KEY = "test-key";
    vi.mocked(fetch).mockResolvedValueOnce(new Response("error", { status: 500 }));
    const result = await checkMcpHealth();
    expect(result!.status).toBe("warn");
    expect(result!.detail).toHaveProperty("httpStatus", 500);
  });

  it("returns warn on network error (fail-open)", async () => {
    process.env.MCP_GATEWAY_URL = "https://mcp.example.com";
    process.env.MCP_GATEWAY_KEY = "test-key";
    vi.mocked(fetch).mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const result = await checkMcpHealth();
    expect(result!.status).toBe("warn");
    expect(result!.detail).toHaveProperty("error");
  });
});

// ---------------------------------------------------------------------------
// checkVercelHealth
// ---------------------------------------------------------------------------

describe("checkVercelHealth", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.VERCEL_TOKEN;
    delete process.env.VERCEL_PROJECT_ID;
  });

  it("returns null when env vars are not set", async () => {
    const result = await checkVercelHealth();
    expect(result).toBeNull();
  });

  it("returns null when only token is set without project ID", async () => {
    process.env.VERCEL_TOKEN = "test-token";
    const result = await checkVercelHealth();
    expect(result).toBeNull();
  });

  it("returns allow when latest deployment is READY", async () => {
    process.env.VERCEL_TOKEN = "test-token";
    process.env.VERCEL_PROJECT_ID = "prj_test";
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          deployments: [{ readyState: "READY", url: "my-app.vercel.app" }],
        }),
        { status: 200 },
      ),
    );
    const result = await checkVercelHealth();
    expect(result).not.toBeNull();
    expect(result!.status).toBe("allow");
    expect(result!.target).toBe("vercel:production");
    expect(result!.detail).toHaveProperty("readyState", "READY");
  });

  it("returns block when latest deployment is ERROR", async () => {
    process.env.VERCEL_TOKEN = "test-token";
    process.env.VERCEL_PROJECT_ID = "prj_test";
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          deployments: [{ readyState: "ERROR", url: "my-app.vercel.app" }],
        }),
        { status: 200 },
      ),
    );
    const result = await checkVercelHealth();
    expect(result!.status).toBe("block");
  });

  it("returns block when latest deployment is CANCELED", async () => {
    process.env.VERCEL_TOKEN = "test-token";
    process.env.VERCEL_PROJECT_ID = "prj_test";
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ deployments: [{ readyState: "CANCELED" }] }), {
        status: 200,
      }),
    );
    const result = await checkVercelHealth();
    expect(result!.status).toBe("block");
  });

  it("returns warn when latest deployment is BUILDING", async () => {
    process.env.VERCEL_TOKEN = "test-token";
    process.env.VERCEL_PROJECT_ID = "prj_test";
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ deployments: [{ readyState: "BUILDING" }] }), {
        status: 200,
      }),
    );
    const result = await checkVercelHealth();
    expect(result!.status).toBe("warn");
  });

  it("returns warn when no deployments found", async () => {
    process.env.VERCEL_TOKEN = "test-token";
    process.env.VERCEL_PROJECT_ID = "prj_test";
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ deployments: [] }), { status: 200 }),
    );
    const result = await checkVercelHealth();
    expect(result!.status).toBe("warn");
    expect(result!.detail).toHaveProperty("reason", "no deployments found");
  });

  it("returns warn when API returns non-200", async () => {
    process.env.VERCEL_TOKEN = "test-token";
    process.env.VERCEL_PROJECT_ID = "prj_test";
    vi.mocked(fetch).mockResolvedValueOnce(new Response("forbidden", { status: 403 }));
    const result = await checkVercelHealth();
    expect(result!.status).toBe("warn");
    expect(result!.detail).toHaveProperty("httpStatus", 403);
  });

  it("returns warn on network error (fail-open)", async () => {
    process.env.VERCEL_TOKEN = "test-token";
    process.env.VERCEL_PROJECT_ID = "prj_test";
    vi.mocked(fetch).mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const result = await checkVercelHealth();
    expect(result!.status).toBe("warn");
    expect(result!.detail).toHaveProperty("error");
  });
});

// ---------------------------------------------------------------------------
// checkSupabaseHealth
// ---------------------------------------------------------------------------

describe("checkSupabaseHealth", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_ANON_KEY;
  });

  it("returns null when env vars are not set", async () => {
    const result = await checkSupabaseHealth();
    expect(result).toBeNull();
  });

  it("returns null when only URL is set without key", async () => {
    process.env.SUPABASE_URL = "https://abc.supabase.co";
    const result = await checkSupabaseHealth();
    expect(result).toBeNull();
  });

  it("returns allow when Supabase REST returns 200", async () => {
    process.env.SUPABASE_URL = "https://abc.supabase.co";
    process.env.SUPABASE_ANON_KEY = "test-anon-key";
    vi.mocked(fetch).mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const result = await checkSupabaseHealth();
    expect(result).not.toBeNull();
    expect(result!.status).toBe("allow");
    expect(result!.target).toBe("supabase:rest");
    expect(result!.detail).toHaveProperty("httpStatus", 200);
  });

  it("returns warn when Supabase REST returns non-200", async () => {
    process.env.SUPABASE_URL = "https://abc.supabase.co";
    process.env.SUPABASE_ANON_KEY = "test-anon-key";
    vi.mocked(fetch).mockResolvedValueOnce(new Response("error", { status: 503 }));
    const result = await checkSupabaseHealth();
    expect(result!.status).toBe("warn");
  });

  it("returns warn on network error (fail-open)", async () => {
    process.env.SUPABASE_URL = "https://abc.supabase.co";
    process.env.SUPABASE_ANON_KEY = "test-anon-key";
    vi.mocked(fetch).mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const result = await checkSupabaseHealth();
    expect(result!.status).toBe("warn");
    expect(result!.detail).toHaveProperty("error");
  });

  it("sends correct headers to Supabase", async () => {
    process.env.SUPABASE_URL = "https://abc.supabase.co";
    process.env.SUPABASE_ANON_KEY = "test-anon-key";
    vi.mocked(fetch).mockResolvedValueOnce(new Response("ok", { status: 200 }));
    await checkSupabaseHealth();

    expect(fetch).toHaveBeenCalledWith(
      "https://abc.supabase.co/rest/v1/",
      expect.objectContaining({
        headers: {
          apikey: "test-anon-key",
          Authorization: "Bearer test-anon-key",
        },
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// postPrComment
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// createCheckRun
// ---------------------------------------------------------------------------

describe("createCheckRun", () => {
  beforeEach(() => {
    mockChecksCreate.mockReset().mockResolvedValue({});
  });

  const baseEval: GateEvaluation = {
    id: "dg-test",
    repoId: "test-owner/test-repo",
    commitSha: "abc1234567890",
    healthScore: 100,
    riskScore: 30,
    gateDecision: "allow",
    healthChecks: [],
    riskFactors: [],
    evaluationMs: 10,
  };

  it("creates a check run with success conclusion for allow", async () => {
    await createCheckRun(baseEval, "## Report", "ghp_test");
    expect(mockChecksCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "test-owner",
        repo: "test-repo",
        name: "DeployGuard",
        head_sha: "abc1234567890",
        status: "completed",
        conclusion: "success",
        output: expect.objectContaining({
          title: "DeployGuard: ALLOW",
          summary: "## Report",
        }),
      }),
    );
  });

  it("creates a check run with neutral conclusion for warn", async () => {
    await createCheckRun({ ...baseEval, gateDecision: "warn" }, "## Warn", "ghp_test");
    expect(mockChecksCreate).toHaveBeenCalledWith(
      expect.objectContaining({ conclusion: "neutral" }),
    );
  });

  it("creates a check run with failure conclusion for block", async () => {
    await createCheckRun({ ...baseEval, gateDecision: "block" }, "## Block", "ghp_test");
    expect(mockChecksCreate).toHaveBeenCalledWith(
      expect.objectContaining({ conclusion: "failure" }),
    );
  });

  it("handles API errors gracefully", async () => {
    mockChecksCreate.mockRejectedValue(new Error("forbidden"));
    await expect(
      createCheckRun(baseEval, "## Report", "ghp_test"),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// managePrLabels
// ---------------------------------------------------------------------------

describe("managePrLabels", () => {
  beforeEach(() => {
    mockCreateLabel.mockReset().mockResolvedValue({});
    mockListLabelsOnIssue.mockReset().mockResolvedValue({ data: [] });
    mockRemoveLabel.mockReset().mockResolvedValue({});
    mockAddLabels.mockReset().mockResolvedValue({});
  });

  it("creates labels, removes old ones, and adds the correct label for allow", async () => {
    mockListLabelsOnIssue.mockResolvedValue({
      data: [{ name: "deployguard:high-risk" }],
    });
    await managePrLabels(42, "allow", "ghp_test");

    expect(mockCreateLabel).toHaveBeenCalledTimes(3);
    expect(mockRemoveLabel).toHaveBeenCalledWith(
      expect.objectContaining({ name: "deployguard:high-risk" }),
    );
    expect(mockAddLabels).toHaveBeenCalledWith(
      expect.objectContaining({ labels: ["deployguard:low-risk"] }),
    );
  });

  it("adds medium-risk label for warn decision", async () => {
    await managePrLabels(42, "warn", "ghp_test");
    expect(mockAddLabels).toHaveBeenCalledWith(
      expect.objectContaining({ labels: ["deployguard:medium-risk"] }),
    );
  });

  it("adds high-risk label for block decision", async () => {
    await managePrLabels(42, "block", "ghp_test");
    expect(mockAddLabels).toHaveBeenCalledWith(
      expect.objectContaining({ labels: ["deployguard:high-risk"] }),
    );
  });

  it("skips adding label if already applied", async () => {
    mockListLabelsOnIssue.mockResolvedValue({
      data: [{ name: "deployguard:low-risk" }],
    });
    await managePrLabels(42, "allow", "ghp_test");
    expect(mockAddLabels).not.toHaveBeenCalled();
  });

  it("handles createLabel 422 (already exists) gracefully", async () => {
    mockCreateLabel.mockRejectedValue(new Error("Validation Failed"));
    await managePrLabels(42, "allow", "ghp_test");
    expect(mockAddLabels).toHaveBeenCalled();
  });

  it("handles API errors gracefully", async () => {
    mockListLabelsOnIssue.mockRejectedValue(new Error("forbidden"));
    await expect(managePrLabels(42, "allow", "ghp_test")).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// requestHighRiskReviewers
// ---------------------------------------------------------------------------

describe("requestHighRiskReviewers", () => {
  beforeEach(() => {
    mockPullsGet.mockReset().mockResolvedValue({
      data: { user: { login: "pr-author" } },
    });
    mockRequestReviewers.mockReset().mockResolvedValue({});
  });

  it("requests reviewers excluding the PR author", async () => {
    await requestHighRiskReviewers(42, ["alice", "pr-author", "bob"], "ghp_test");
    expect(mockRequestReviewers).toHaveBeenCalledWith(
      expect.objectContaining({
        pull_number: 42,
        reviewers: ["alice", "bob"],
      }),
    );
  });

  it("does nothing if the only reviewer is the PR author", async () => {
    await requestHighRiskReviewers(42, ["pr-author"], "ghp_test");
    expect(mockRequestReviewers).not.toHaveBeenCalled();
  });

  it("does nothing for empty reviewers list", async () => {
    await requestHighRiskReviewers(42, [], "ghp_test");
    expect(mockPullsGet).not.toHaveBeenCalled();
    expect(mockRequestReviewers).not.toHaveBeenCalled();
  });

  it("handles API errors gracefully", async () => {
    mockPullsGet.mockRejectedValue(new Error("not found"));
    await expect(
      requestHighRiskReviewers(42, ["alice"], "ghp_test"),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// postPrComment
// ---------------------------------------------------------------------------

describe("postPrComment", () => {
  beforeEach(() => {
    mockListComments.mockReset();
    mockCreateComment.mockReset().mockResolvedValue({});
    mockUpdateComment.mockReset().mockResolvedValue({});
  });

  it("creates a new comment when no existing marker found", async () => {
    mockListComments.mockResolvedValue({ data: [] });
    await postPrComment("## Report", 42, "ghp_test");

    expect(mockCreateComment).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "test-owner",
        repo: "test-repo",
        issue_number: 42,
        body: expect.stringContaining("<!-- deployguard-gate-report -->"),
      }),
    );
    expect(mockUpdateComment).not.toHaveBeenCalled();
  });

  it("updates an existing comment when marker is found", async () => {
    mockListComments.mockResolvedValue({
      data: [{ id: 999, body: "<!-- deployguard-gate-report -->\nold report" }],
    });
    await postPrComment("## Updated Report", 42, "ghp_test");

    expect(mockUpdateComment).toHaveBeenCalledWith(
      expect.objectContaining({
        comment_id: 999,
        body: expect.stringContaining("## Updated Report"),
      }),
    );
    expect(mockCreateComment).not.toHaveBeenCalled();
  });

  it("handles API errors gracefully without throwing", async () => {
    mockListComments.mockRejectedValue(new Error("GitHub API error"));
    await expect(postPrComment("## Report", 42, "ghp_test")).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Freeze window
// ---------------------------------------------------------------------------

describe("isInFreezeWindow", () => {
  it("returns frozen=false when no freeze windows defined", () => {
    expect(isInFreezeWindow([])).toEqual({ frozen: false });
  });

  it("matches a day-based freeze window", () => {
    const friday3pm = new Date("2026-04-10T15:00:00Z"); // Friday
    const result = isInFreezeWindow(
      [{ days: ["friday"], afterHour: 15, timezone: "UTC" }],
      friday3pm,
    );
    expect(result.frozen).toBe(true);
  });

  it("does not freeze outside the specified hours", () => {
    const friday10am = new Date("2026-04-10T10:00:00Z"); // Friday
    const result = isInFreezeWindow(
      [{ days: ["friday"], afterHour: 15, timezone: "UTC" }],
      friday10am,
    );
    expect(result.frozen).toBe(false);
  });

  it("does not freeze on the wrong day", () => {
    const monday3pm = new Date("2026-04-13T15:00:00Z"); // Monday
    const result = isInFreezeWindow(
      [{ days: ["friday"], afterHour: 15, timezone: "UTC" }],
      monday3pm,
    );
    expect(result.frozen).toBe(false);
  });

  it("includes custom message when frozen", () => {
    const friday3pm = new Date("2026-04-10T15:00:00Z");
    const result = isInFreezeWindow(
      [
        {
          days: ["friday"],
          afterHour: 15,
          timezone: "UTC",
          message: "No Friday deploys!",
        },
      ],
      friday3pm,
    );
    expect(result.frozen).toBe(true);
    expect(result.message).toBe("No Friday deploys!");
  });

  it("matches when days array is empty (any day)", () => {
    const wednesday = new Date("2026-04-08T20:00:00Z");
    const result = isInFreezeWindow(
      [{ days: [], afterHour: 18, timezone: "UTC" }],
      wednesday,
    );
    expect(result.frozen).toBe(true);
  });

  it("supports beforeHour constraint", () => {
    const earlyMorning = new Date("2026-04-08T05:00:00Z");
    const result = isInFreezeWindow(
      [{ days: [], beforeHour: 8, timezone: "UTC" }],
      earlyMorning,
    );
    expect(result.frozen).toBe(true);

    const afternoon = new Date("2026-04-08T14:00:00Z");
    const result2 = isInFreezeWindow(
      [{ days: [], beforeHour: 8, timezone: "UTC" }],
      afternoon,
    );
    expect(result2.frozen).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Dependency change detection in risk score
// ---------------------------------------------------------------------------

describe("dependency change detection via computeRiskScore", () => {
  it("flags package.json changes in risk factors", () => {
    const files = [
      { filename: "package.json", additions: 5, deletions: 2, changes: 7 },
      { filename: "package-lock.json", additions: 200, deletions: 100, changes: 300 },
      { filename: "src/index.ts", additions: 10, deletions: 5, changes: 15 },
    ];
    const { factors } = computeRiskScore(files);
    expect(factors.some((f) => f.type === "file_count")).toBe(true);
    expect(factors.some((f) => f.type === "code_churn")).toBe(true);
  });
});
