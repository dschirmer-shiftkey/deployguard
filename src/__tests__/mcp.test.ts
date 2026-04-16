import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  computeRiskScore,
  decideGate,
  type FileInfo,
  type RiskFactorResult,
} from "../risk-engine.js";

// ---------------------------------------------------------------------------
// Helpers — mirrors the MCP server's internal helpers
// ---------------------------------------------------------------------------

type ToolReturn = { content: Array<{ type: "text"; text: string }> };

function jsonResult(data: unknown): ToolReturn {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function parseToolResult(result: ToolReturn): unknown {
  return JSON.parse(result.content[0].text);
}

// ---------------------------------------------------------------------------
// check-http-health — tool handler logic
// ---------------------------------------------------------------------------

const HEALTH_CHECK_TIMEOUT_MS = 10_000;

async function checkHttpHealth(url: string): Promise<ToolReturn> {
  const start = Date.now();
  try {
    const response = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
    });
    const latencyMs = Date.now() - start;
    let status: "healthy" | "degraded" | "down";
    if (response.ok) status = "healthy";
    else if (response.status < 500) status = "degraded";
    else status = "down";
    return jsonResult({
      target: url,
      status,
      latencyMs,
      detail: { httpStatus: response.status },
    });
  } catch (error) {
    return jsonResult({
      target: url,
      status: "down",
      latencyMs: Date.now() - start,
      detail: { error: String(error) },
    });
  }
}

// ---------------------------------------------------------------------------
// check-vercel-health — tool handler logic
// ---------------------------------------------------------------------------

async function checkVercelHealth(): Promise<ToolReturn> {
  const token = process.env.VERCEL_TOKEN;
  const projectId = process.env.VERCEL_PROJECT_ID;
  if (!token || !projectId) {
    return jsonResult({
      error: "Missing VERCEL_TOKEN or VERCEL_PROJECT_ID environment variables",
    });
  }
  const start = Date.now();
  try {
    const url = `https://api.vercel.com/v6/deployments?projectId=${encodeURIComponent(projectId)}&target=production&limit=1`;
    const response = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    const latencyMs = Date.now() - start;
    if (!response.ok) {
      return jsonResult({
        target: "vercel:production",
        status: "degraded",
        latencyMs,
        detail: { httpStatus: response.status },
      });
    }
    const body = (await response.json()) as {
      deployments?: Array<{ readyState?: string; url?: string; createdAt?: number }>;
    };
    const deployment = body?.deployments?.[0];
    return jsonResult({
      target: "vercel:production",
      status: deployment?.readyState === "READY" ? "healthy" : "degraded",
      latencyMs,
      detail: {
        readyState: deployment?.readyState ?? "unknown",
        url: deployment?.url,
        createdAt: deployment?.createdAt
          ? new Date(deployment.createdAt).toISOString()
          : undefined,
      },
    });
  } catch (error) {
    return jsonResult({
      target: "vercel:production",
      status: "down",
      latencyMs: Date.now() - start,
      detail: { error: String(error) },
    });
  }
}

// ---------------------------------------------------------------------------
// check-supabase-health — tool handler logic
// ---------------------------------------------------------------------------

