import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { evaluateGate } from "../gate.js";
import type { DeployGuardConfig } from "../types.js";

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
    sha: "abc1234567890",
    payload: {},
  },
  getOctokit: (_token: string) => ({
    rest: {
      pulls: {
        listFiles: vi.fn().mockResolvedValue({
          data: [
            { filename: "src/app.ts", additions: 40, deletions: 10, changes: 50 },
            { filename: "src/utils.ts", additions: 20, deletions: 5, changes: 25 },
            {
              filename: "src/__tests__/app.test.ts",
              additions: 30,
              deletions: 0,
              changes: 30,
            },
          ],
        }),
        get: vi.fn().mockResolvedValue({
          data: {
            user: { login: "test-author" },
          },
        }),
      },
      repos: {
        listCommits: vi.fn().mockResolvedValue({
          data: Array.from({ length: 12 }, (_, i) => ({
            sha: `commit-${i}`,
            commit: { message: `commit ${i}` },
          })),
        }),
      },
    },
  }),
}));

function makeConfig(overrides: Partial<DeployGuardConfig> = {}): DeployGuardConfig {
  return {
    apiKey: "test-key",
    apiUrl: "https://api.example.com/deploy/evaluate",
    riskThreshold: 70,
    failMode: "open",
    selfHeal: false,
    addRiskLabels: true,
    reviewersOnRisk: [],
    webhookEvents: ["warn", "block"],
    healthCheckUrls: [],
    ...overrides,
  };
}

