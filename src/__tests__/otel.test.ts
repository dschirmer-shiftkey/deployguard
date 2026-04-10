import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@actions/core", () => ({
  debug: vi.fn(),
}));

vi.mock("@actions/github", () => ({
  context: {
    repo: { owner: "test-org", repo: "test-repo" },
  },
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { exportOtelSpan } from "../otel.js";
import type { GateEvaluation } from "../types.js";

function makeEvaluation(overrides: Partial<GateEvaluation> = {}): GateEvaluation {
  return {
    id: "dg-abc1234-123",
    repoId: "test-org/test-repo",
    commitSha: "abc1234567890",
    prNumber: 42,
    healthScore: 100,
    riskScore: 30,
    gateDecision: "allow",
    healthChecks: [
      { target: "https://api.example.com/health", status: "allow", latencyMs: 150 },
    ],
    riskFactors: [
      { type: "code_churn", score: 25, detail: { totalChanges: 100 } },
      { type: "file_count", score: 35, detail: { fileCount: 5 } },
    ],
    files: ["src/main.ts", "src/gate.ts"],
    evaluationMs: 1200,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFetch.mockResolvedValue({ ok: true, text: async () => "" });
});

describe("exportOtelSpan", () => {
  it("sends a valid OTLP JSON payload to the endpoint", async () => {
    await exportOtelSpan(makeEvaluation(), "https://otel.example.com:4318", "");

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://otel.example.com:4318/v1/traces");
    expect(opts.method).toBe("POST");
    expect(opts.headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(opts.body);
    expect(body).toHaveProperty("resourceSpans");
    expect(body.resourceSpans).toHaveLength(1);

    const spans = body.resourceSpans[0].scopeSpans[0].spans;
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe("deployguard.evaluate");
  });

  it("includes risk score and decision as span attributes", async () => {
    await exportOtelSpan(makeEvaluation({ riskScore: 72, gateDecision: "block" }), "https://otel.example.com:4318", "");

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const attrs = body.resourceSpans[0].scopeSpans[0].spans[0].attributes;

    const riskAttr = attrs.find((a: { key: string }) => a.key === "deployguard.risk_score");
    expect(riskAttr).toBeDefined();
    expect(riskAttr.value.intValue).toBe("72");

    const decisionAttr = attrs.find((a: { key: string }) => a.key === "deployguard.decision");
    expect(decisionAttr).toBeDefined();
    expect(decisionAttr.value.stringValue).toBe("block");
  });

  it("includes risk factor scores as individual attributes", async () => {
    await exportOtelSpan(makeEvaluation(), "https://otel.example.com:4318", "");

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const attrs = body.resourceSpans[0].scopeSpans[0].spans[0].attributes;

    const churnAttr = attrs.find((a: { key: string }) => a.key === "deployguard.factor.code_churn");
    expect(churnAttr).toBeDefined();
    expect(churnAttr.value.intValue).toBe("25");
  });

  it("does not append /v1/traces if already present", async () => {
    await exportOtelSpan(makeEvaluation(), "https://otel.example.com:4318/v1/traces", "");

    expect(mockFetch.mock.calls[0][0]).toBe("https://otel.example.com:4318/v1/traces");
  });

  it("parses custom headers from comma-separated string", async () => {
    await exportOtelSpan(
      makeEvaluation(),
      "https://otel.example.com:4318",
      "Authorization=Bearer tok123,X-Custom=value",
    );

    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers["Authorization"]).toBe("Bearer tok123");
    expect(headers["X-Custom"]).toBe("value");
  });

  it("sets span status code 2 for blocked evaluations", async () => {
    await exportOtelSpan(makeEvaluation({ gateDecision: "block" }), "https://otel.example.com:4318", "");

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const span = body.resourceSpans[0].scopeSpans[0].spans[0];
    expect(span.status.code).toBe(2);
  });

  it("sets span status code 1 for allowed evaluations", async () => {
    await exportOtelSpan(makeEvaluation({ gateDecision: "allow" }), "https://otel.example.com:4318", "");

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const span = body.resourceSpans[0].scopeSpans[0].spans[0];
    expect(span.status.code).toBe(1);
  });

  it("handles fetch errors gracefully", async () => {
    mockFetch.mockRejectedValueOnce(new Error("network error"));

    await expect(
      exportOtelSpan(makeEvaluation(), "https://otel.example.com:4318", ""),
    ).resolves.toBeUndefined();
  });

  it("sets service resource attributes", async () => {
    await exportOtelSpan(makeEvaluation(), "https://otel.example.com:4318", "");

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const resourceAttrs = body.resourceSpans[0].resource.attributes;

    const serviceName = resourceAttrs.find((a: { key: string }) => a.key === "service.name");
    expect(serviceName.value.stringValue).toBe("deployguard");
  });
});