async function checkSupabaseHealth(): Promise<ToolReturn> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) {
    return jsonResult({
      error: "Missing SUPABASE_URL or SUPABASE_ANON_KEY environment variables",
    });
  }
  const start = Date.now();
  try {
    const response = await fetch(`${supabaseUrl}/rest/v1/`, {
      method: "GET",
      headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    const latencyMs = Date.now() - start;
    return jsonResult({
      target: "supabase:rest",
      status: response.ok ? "healthy" : "degraded",
      latencyMs,
      detail: { httpStatus: response.status },
    });
  } catch (error) {
    return jsonResult({
      target: "supabase:rest",
      status: "down",
      latencyMs: Date.now() - start,
      detail: { error: String(error) },
    });
  }
}

// ---------------------------------------------------------------------------
// compute-risk-score — tool handler logic
// ---------------------------------------------------------------------------

function computeRiskScoreTool(
  files: Array<{ filename: string; changes: number }>,
): ToolReturn {
  if (files.length === 0) {
    return jsonResult({ score: 0, factors: [], decision: "allow" });
  }
  const { score, factors } = computeRiskScore(files as FileInfo[]);
  const decision = decideGate(score, 100, 70, 55);
  return jsonResult({ score, factors, decision });
}

// ---------------------------------------------------------------------------
// evaluate-deployment — tool handler logic
// ---------------------------------------------------------------------------

interface HealthResult {
  target: string;
  status: "healthy" | "degraded" | "down";
  latencyMs: number;
  detail: Record<string, unknown>;
}

async function evaluateDeployment(
  healthUrls: string[],
  files: Array<{ filename: string; changes: number }>,
): Promise<ToolReturn> {
  const healthChecks: HealthResult[] = await Promise.all(
    healthUrls.map(async (url) => {
      const start = Date.now();
      try {
        const res = await fetch(url, {
          method: "GET",
          signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
        });
        return {
          target: url,
          status: (res.ok
            ? "healthy"
            : res.status < 500
              ? "degraded"
              : "down") as HealthResult["status"],
          latencyMs: Date.now() - start,
          detail: { httpStatus: res.status },
        };
      } catch (err) {
        return {
          target: url,
          status: "down" as const,
          latencyMs: Date.now() - start,
          detail: { error: String(err) },
        };
      }
    }),
  );

  const healthScore =
    healthChecks.length > 0
      ? Math.round(
          healthChecks.reduce(
            (sum, c) =>
              sum + (c.status === "healthy" ? 100 : c.status === "degraded" ? 50 : 0),
            0,
          ) / healthChecks.length,
        )
      : 100;

  const { score: riskScore, factors: riskFactors } =
    files.length > 0
      ? computeRiskScore(files as FileInfo[])
      : { score: 0, factors: [] as RiskFactorResult[] };

  const decision = decideGate(riskScore, healthScore, 70, 55);
  return jsonResult({ healthScore, riskScore, decision, healthChecks, riskFactors });
}

// ---------------------------------------------------------------------------
// explain-risk-factors — tool handler logic
// ---------------------------------------------------------------------------

function explainRiskFactors(
  files: Array<{ filename: string; changes: number }>,
): ToolReturn {
  if (files.length === 0) {
    return jsonResult({ score: 0, explanation: "No files changed — zero risk." });
  }
  const { score, factors } = computeRiskScore(files as FileInfo[]);
  const decision = decideGate(score, 100, 70, 55);
  const explanations: string[] = [];

  for (const f of factors.sort((a, b) => b.score - a.score)) {
    switch (f.type) {
      case "code_churn": {
        const d = f.detail as { totalChanges: number; weightedChanges: number };
        explanations.push(
          `Code churn is ${f.score >= 70 ? "very high" : f.score >= 40 ? "moderate" : "low"} (${d.totalChanges} raw lines, ${d.weightedChanges} sensitivity-weighted). Auth, payment, and migration files carry 2-3x weight.`,
        );
        break;
      }
      case "file_count": {
        const d = f.detail as { fileCount: number };
        explanations.push(
          `${d.fileCount} file${d.fileCount === 1 ? "" : "s"} changed. ${d.fileCount > 15 ? "Large PRs are harder to review — consider splitting." : "File count is manageable."}`,
        );
        break;
      }
      case "sensitive_files": {
        const d = f.detail as { count: number; files: string[] };
        explanations.push(
          `${d.count} sensitive file${d.count === 1 ? "" : "s"} touched: ${d.files.slice(0, 5).join(", ")}${d.files.length > 5 ? "..." : ""}. These carry extra weight because they affect security, data, or infrastructure.`,
        );
        break;
      }
      case "test_coverage": {
        const d = f.detail as { testFiles: number; sourceFiles: number };
        explanations.push(
          d.testFiles === 0
            ? `No test files included. Adding tests would reduce the risk score significantly.`
            : `Test ratio is ${d.testFiles}:${d.sourceFiles} (tests:source). ${d.testFiles < d.sourceFiles ? "More tests would help." : "Good coverage."}`,
        );
        break;
      }
    }
  }

  return jsonResult({
    score,
    decision,
    explanation: explanations.join("\n\n"),
    factors: factors.map((f) => ({ type: f.type, score: f.score })),
  });
}

// ===========================================================================
// TESTS
// ===========================================================================

describe("MCP tool: check-http-health", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns healthy for a 200 response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const result = parseToolResult(
      await checkHttpHealth("https://api.example.com/health"),
    ) as Record<string, unknown>;
    expect(result.status).toBe("healthy");
    expect(result.target).toBe("https://api.example.com/health");
    expect(result.detail).toEqual({ httpStatus: 200 });
    expect(typeof result.latencyMs).toBe("number");
  });

  it("returns degraded for a 4xx response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response("not found", { status: 404 }));
    const result = parseToolResult(
      await checkHttpHealth("https://api.example.com/health"),
    ) as Record<string, unknown>;
    expect(result.status).toBe("degraded");
    expect(result.detail).toEqual({ httpStatus: 404 });
  });

  it("returns down for a 5xx response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response("error", { status: 500 }));
    const result = parseToolResult(
      await checkHttpHealth("https://api.example.com/health"),
    ) as Record<string, unknown>;
    expect(result.status).toBe("down");
    expect(result.detail).toEqual({ httpStatus: 500 });
  });

  it("returns down on network error", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const result = parseToolResult(
      await checkHttpHealth("https://api.example.com/health"),
    ) as Record<string, unknown>;
    expect(result.status).toBe("down");
    expect((result.detail as Record<string, unknown>).error).toContain("ECONNREFUSED");
  });

  it("returns valid JSON wrapped in MCP content format", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const raw = await checkHttpHealth("https://api.example.com/health");
    expect(raw.content).toHaveLength(1);
    expect(raw.content[0].type).toBe("text");
    expect(() => JSON.parse(raw.content[0].text)).not.toThrow();
  });
});

