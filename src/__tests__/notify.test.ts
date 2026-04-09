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
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.EVALUATION_STORE_SECRET;
  });

  it("sends evaluation as POST body", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response('{"stored":true}', { status: 200 }),
    );
    const eval_ = makeEvaluation();
    await storeEvaluation("https://komatik.ai/api/deployguard/store", eval_);

    expect(fetch).toHaveBeenCalledWith(
      "https://komatik.ai/api/deployguard/store",
      expect.objectContaining({ method: "POST" }),
    );
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
    expect(body.id).toBe("dg-test");
    expect(body.riskScore).toBe(85);
    expect(body.gateDecision).toBe("block");
  });

  it("includes Authorization header when EVALUATION_STORE_SECRET is set", async () => {
    process.env.EVALUATION_STORE_SECRET = "my-secret";
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response('{"stored":true}', { status: 200 }),
    );
    await storeEvaluation("https://komatik.ai/api/deployguard/store", makeEvaluation());

    const headers = vi.mocked(fetch).mock.calls[0][1]!.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer my-secret");
  });

  it("omits Authorization header when no secret is set", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response('{"stored":true}', { status: 200 }),
    );
    await storeEvaluation("https://komatik.ai/api/deployguard/store", makeEvaluation());

    const headers = vi.mocked(fetch).mock.calls[0][1]!.headers as Record<string, string>;
    expect(headers["Authorization"]).toBeUndefined();
  });

  it("handles non-200 response gracefully (fail-open)", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response("error", { status: 500 }));
    await expect(
      storeEvaluation("https://komatik.ai/api/deployguard/store", makeEvaluation()),
    ).resolves.toBeUndefined();
  });

  it("handles network error gracefully (fail-open)", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(
      storeEvaluation("https://komatik.ai/api/deployguard/store", makeEvaluation()),
    ).resolves.toBeUndefined();
  });
});
