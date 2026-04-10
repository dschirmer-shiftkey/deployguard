import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sendWebhook, storeEvaluation } from "../notify.js";
import type { GateEvaluation } from "../types.js";

vi.mock("@actions/core", () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
}));

vi.mock("@actions/github", () => ({
  context: {
    repo: { owner: "test-owner", repo: "test-repo" },
  },
}));

function jsonResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeEvaluation(overrides: Partial<GateEvaluation> = {}): GateEvaluation {
  return {
    id: "dg-test",
    repoId: "test-owner/test-repo",
    commitSha: "abc1234567890",
    healthScore: 100,
    riskScore: 85,
    gateDecision: "block",
    healthChecks: [],
    riskFactors: [{ type: "code_churn", score: 80, detail: { totalChanges: 2000 } }],
    evaluationMs: 50,
    prNumber: 42,
    ...overrides,
  };
}

describe("sendWebhook", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends a POST with the correct payload", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response("ok", { status: 200 }));
    await sendWebhook("https://hooks.slack.com/test", makeEvaluation());

    expect(fetch).toHaveBeenCalledWith(
      "https://hooks.slack.com/test",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }),
    );

    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
    expect(body.decision).toBe("block");
    expect(body.riskScore).toBe(85);
    expect(body.healthScore).toBe(100);
    expect(body.repoId).toBe("test-owner/test-repo");
    expect(body.prNumber).toBe(42);
    expect(body.prUrl).toBe("https://github.com/test-owner/test-repo/pull/42");
    expect(body.commitSha).toBe("abc1234567890");
    expect(body.timestamp).toBeDefined();
  });

  it("includes Slack-compatible text field", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response("ok", { status: 200 }));
    await sendWebhook("https://hooks.slack.com/test", makeEvaluation());

    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
    expect(body.text).toContain("BLOCK");
    expect(body.text).toContain("risk 85/100");
    expect(body.text).toContain("PR #42");
  });

  it("handles missing prNumber gracefully", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response("ok", { status: 200 }));
    await sendWebhook(
      "https://hooks.slack.com/test",
      makeEvaluation({ prNumber: undefined }),
    );

    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
    expect(body.prUrl).toBeUndefined();
    expect(body.text).toContain("abc1234");
  });

  it("handles non-200 response gracefully (fail-open)", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response("error", { status: 500 }));
    await expect(
      sendWebhook("https://hooks.slack.com/test", makeEvaluation()),
    ).resolves.toBeUndefined();
  });

  it("handles network error gracefully (fail-open)", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(
      sendWebhook("https://hooks.slack.com/test", makeEvaluation()),
    ).resolves.toBeUndefined();
  });
});

describe("storeEvaluation", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    delete process.env.EVALUATION_STORE_SECRET;
    delete process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.EVALUATION_STORE_SECRET;
    delete process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  });

  it("sends evaluation as POST body", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse('{"stored":true}'));
    const eval_ = makeEvaluation();
    await storeEvaluation("https://example.com/api/deployguard/store", eval_);

    expect(fetch).toHaveBeenCalledWith(
      "https://example.com/api/deployguard/store",
      expect.objectContaining({ method: "POST" }),
    );
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
    expect(body.id).toBe("dg-test");
    expect(body.riskScore).toBe(85);
    expect(body.gateDecision).toBe("block");
  });

  it("includes Authorization header when EVALUATION_STORE_SECRET is set", async () => {
    process.env.EVALUATION_STORE_SECRET = "my-secret";
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse('{"stored":true}'));
    await storeEvaluation("https://example.com/api/deployguard/store", makeEvaluation());

    const headers = vi.mocked(fetch).mock.calls[0][1]!.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer my-secret");
  });

  it("sends x-vercel-protection-bypass when VERCEL_AUTOMATION_BYPASS_SECRET is set", async () => {
    process.env.VERCEL_AUTOMATION_BYPASS_SECRET = "bypass-token";
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse('{"stored":true}'));
    await storeEvaluation("https://example.com/api/store", makeEvaluation());
    const headers = vi.mocked(fetch).mock.calls[0][1]!.headers as Record<string, string>;
    expect(headers["x-vercel-protection-bypass"]).toBe("bypass-token");
  });

  it("omits Authorization header when no secret is set", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse('{"stored":true}'));
    await storeEvaluation("https://example.com/api/deployguard/store", makeEvaluation());

    const headers = vi.mocked(fetch).mock.calls[0][1]!.headers as Record<string, string>;
    expect(headers["Authorization"]).toBeUndefined();
  });

  it("falls back to Supabase REST when primary returns HTML", async () => {
    process.env.SUPABASE_URL = "https://abc.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role";
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        new Response("<html>checkpoint</html>", {
          status: 429,
          headers: { "Content-Type": "text/html" },
        }),
      )
      .mockResolvedValueOnce(jsonResponse("", 201));

    await storeEvaluation("https://app.example/api/store", makeEvaluation());

    expect(fetch).toHaveBeenCalledTimes(2);
    const supUrl = vi.mocked(fetch).mock.calls[1][0] as string;
    expect(supUrl).toContain("supabase.co/rest/v1/deployguard_evaluations");
    const row = JSON.parse(vi.mocked(fetch).mock.calls[1][1]!.body as string);
    expect(row.gate_decision).toBe("block");
    expect(row.risk_score).toBe(85);
  });

  it("handles non-JSON success from primary then skips when no Supabase env", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response("<html/>", { status: 200, headers: { "Content-Type": "text/html" } }),
    );
    await storeEvaluation("https://example.com/api/deployguard/store", makeEvaluation());
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("handles non-200 JSON response gracefully (fail-open)", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse('{"error":"nope"}', 500));
    await expect(
      storeEvaluation("https://example.com/api/deployguard/store", makeEvaluation()),
    ).resolves.toBeUndefined();
  });

  it("handles network error gracefully (fail-open)", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(
      storeEvaluation("https://example.com/api/deployguard/store", makeEvaluation()),
    ).resolves.toBeUndefined();
  });
});