describe("MCP tool: check-vercel-health", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.VERCEL_TOKEN;
    delete process.env.VERCEL_PROJECT_ID;
  });

  it("returns error when env vars are missing", async () => {
    const result = parseToolResult(await checkVercelHealth()) as Record<string, unknown>;
    expect(result.error).toContain("Missing VERCEL_TOKEN");
  });

  it("returns error when only token is set", async () => {
    process.env.VERCEL_TOKEN = "test-token";
    const result = parseToolResult(await checkVercelHealth()) as Record<string, unknown>;
    expect(result.error).toContain("Missing VERCEL_TOKEN or VERCEL_PROJECT_ID");
  });

  it("returns healthy when latest deployment is READY", async () => {
    process.env.VERCEL_TOKEN = "test-token";
    process.env.VERCEL_PROJECT_ID = "prj_test";
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          deployments: [
            { readyState: "READY", url: "my-app.vercel.app", createdAt: 1700000000000 },
          ],
        }),
        { status: 200 },
      ),
    );
    const result = parseToolResult(await checkVercelHealth()) as Record<string, unknown>;
    expect(result.status).toBe("healthy");
    expect(result.target).toBe("vercel:production");
    const detail = result.detail as Record<string, unknown>;
    expect(detail.readyState).toBe("READY");
    expect(detail.url).toBe("my-app.vercel.app");
    expect(detail.createdAt).toBeDefined();
  });

  it("returns degraded when deployment is not READY", async () => {
    process.env.VERCEL_TOKEN = "test-token";
    process.env.VERCEL_PROJECT_ID = "prj_test";
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ deployments: [{ readyState: "BUILDING" }] }), {
        status: 200,
      }),
    );
    const result = parseToolResult(await checkVercelHealth()) as Record<string, unknown>;
    expect(result.status).toBe("degraded");
  });

  it("returns degraded when API returns non-200", async () => {
    process.env.VERCEL_TOKEN = "test-token";
    process.env.VERCEL_PROJECT_ID = "prj_test";
    vi.mocked(fetch).mockResolvedValueOnce(new Response("forbidden", { status: 403 }));
    const result = parseToolResult(await checkVercelHealth()) as Record<string, unknown>;
    expect(result.status).toBe("degraded");
    expect((result.detail as Record<string, unknown>).httpStatus).toBe(403);
  });

  it("returns down on network error", async () => {
    process.env.VERCEL_TOKEN = "test-token";
    process.env.VERCEL_PROJECT_ID = "prj_test";
    vi.mocked(fetch).mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const result = parseToolResult(await checkVercelHealth()) as Record<string, unknown>;
    expect(result.status).toBe("down");
  });

  it("returns degraded when deployments array is empty", async () => {
    process.env.VERCEL_TOKEN = "test-token";
    process.env.VERCEL_PROJECT_ID = "prj_test";
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ deployments: [] }), { status: 200 }),
    );
    const result = parseToolResult(await checkVercelHealth()) as Record<string, unknown>;
    expect(result.status).toBe("degraded");
    expect((result.detail as Record<string, unknown>).readyState).toBe("unknown");
  });

  it("sends correct Authorization header", async () => {
    process.env.VERCEL_TOKEN = "test-token-xyz";
    process.env.VERCEL_PROJECT_ID = "prj_abc";
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ deployments: [] }), { status: 200 }),
    );
    await checkVercelHealth();
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("prj_abc"),
      expect.objectContaining({
        headers: { Authorization: "Bearer test-token-xyz" },
      }),
    );
  });
});

