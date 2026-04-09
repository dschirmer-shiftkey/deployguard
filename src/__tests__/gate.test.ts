import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { computeRiskScore, decideGate, checkHealth, formatGateReport } from "../gate.js";
import type { GateEvaluation } from "../types.js";

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
    expect(result.factors).toHaveLength(3);
  });

  it("produces a high score for a large PR with no tests", () => {
    const files = Array.from({ length: 25 }, (_, i) => ({
      filename: `src/module${i}.ts`,
      additions: 50,
      deletions: 20,
      changes: 70,
    }));
    const result = computeRiskScore(files);
    expect(result.score).toBeGreaterThanOrEqual(70);
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

  it("recognises various test file patterns", () => {
    const files = [
      { filename: "src/foo.test.ts", additions: 1, deletions: 0, changes: 1 },
      { filename: "src/bar.spec.tsx", additions: 1, deletions: 0, changes: 1 },
      {
        filename: "src/__tests__/baz.ts",
        additions: 1,
        deletions: 0,
        changes: 1,
      },
      { filename: "cypress/e2e/login.cy.ts", additions: 1, deletions: 0, changes: 1 },
    ];
    const result = computeRiskScore(files);
    const testCoverage = result.factors.find((f) => f.type === "test_coverage");
    expect(testCoverage).toBeDefined();
    expect(testCoverage!.score).toBe(0);
  });

  it("gives higher test_coverage risk when tests are absent", () => {
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
});

// ---------------------------------------------------------------------------
// decideGate
// ---------------------------------------------------------------------------

describe("decideGate", () => {
  it("allows when risk is well below threshold and health is good", () => {
    expect(decideGate(20, 100, 70)).toBe("allow");
  });

  it("warns when risk approaches threshold (above 70% of threshold)", () => {
    expect(decideGate(55, 100, 70)).toBe("warn");
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
        detail: { totalChanges: 150, description: "Total lines changed" },
      },
    ],
    evaluationMs: 42,
  };

  it("includes health and risk scores in the table", () => {
    const report = formatGateReport(baseEvaluation);
    expect(report).toContain("100/100");
    expect(report).toContain("30/100");
    expect(report).toContain("ALLOW");
  });

  it("lists risk factors when present", () => {
    const report = formatGateReport(baseEvaluation);
    expect(report).toContain("code_churn");
    expect(report).toContain("Total lines changed");
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

  it("includes report URL when provided", () => {
    const evaluation: GateEvaluation = {
      ...baseEvaluation,
      reportUrl: "https://deployguard.komatik.xyz/reports/abc",
    };
    const report = formatGateReport(evaluation);
    expect(report).toContain(
      "[View full report](https://deployguard.komatik.xyz/reports/abc)",
    );
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
      { risk: 55, health: 100, threshold: 70 },
      { risk: 80, health: 100, threshold: 70 },
      { risk: 10, health: 30, threshold: 70 },
    ];
    for (const { risk, health, threshold } of testCases) {
      const decision = decideGate(risk, health, threshold);
      expect(validDecisions.has(decision)).toBe(true);
    }
  });
});