describe("evaluateGate (integration)", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns a complete GateEvaluation for a PR with no health URL", async () => {
    const config = makeConfig({ githubToken: "ghp_test" });
    const result = await evaluateGate(config, "abc1234567890", 42);

    expect(result.id).toMatch(/^dg-abc1234-/);
    expect(result.repoId).toBe("test-owner/test-repo");
    expect(result.commitSha).toBe("abc1234567890");
    expect(result.prNumber).toBe(42);
    expect(result.healthScore).toBe(100);
    expect(result.riskScore).toBeGreaterThanOrEqual(0);
    expect(result.riskScore).toBeLessThanOrEqual(100);
    expect(["allow", "warn", "block"]).toContain(result.gateDecision);
    expect(result.healthChecks).toHaveLength(0);
    expect(result.riskFactors.length).toBeGreaterThan(0);
    expect(result.evaluationMs).toBeGreaterThanOrEqual(0);
    expect(result.files).toEqual([
      "src/app.ts",
      "src/utils.ts",
      "src/__tests__/app.test.ts",
    ]);
  });

  it("includes author_history factor when token and PR are provided", async () => {
    const config = makeConfig({ githubToken: "ghp_test" });
    const result = await evaluateGate(config, "abc1234567890", 42);
    const authorFactor = result.riskFactors.find((f) => f.type === "author_history");
    expect(authorFactor).toBeDefined();
    expect(authorFactor!.score).toBeGreaterThanOrEqual(0);
  });

  it("respects custom warn threshold", async () => {
    const config = makeConfig({
      githubToken: "ghp_test",
      riskThreshold: 99,
      warnThreshold: 10,
    });
    const result = await evaluateGate(config, "abc1234567890", 42);
    expect(result.gateDecision).toBe("warn");
  });

  it("performs health check when URL is provided", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const config = makeConfig({
      githubToken: "ghp_test",
      healthCheckUrls: ["https://api.example.com/health"],
    });
    const result = await evaluateGate(config, "abc1234567890", 42);

    expect(result.healthChecks).toHaveLength(1);
    expect(result.healthChecks[0].status).toBe("allow");
    expect(result.healthScore).toBe(100);
  });

  it("degrades health score for a 5xx health endpoint", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response("server error", { status: 500 }));
    const config = makeConfig({
      githubToken: "ghp_test",
      healthCheckUrls: ["https://api.example.com/health"],
    });
    const result = await evaluateGate(config, "abc1234567890", 42);

    expect(result.healthScore).toBe(0);
    expect(result.healthChecks[0].status).toBe("block");
  });

  it("returns zero risk when no PR number is provided", async () => {
    const config = makeConfig({ githubToken: "ghp_test" });
    const result = await evaluateGate(config, "abc1234567890");

    expect(result.riskScore).toBe(0);
    expect(result.riskFactors).toHaveLength(0);
    expect(result.prNumber).toBeUndefined();
  });

  it("returns zero risk when no token is provided (cannot fetch files)", async () => {
    const config = makeConfig();
    const result = await evaluateGate(config, "abc1234567890", 42);

    expect(result.riskScore).toBe(0);
    expect(result.riskFactors).toHaveLength(0);
  });

  it("blocks when risk exceeds threshold", async () => {
    const config = makeConfig({ githubToken: "ghp_test", riskThreshold: 5 });
    const result = await evaluateGate(config, "abc1234567890", 42);

    expect(result.gateDecision).toBe("block");
  });

  it("allows when risk is well below threshold", async () => {
    const config = makeConfig({ githubToken: "ghp_test", riskThreshold: 99 });
    const result = await evaluateGate(config, "abc1234567890", 42);

    expect(result.gateDecision).toBe("allow");
  });

  it("preserves fail-open on health check network failure", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const config = makeConfig({
      githubToken: "ghp_test",
      healthCheckUrls: ["https://dead-host.example.com/health"],
      riskThreshold: 99,
    });
    const result = await evaluateGate(config, "abc1234567890", 42);

    expect(result.healthScore).toBe(50);
    expect(result.healthChecks[0].status).toBe("warn");
    expect(result.gateDecision).not.toBe("block");
  });

  it("enriches evaluation when gate API returns valid data", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "api-enriched-id",
          reportUrl: "https://example.com/reports/123",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const config = makeConfig({ githubToken: "ghp_test" });
    const result = await evaluateGate(config, "abc1234567890", 42);

    expect(result.id).toBe("api-enriched-id");
    expect(result.reportUrl).toBe("https://example.com/reports/123");
  });

  it("falls back to local evaluation when gate API returns non-200", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response("server error", { status: 500 }));
    const config = makeConfig({ githubToken: "ghp_test" });
    const result = await evaluateGate(config, "abc1234567890", 42);

    expect(result.id).toMatch(/^dg-abc1234-/);
    expect(result.reportUrl).toBeUndefined();
  });

  it("falls back to local evaluation when gate API returns invalid schema", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ riskScore: "not-a-number" }), {
        status: 200,
      }),
    );
    const config = makeConfig({ githubToken: "ghp_test" });
    const result = await evaluateGate(config, "abc1234567890", 42);

    expect(result.id).toMatch(/^dg-abc1234-/);
  });

  it("falls back to local evaluation when gate API is unreachable", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const config = makeConfig({ githubToken: "ghp_test" });
    const result = await evaluateGate(config, "abc1234567890", 42);

    expect(result.id).toMatch(/^dg-abc1234-/);
  });

  it("performs multiple health checks when multiple URLs are provided", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response("ok", { status: 200 }))
      .mockResolvedValueOnce(new Response("error", { status: 503 }));
    const config = makeConfig({
      githubToken: "ghp_test",
      healthCheckUrls: [
        "https://api.example.com/health",
        "https://api2.example.com/health",
      ],
    });
    const result = await evaluateGate(config, "abc1234567890", 42);

    expect(result.healthChecks).toHaveLength(2);
    expect(result.healthChecks[0].status).toBe("allow");
    expect(result.healthChecks[1].status).toBe("block");
    expect(result.healthScore).toBe(50);
  });

  it("returns healthy when no health checks are configured", async () => {
    const config = makeConfig({ githubToken: "ghp_test", healthCheckUrls: [] });
    const result = await evaluateGate(config, "abc1234567890", 42);

    expect(result.healthChecks).toHaveLength(0);
    expect(result.healthScore).toBe(100);
  });
});