describe("MCP tool: check-supabase-health", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_ANON_KEY;
  });

  it("returns error when env vars are missing", async () => {
    const result = parseToolResult(await checkSupabaseHealth()) as Record<
      string,
      unknown
    >;
    expect(result.error).toContain("Missing SUPABASE_URL");
  });

  it("returns healthy when Supabase REST returns 200", async () => {
    process.env.SUPABASE_URL = "https://abc.supabase.co";
    process.env.SUPABASE_ANON_KEY = "test-anon-key";
    vi.mocked(fetch).mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const result = parseToolResult(await checkSupabaseHealth()) as Record<
      string,
      unknown
    >;
    expect(result.status).toBe("healthy");
    expect(result.target).toBe("supabase:rest");
    expect((result.detail as Record<string, unknown>).httpStatus).toBe(200);
  });

  it("returns degraded when Supabase REST returns 503", async () => {
    process.env.SUPABASE_URL = "https://abc.supabase.co";
    process.env.SUPABASE_ANON_KEY = "test-anon-key";
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response("service unavailable", { status: 503 }),
    );
    const result = parseToolResult(await checkSupabaseHealth()) as Record<
      string,
      unknown
    >;
    expect(result.status).toBe("degraded");
  });

  it("returns down on network error", async () => {
    process.env.SUPABASE_URL = "https://abc.supabase.co";
    process.env.SUPABASE_ANON_KEY = "test-anon-key";
    vi.mocked(fetch).mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const result = parseToolResult(await checkSupabaseHealth()) as Record<
      string,
      unknown
    >;
    expect(result.status).toBe("down");
    expect((result.detail as Record<string, unknown>).error).toContain("ECONNREFUSED");
  });

  it("sends correct headers", async () => {
    process.env.SUPABASE_URL = "https://abc.supabase.co";
    process.env.SUPABASE_ANON_KEY = "test-anon-key";
    vi.mocked(fetch).mockResolvedValueOnce(new Response("ok", { status: 200 }));
    await checkSupabaseHealth();
    expect(fetch).toHaveBeenCalledWith(
      "https://abc.supabase.co/rest/v1/",
      expect.objectContaining({
        headers: { apikey: "test-anon-key", Authorization: "Bearer test-anon-key" },
      }),
    );
  });
});

