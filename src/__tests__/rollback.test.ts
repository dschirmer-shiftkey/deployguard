import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@actions/core", () => ({
  info: vi.fn(),
  warning: vi.fn(),
  debug: vi.fn(),
}));

vi.mock("@actions/github", () => ({
  context: {
    repo: { owner: "test-owner", repo: "test-repo" },
    sha: "abc1234567890",
    payload: {},
  },
  getOctokit: vi.fn(),
}));

import type { DeployOutcome } from "../canary.js";
import { executeRollback, notifyRollback, type RollbackResult } from "../rollback.js";
import * as github from "@actions/github";

function makeOutcome(overrides: Partial<DeployOutcome> = {}): DeployOutcome {
  return {
    deploymentId: "dep-123",
    environment: "production",
    status: "failure",
    timestamp: new Date().toISOString(),
    source: "vercel",
    ...overrides,
  };
}

describe("executeRollback", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    delete process.env.VERCEL_TOKEN;
    delete process.env.VERCEL_PROJECT_ID;
    delete process.env.VERCEL_TEAM_ID;
    delete process.env.DEPLOYGUARD_ROLLBACK_STRATEGY;
    delete process.env.DEPLOYGUARD_ROLLBACK_WORKFLOW;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("skips rollback for successful deployments", async () => {
    const result = await executeRollback(makeOutcome({ status: "success" }));
    expect(result.triggered).toBe(false);
    expect(result.strategy).toBe("none");
    expect(result.detail).toContain("success");
  });

  it("skips rollback for cancelled deployments", async () => {
    const result = await executeRollback(makeOutcome({ status: "cancelled" }));
    expect(result.triggered).toBe(false);
    expect(result.strategy).toBe("none");
  });

  it("auto-detects vercel strategy when env vars are set", async () => {
    process.env.VERCEL_TOKEN = "test-token";
    process.env.VERCEL_PROJECT_ID = "prj_test";

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          deployments: [
            { uid: "current-uid", url: "current.vercel.app" },
            { uid: "previous-uid", url: "previous.vercel.app" },
          ],
        }),
        { status: 200 },
      ),
    );
    vi.mocked(fetch).mockResolvedValueOnce(new Response("", { status: 202 }));

    const result = await executeRollback(makeOutcome());
    expect(result.triggered).toBe(true);
    expect(result.strategy).toBe("vercel");
    expect(result.detail).toContain("previous-uid");
  });

  it("handles vercel rollback when no previous deployment exists", async () => {
    process.env.VERCEL_TOKEN = "test-token";
    process.env.VERCEL_PROJECT_ID = "prj_test";

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          deployments: [{ uid: "only-one", url: "current.vercel.app" }],
        }),
        { status: 200 },
      ),
    );

    const result = await executeRollback(makeOutcome());
    expect(result.triggered).toBe(false);
    expect(result.strategy).toBe("vercel");
    expect(result.detail).toContain("No previous");
  });

  it("handles vercel API errors gracefully", async () => {
    process.env.VERCEL_TOKEN = "test-token";
    process.env.VERCEL_PROJECT_ID = "prj_test";

    vi.mocked(fetch).mockResolvedValueOnce(new Response("forbidden", { status: 403 }));

    const result = await executeRollback(makeOutcome());
    expect(result.triggered).toBe(false);
    expect(result.strategy).toBe("vercel");
    expect(result.detail).toContain("403");
  });

  it("handles vercel network errors", async () => {
    process.env.VERCEL_TOKEN = "test-token";
    process.env.VERCEL_PROJECT_ID = "prj_test";

    vi.mocked(fetch).mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const result = await executeRollback(makeOutcome());
    expect(result.triggered).toBe(false);
    expect(result.strategy).toBe("vercel");
    expect(result.detail).toContain("ECONNREFUSED");
  });

  it("falls back to github-deployment when no vercel env vars", async () => {
    const mockOctokit = {
      rest: {
        repos: {
          listDeployments: vi.fn().mockResolvedValue({
            data: [
              {
                id: 100,
                ref: "main",
                sha: "goodsha1234567890",
                environment: "production",
                created_at: "2026-04-10T00:00:00Z",
                creator: { login: "david" },
              },
            ],
          }),
          listDeploymentStatuses: vi.fn().mockResolvedValue({
            data: [{ state: "success" }],
          }),
          createDeployment: vi.fn().mockResolvedValue({
            data: { id: 200 },
          }),
          createDeploymentStatus: vi.fn().mockResolvedValue({ data: {} }),
        },
      },
    };
    vi.mocked(github.getOctokit).mockReturnValue(mockOctokit as never);

    const result = await executeRollback(makeOutcome(), "fake-token");
    expect(result.triggered).toBe(true);
    expect(result.strategy).toBe("github-deployment");
    expect(result.targetRef).toBe("goodsha");
  });

  it("returns failure when no token for github-deployment", async () => {
    const result = await executeRollback(makeOutcome());
    expect(result.triggered).toBe(false);
    expect(result.strategy).toBe("github-deployment");
    expect(result.detail).toContain("No GitHub token");
  });

  it("uses explicit strategy from env var", async () => {
    process.env.DEPLOYGUARD_ROLLBACK_STRATEGY = "workflow-dispatch";
    process.env.DEPLOYGUARD_ROLLBACK_WORKFLOW = "deploy-rollback.yml";

    const mockOctokit = {
      rest: {
        repos: {
          listDeployments: vi.fn().mockResolvedValue({ data: [] }),
          listDeploymentStatuses: vi.fn().mockResolvedValue({ data: [] }),
        },
        actions: {
          createWorkflowDispatch: vi.fn().mockResolvedValue({ data: {} }),
        },
      },
    };
    vi.mocked(github.getOctokit).mockReturnValue(mockOctokit as never);

    const result = await executeRollback(makeOutcome(), "fake-token");
    expect(result.triggered).toBe(true);
    expect(result.strategy).toBe("workflow-dispatch");
    expect(result.detail).toContain("deploy-rollback.yml");
  });

  it("handles github deployment not found", async () => {
    const mockOctokit = {
      rest: {
        repos: {
          listDeployments: vi.fn().mockResolvedValue({ data: [] }),
        },
      },
    };
    vi.mocked(github.getOctokit).mockReturnValue(mockOctokit as never);

    const result = await executeRollback(makeOutcome(), "fake-token");
    expect(result.triggered).toBe(false);
    expect(result.detail).toContain("No previous successful deployment");
  });

  it("returns consistent RollbackResult shape", async () => {
    const result = await executeRollback(makeOutcome({ status: "success" }));
    expect(result).toHaveProperty("triggered");
    expect(result).toHaveProperty("strategy");
    expect(result).toHaveProperty("detail");
    expect(result).toHaveProperty("timestamp");
    expect(new Date(result.timestamp).getTime()).not.toBeNaN();
  });
});