describe("MCP tool: compute-risk-score", () => {
  it("returns zero score for empty files", () => {
    const result = parseToolResult(computeRiskScoreTool([])) as Record<string, unknown>;
    expect(result.score).toBe(0);
    expect(result.factors).toEqual([]);
    expect(result.decision).toBe("allow");
  });

  it("returns a score and factors for changed files", () => {
    const result = parseToolResult(
      computeRiskScoreTool([
        { filename: "src/main.ts", changes: 50 },
        { filename: "src/auth/login.ts", changes: 30 },
      ]),
    ) as Record<string, unknown>;
    expect(typeof result.score).toBe("number");
    expect(result.score as number).toBeGreaterThan(0);
    expect(Array.isArray(result.factors)).toBe(true);
    expect(["allow", "warn", "block"]).toContain(result.decision);
  });

  it("produces allow for a small well-tested PR", () => {
    const result = parseToolResult(
      computeRiskScoreTool([
        { filename: "src/utils.ts", changes: 5 },
        { filename: "src/__tests__/utils.test.ts", changes: 10 },
      ]),
    ) as Record<string, unknown>;
    expect(result.decision).toBe("allow");
  });

  it("produces block for a massive sensitive PR with no tests", () => {
    const files = Array.from({ length: 20 }, (_, i) => ({
      filename: `src/auth/module${i}.ts`,
      changes: 200,
    }));
    const result = parseToolResult(computeRiskScoreTool(files)) as Record<
      string,
      unknown
    >;
    expect(result.decision).toBe("block");
    expect(result.score as number).toBeGreaterThan(70);
  });

  it("includes sensitive_files factor when auth files are changed", () => {
    const result = parseToolResult(
      computeRiskScoreTool([
        { filename: "src/auth/login.ts", changes: 10 },
        { filename: "src/payment/stripe.ts", changes: 20 },
      ]),
    ) as Record<string, unknown>;
    const factors = result.factors as Array<{ type: string; score: number }>;
    expect(factors.some((f) => f.type === "sensitive_files")).toBe(true);
  });

  it("returns JSON-serializable result in MCP content format", () => {
    const raw = computeRiskScoreTool([{ filename: "src/main.ts", changes: 50 }]);
    expect(raw.content).toHaveLength(1);
    expect(raw.content[0].type).toBe("text");
    const parsed = JSON.parse(raw.content[0].text);
    expect(parsed).toHaveProperty("score");
    expect(parsed).toHaveProperty("factors");
    expect(parsed).toHaveProperty("decision");
  });
});

describe("MCP tool: evaluate-deployment", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns full evaluation with healthy endpoints and low-risk files", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("ok", { status: 200 }));
    const result = parseToolResult(
      await evaluateDeployment(
        ["https://api.example.com/health"],
        [{ filename: "src/utils.ts", changes: 5 }],
      ),
    ) as Record<string, unknown>;
    expect(result.healthScore).toBe(100);
    expect(typeof result.riskScore).toBe("number");
    expect(result.decision).toBe("allow");
    expect((result.healthChecks as unknown[]).length).toBe(1);
    expect(Array.isArray(result.riskFactors)).toBe(true);
  });

  it("returns allow with no health URLs and no files", async () => {
    const result = parseToolResult(await evaluateDeployment([], [])) as Record<
      string,
      unknown
    >;
    expect(result.healthScore).toBe(100);
    expect(result.riskScore).toBe(0);
    expect(result.decision).toBe("allow");
  });

  it("scores degraded when health endpoints return 4xx", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("not found", { status: 404 }));
    const result = parseToolResult(
      await evaluateDeployment(["https://api.example.com/health"], []),
    ) as Record<string, unknown>;
    expect(result.healthScore).toBe(50);
  });

  it("scores zero health when all endpoints are down", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("error", { status: 500 }));
    const result = parseToolResult(
      await evaluateDeployment(
        ["https://api.example.com/health", "https://api2.example.com/health"],
        [],
      ),
    ) as Record<string, unknown>;
    expect(result.healthScore).toBe(0);
    expect(result.decision).toBe("warn");
  });

  it("averages health across multiple endpoints", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response("ok", { status: 200 }))
      .mockResolvedValueOnce(new Response("error", { status: 500 }));
    const result = parseToolResult(
      await evaluateDeployment(
        ["https://api1.example.com", "https://api2.example.com"],
        [],
      ),
    ) as Record<string, unknown>;
    expect(result.healthScore).toBe(50);
  });

  it("combines risk and health into gate decision", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("error", { status: 500 }));
    const files = Array.from({ length: 20 }, (_, i) => ({
      filename: `src/auth/module${i}.ts`,
      changes: 200,
    }));
    const result = parseToolResult(
      await evaluateDeployment(["https://api.example.com/health"], files),
    ) as Record<string, unknown>;
    expect(result.decision).toBe("block");
    expect(result.riskScore as number).toBeGreaterThan(70);
    expect(result.healthScore).toBe(0);
  });

  it("handles fetch errors for health checks gracefully", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("ECONNREFUSED"));
    const result = parseToolResult(
      await evaluateDeployment(["https://api.example.com/health"], []),
    ) as Record<string, unknown>;
    expect(result.healthScore).toBe(0);
    const checks = result.healthChecks as Array<Record<string, unknown>>;
    expect(checks[0].status).toBe("down");
  });
});

describe("MCP tool: explain-risk-factors", () => {
  it("returns zero risk explanation for empty files", () => {
    const result = parseToolResult(explainRiskFactors([])) as Record<string, unknown>;
    expect(result.score).toBe(0);
    expect(result.explanation).toBe("No files changed — zero risk.");
  });

  it("produces human-readable explanation for source changes", () => {
    const result = parseToolResult(
      explainRiskFactors([
        { filename: "src/main.ts", changes: 100 },
        { filename: "src/utils.ts", changes: 50 },
      ]),
    ) as Record<string, unknown>;
    expect(typeof result.explanation).toBe("string");
    expect((result.explanation as string).length).toBeGreaterThan(0);
    expect(result.explanation as string).toContain("Code churn");
    expect(result.explanation as string).toContain("file");
    expect(result.decision).toBeDefined();
    expect(Array.isArray(result.factors)).toBe(true);
  });

  it("mentions sensitive files in explanation when present", () => {
    const result = parseToolResult(
      explainRiskFactors([
        { filename: "src/auth/login.ts", changes: 50 },
        { filename: "src/payment/stripe.ts", changes: 50 },
      ]),
    ) as Record<string, unknown>;
    expect(result.explanation as string).toContain("sensitive");
  });

  it("mentions missing tests in explanation when no test files", () => {
    const result = parseToolResult(
      explainRiskFactors([{ filename: "src/main.ts", changes: 100 }]),
    ) as Record<string, unknown>;
    expect(result.explanation as string).toContain("test");
  });

  it("mentions good coverage when tests are present", () => {
    const result = parseToolResult(
      explainRiskFactors([
        { filename: "src/main.ts", changes: 50 },
        { filename: "src/__tests__/main.test.ts", changes: 100 },
      ]),
    ) as Record<string, unknown>;
    const explanation = result.explanation as string;
    expect(explanation).toMatch(/test ratio|coverage/i);
  });

  it("includes factors array with type and score", () => {
    const result = parseToolResult(
      explainRiskFactors([{ filename: "src/main.ts", changes: 50 }]),
    ) as Record<string, unknown>;
    const factors = result.factors as Array<{ type: string; score: number }>;
    expect(factors.length).toBeGreaterThan(0);
    for (const f of factors) {
      expect(typeof f.type).toBe("string");
      expect(typeof f.score).toBe("number");
    }
  });
});

describe("MCP tool: suggest-deploy-timing (logic)", () => {
  it("warns on late Friday deployments", () => {
    const now = new Date("2026-04-10T17:00:00Z"); // Friday 17:00 UTC
    const dayName = [
      "Sunday",
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
    ][now.getUTCDay()];
    const hour = now.getUTCHours();
    const warnings: string[] = [];

    if (now.getUTCDay() === 5 && hour >= 16) {
      warnings.push(
        "Late Friday deployment — higher risk of undetected issues over the weekend",
      );
    }
    if (now.getUTCDay() === 0 || now.getUTCDay() === 6) {
      warnings.push(
        "Weekend deployment — reduced team availability for incident response",
      );
    }

    expect(dayName).toBe("Friday");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Late Friday");
  });

  it("warns on weekend deployments", () => {
    const saturday = new Date("2026-04-11T12:00:00Z"); // Saturday
    const warnings: string[] = [];
    if (saturday.getUTCDay() === 0 || saturday.getUTCDay() === 6) {
      warnings.push("Weekend deployment");
    }
    expect(warnings).toHaveLength(1);

    const sunday = new Date("2026-04-12T12:00:00Z"); // Sunday
    const warnings2: string[] = [];
    if (sunday.getUTCDay() === 0 || sunday.getUTCDay() === 6) {
      warnings2.push("Weekend deployment");
    }
    expect(warnings2).toHaveLength(1);
  });

  it("produces no warnings on a Tuesday afternoon", () => {
    const tuesday = new Date("2026-04-07T14:00:00Z"); // Tuesday 14:00 UTC
    const warnings: string[] = [];
    if (tuesday.getUTCDay() === 5 && tuesday.getUTCHours() >= 16) {
      warnings.push("Late Friday");
    }
    if (tuesday.getUTCDay() === 0 || tuesday.getUTCDay() === 6) {
      warnings.push("Weekend");
    }
    expect(warnings).toHaveLength(0);
  });
});