describe("notifyRollback", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("posts a comment for triggered rollback", async () => {
    const createComment = vi.fn().mockResolvedValue({ data: {} });
    vi.mocked(github.getOctokit).mockReturnValue({
      rest: {
        issues: { createComment },
      },
    } as never);

    const result: RollbackResult = {
      triggered: true,
      strategy: "vercel",
      targetRef: "prev-uid",
      detail: "Promoted previous deployment",
      timestamp: new Date().toISOString(),
    };

    await notifyRollback(result, "fake-token", 42);
    expect(createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        issue_number: 42,
        body: expect.stringContaining("Rollback triggered"),
      }),
    );
  });

  it("posts a warning comment for failed rollback", async () => {
    const createComment = vi.fn().mockResolvedValue({ data: {} });
    vi.mocked(github.getOctokit).mockReturnValue({
      rest: {
        issues: { createComment },
      },
    } as never);

    const result: RollbackResult = {
      triggered: false,
      strategy: "github-deployment",
      detail: "No previous deployment found",
      timestamp: new Date().toISOString(),
    };

    await notifyRollback(result, "fake-token", 10);
    expect(createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining("Rollback attempted (failed)"),
      }),
    );
  });

  it("skips notification when no issue number", async () => {
    const createComment = vi.fn();
    vi.mocked(github.getOctokit).mockReturnValue({
      rest: {
        issues: { createComment },
      },
    } as never);

    await notifyRollback(
      {
        triggered: true,
        strategy: "vercel",
        detail: "ok",
        timestamp: new Date().toISOString(),
      },
      "fake-token",
    );
    expect(createComment).not.toHaveBeenCalled();
  });
});