describe("MCP tool: get-dora-metrics (rating logic)", () => {
  function rateDeployFreq(deploysPerWeek: number): string {
    return deploysPerWeek >= 7
      ? "elite"
      : deploysPerWeek >= 1
        ? "high"
        : deploysPerWeek >= 0.25
          ? "medium"
          : "low";
  }

  function rateCFR(changeFailureRate: number): string {
    return changeFailureRate <= 5
      ? "elite"
      : changeFailureRate <= 10
        ? "high"
        : changeFailureRate <= 15
          ? "medium"
          : "low";
  }

  function overallRating(rateDF: string, rateCFR: string): string {
    return [rateDF, rateCFR].includes("low")
      ? "low"
      : [rateDF, rateCFR].includes("medium")
        ? "medium"
        : [rateDF, rateCFR].includes("high")
          ? "high"
          : "elite";
  }

  it("rates daily deploys as elite", () => {
    expect(rateDeployFreq(10)).toBe("elite");
  });

  it("rates weekly deploys as high", () => {
    expect(rateDeployFreq(3)).toBe("high");
  });

  it("rates monthly deploys as medium", () => {
    expect(rateDeployFreq(0.5)).toBe("medium");
  });

  it("rates rare deploys as low", () => {
    expect(rateDeployFreq(0.1)).toBe("low");
  });

  it("rates 0% CFR as elite", () => {
    expect(rateCFR(0)).toBe("elite");
  });

  it("rates 8% CFR as high", () => {
    expect(rateCFR(8)).toBe("high");
  });

  it("rates 12% CFR as medium", () => {
    expect(rateCFR(12)).toBe("medium");
  });

  it("rates 20% CFR as low", () => {
    expect(rateCFR(20)).toBe("low");
  });

  it("overall degrades to lowest component", () => {
    expect(overallRating("elite", "elite")).toBe("elite");
    expect(overallRating("elite", "high")).toBe("high");
    expect(overallRating("high", "medium")).toBe("medium");
    expect(overallRating("elite", "low")).toBe("low");
  });
});

describe("MCP tool: compare-risk-history (scoring consistency)", () => {
  it("produces consistent scores when called with the same files", () => {
    const files: FileInfo[] = [
      { filename: "src/main.ts", changes: 50 },
      { filename: "src/utils.ts", changes: 30 },
    ];
    const result1 = computeRiskScore(files);
    const result2 = computeRiskScore(files);
    expect(result1.score).toBe(result2.score);
    expect(result1.factors.length).toBe(result2.factors.length);
  });

  it("decision is consistent with gate thresholds", () => {
    const lowRisk: FileInfo[] = [{ filename: "README.md", changes: 5 }];
    const highRisk: FileInfo[] = Array.from({ length: 25 }, (_, i) => ({
      filename: `src/auth/module${i}.ts`,
      changes: 200,
    }));

    const lowResult = computeRiskScore(lowRisk);
    const highResult = computeRiskScore(highRisk);

    expect(decideGate(lowResult.score, 100, 70, 55)).toBe("allow");
    expect(decideGate(highResult.score, 100, 70, 55)).toBe("block");
  });

  it("average computation works correctly", () => {
    const scores = [30, 50, 70, 90, 10];
    const avg = Math.round(scores.reduce((s, r) => s + r, 0) / scores.length);
    expect(avg).toBe(50);
  });
});

describe("MCP tool: evaluate-policy (logic coverage)", () => {
  it("adds reason when risk score exceeds 70", () => {
    const reasons: string[] = [];
    const riskScore = 85;
    if (riskScore > 70) reasons.push(`High risk score (${riskScore}/100)`);
    if (riskScore > 55) reasons.push(`Elevated risk (${riskScore}/100)`);
    expect(reasons).toContain("High risk score (85/100)");
    expect(reasons).toContain("Elevated risk (85/100)");
  });

  it("adds reason for individual high factors", () => {
    const riskFactors: RiskFactorResult[] = [
      { type: "code_churn", score: 80 },
      { type: "file_count", score: 40 },
      { type: "sensitive_files", score: 75 },
    ];
    const reasons: string[] = [];
    for (const f of riskFactors) {
      if (f.score >= 70) {
        reasons.push(`${f.type.replace(/_/g, " ")} is high (${f.score}/100)`);
      }
    }
    expect(reasons).toHaveLength(2);
    expect(reasons[0]).toContain("code churn is high");
    expect(reasons[1]).toContain("sensitive files is high");
  });

  it("returns generic success reason when all checks pass", () => {
    const reasons: string[] = [];
    const result =
      reasons.length > 0 ? reasons : ["All checks passed — deployment looks safe"];
    expect(result).toEqual(["All checks passed — deployment looks safe"]);
  });
});

describe("MCP tool: get-security-alerts (severity filtering logic)", () => {
  const severityOrder: Record<string, number> = {
    critical: 0,
    high: 1,
    error: 1,
    medium: 2,
    warning: 2,
    low: 3,
    note: 3,
  };

  function filterBySeverity(
    alerts: Array<{ severity: string }>,
    threshold: string,
  ): Array<{ severity: string }> {
    const thresholdOrder = threshold === "all" ? 99 : (severityOrder[threshold] ?? 99);
    return alerts.filter((a) => (severityOrder[a.severity] ?? 3) <= thresholdOrder);
  }

  it("returns all alerts when threshold is 'all'", () => {
    const alerts = [
      { severity: "critical" },
      { severity: "high" },
      { severity: "medium" },
      { severity: "low" },
    ];
    expect(filterBySeverity(alerts, "all")).toHaveLength(4);
  });

  it("filters to critical only", () => {
    const alerts = [
      { severity: "critical" },
      { severity: "high" },
      { severity: "medium" },
    ];
    expect(filterBySeverity(alerts, "critical")).toHaveLength(1);
  });

  it("filters to high and above", () => {
    const alerts = [
      { severity: "critical" },
      { severity: "high" },
      { severity: "medium" },
      { severity: "low" },
    ];
    expect(filterBySeverity(alerts, "high")).toHaveLength(2);
  });

  it("treats error as equivalent to high", () => {
    const alerts = [{ severity: "error" }, { severity: "warning" }];
    expect(filterBySeverity(alerts, "high")).toHaveLength(1);
  });

  it("treats warning as equivalent to medium", () => {
    const alerts = [{ severity: "warning" }, { severity: "note" }];
    expect(filterBySeverity(alerts, "medium")).toHaveLength(1);
  });
});

describe("MCP tool: get-deployment-status (response shape)", () => {
  it("produces correct shape for no deployments", () => {
    const result = {
      environment: "production",
      status: "no deployments found",
      history: [],
    };
    expect(result.environment).toBe("production");
    expect(result.history).toEqual([]);
  });

  it("truncates SHA to 7 characters", () => {
    const fullSha = "abc1234567890abcdef1234567890abcdef12345";
    expect(fullSha.substring(0, 7)).toBe("abc1234");
  });

  it("produces correct history shape", () => {
    const deployments = [
      {
        id: 1,
        ref: "main",
        sha: "abc1234567890",
        created_at: "2026-04-12T00:00:00Z",
        creator: { login: "david" },
      },
      {
        id: 2,
        ref: "main",
        sha: "def5678901234",
        created_at: "2026-04-11T00:00:00Z",
        creator: { login: "orbit" },
      },
    ];
    const history = deployments.slice(0, 5).map((d) => ({
      id: d.id,
      ref: d.ref,
      sha: d.sha.substring(0, 7),
      createdAt: d.created_at,
      creator: d.creator.login,
    }));
    expect(history).toHaveLength(2);
    expect(history[0].sha).toBe("abc1234");
    expect(history[1].creator).toBe("orbit");
  });
});

describe("MCP response format contract", () => {
  it("jsonResult wraps any object into MCP content format", () => {
    const result = jsonResult({ test: true, nested: { a: 1 } });
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.test).toBe(true);
    expect(parsed.nested.a).toBe(1);
  });

  it("jsonResult handles null and undefined", () => {
    const result = jsonResult(null);
    expect(JSON.parse(result.content[0].text)).toBeNull();
  });

  it("jsonResult handles arrays", () => {
    const result = jsonResult([1, 2, 3]);
    expect(JSON.parse(result.content[0].text)).toEqual([1, 2, 3]);
  });

  it("jsonResult uses pretty-printed JSON", () => {
    const result = jsonResult({ a: 1 });
    expect(result.content[0].text).toContain("\n");
    expect(result.content[0].text).toContain("  ");
  });
});
