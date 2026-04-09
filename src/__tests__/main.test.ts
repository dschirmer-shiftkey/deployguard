import { describe, it, expect, vi, beforeEach } from "vitest";
import type { GateEvaluation } from "../types.js";

const {
  mockEvaluateGate,
  mockFormatGateReport,
  mockPostPrComment,
  mockCreateCheckRun,
  mockManagePrLabels,
  mockRequestHighRiskReviewers,
  mockRegisterHealer,
  mockAttemptRepair,
  mockSendWebhook,
  mockGetInput,
  mockInfo,
  mockWarning,
  mockSetFailed,
  mockSetOutput,
  mockDebug,
  mockSummaryAddRaw,
  mockSummaryWrite,
  mockContext,
  mockCreateComment,
} = vi.hoisted(() => {
  const mockSummaryWrite = vi.fn().mockResolvedValue(undefined);
  const mockSummaryAddRaw = vi.fn().mockReturnValue({ write: mockSummaryWrite });
  return {
    mockEvaluateGate: vi.fn(),
    mockFormatGateReport: vi.fn(),
    mockPostPrComment: vi.fn(),
    mockCreateCheckRun: vi.fn(),
    mockManagePrLabels: vi.fn(),
    mockRequestHighRiskReviewers: vi.fn(),
    mockRegisterHealer: vi.fn(),
    mockAttemptRepair: vi.fn(),
    mockSendWebhook: vi.fn(),
    mockGetInput: vi.fn(),
    mockInfo: vi.fn(),
    mockWarning: vi.fn(),
    mockSetFailed: vi.fn(),
    mockSetOutput: vi.fn(),
    mockDebug: vi.fn(),
    mockSummaryAddRaw,
    mockSummaryWrite,
    mockContext: {
      repo: { owner: "test-owner", repo: "test-repo" },
      sha: "abc1234567890",
      payload: { pull_request: { number: 42 } } as {
        pull_request?: { number: number };
      },
    },
    mockCreateComment: vi.fn(),
  };
});

vi.mock("@actions/core", () => ({
  getInput: mockGetInput,
  info: mockInfo,
  warning: mockWarning,
  error: vi.fn(),
  debug: mockDebug,
  setFailed: mockSetFailed,
  setOutput: mockSetOutput,
  summary: { addRaw: mockSummaryAddRaw },
}));

vi.mock("@actions/github", () => ({
  context: mockContext,
  getOctokit: () => ({
    rest: { issues: { createComment: mockCreateComment } },
  }),
}));

vi.mock("../gate.js", () => ({
  evaluateGate: mockEvaluateGate,
  formatGateReport: mockFormatGateReport,
  postPrComment: mockPostPrComment,
  createCheckRun: mockCreateCheckRun,
  managePrLabels: mockManagePrLabels,
  requestHighRiskReviewers: mockRequestHighRiskReviewers,
}));

vi.mock("../notify.js", () => ({
  sendWebhook: mockSendWebhook,
}));

vi.mock("../healers/index.js", () => ({
  registerHealer: mockRegisterHealer,
  attemptRepair: mockAttemptRepair,
}));

vi.mock("../healers/jest.js", () => ({ jestHealer: { name: "jest" } }));
vi.mock("../healers/playwright.js", () => ({
  playwrightHealer: { name: "playwright" },
}));
vi.mock("../healers/cypress.js", () => ({
  cypressHealer: { name: "cypress" },
}));

function makeEvaluation(
  overrides: Partial<GateEvaluation> = {},
): GateEvaluation {
  return {
    id: "dg-abc1234-1234567890",
    repoId: "test-owner/test-repo",
    commitSha: "abc1234567890",
    healthScore: 100,
    riskScore: 30,
    gateDecision: "allow",
    healthChecks: [],
    riskFactors: [],
    evaluationMs: 42,
    ...overrides,
  };
}

function setupInputs(inputs: Record<string, string>): void {
  mockGetInput.mockImplementation((name: string) => inputs[name] ?? "");
}

async function runMain(): Promise<void> {
  await import("../main.js");
  await new Promise((r) => setTimeout(r, 0));
}

describe("run (main entrypoint)", () => {
  beforeEach(() => {
    vi.resetModules();
    mockEvaluateGate.mockReset();
    mockFormatGateReport.mockReset().mockReturnValue("## Report");
    mockPostPrComment.mockReset().mockResolvedValue(undefined);
    mockCreateCheckRun.mockReset().mockResolvedValue(undefined);
    mockManagePrLabels.mockReset().mockResolvedValue(undefined);
    mockRequestHighRiskReviewers.mockReset().mockResolvedValue(undefined);
    mockSendWebhook.mockReset().mockResolvedValue(undefined);
    mockRegisterHealer.mockReset();
    mockAttemptRepair.mockReset();
    mockGetInput.mockReset();
    mockInfo.mockReset();
    mockWarning.mockReset();
    mockSetFailed.mockReset();
    mockSetOutput.mockReset();
    mockDebug.mockReset();
    mockSummaryAddRaw.mockReset().mockReturnValue({ write: mockSummaryWrite });
    mockSummaryWrite.mockReset().mockResolvedValue(undefined);
    mockCreateComment.mockReset().mockResolvedValue({});
    mockContext.payload = { pull_request: { number: 42 } };
    delete process.env.DEPLOYGUARD_TEST_FAILURES;
    delete process.env.GITHUB_TOKEN;
    delete process.env.DEPLOYGUARD_API_URL;
  });

  it("registers all three healers on startup", async () => {
    setupInputs({ "api-key": "test-key" });
    mockEvaluateGate.mockResolvedValue(makeEvaluation());
    await runMain();
    expect(mockRegisterHealer).toHaveBeenCalledTimes(3);
  });

  it("sets outputs and logs info on allow decision", async () => {
    setupInputs({ "api-key": "test-key", "github-token": "ghp_test" });
    mockEvaluateGate.mockResolvedValue(makeEvaluation());
    await runMain();

    expect(mockSetOutput).toHaveBeenCalledWith("health-score", "100");
    expect(mockSetOutput).toHaveBeenCalledWith("risk-score", "30");
    expect(mockSetOutput).toHaveBeenCalledWith("gate-decision", "allow");
    expect(mockSetOutput).toHaveBeenCalledWith(
      "evaluation-json",
      expect.stringContaining('"gateDecision":"allow"'),
    );
    expect(mockInfo).toHaveBeenCalledWith("## Report");
    expect(mockSetFailed).not.toHaveBeenCalled();
  });

  it("writes job summary via core.summary", async () => {
    setupInputs({ "api-key": "test-key" });
    mockEvaluateGate.mockResolvedValue(makeEvaluation());
    await runMain();

    expect(mockSummaryAddRaw).toHaveBeenCalledWith("## Report");
    expect(mockSummaryWrite).toHaveBeenCalled();
  });

  it("posts PR comment when prNumber and token are available", async () => {
    setupInputs({ "api-key": "test-key", "github-token": "ghp_test" });
    mockEvaluateGate.mockResolvedValue(makeEvaluation());
    await runMain();

    expect(mockPostPrComment).toHaveBeenCalledWith(
      "## Report",
      42,
      "ghp_test",
    );
  });

  it("creates check run when token is available", async () => {
    setupInputs({ "api-key": "test-key", "github-token": "ghp_test" });
    const eval_ = makeEvaluation();
    mockEvaluateGate.mockResolvedValue(eval_);
    await runMain();

    expect(mockCreateCheckRun).toHaveBeenCalledWith(
      eval_,
      "## Report",
      "ghp_test",
    );
  });

  it("manages PR labels when token and prNumber are available", async () => {
    setupInputs({ "api-key": "test-key", "github-token": "ghp_test" });
    mockEvaluateGate.mockResolvedValue(makeEvaluation());
    await runMain();

    expect(mockManagePrLabels).toHaveBeenCalledWith(42, "allow", "ghp_test");
  });

  it("skips PR labels when add-risk-labels is false", async () => {
    setupInputs({
      "api-key": "test-key",
      "github-token": "ghp_test",
      "add-risk-labels": "false",
    });
    mockEvaluateGate.mockResolvedValue(makeEvaluation());
    await runMain();

    expect(mockManagePrLabels).not.toHaveBeenCalled();
  });

  it("skips PR comment when no prNumber", async () => {
    mockContext.payload = {};
    setupInputs({ "api-key": "test-key", "github-token": "ghp_test" });
    mockEvaluateGate.mockResolvedValue(makeEvaluation());
    await runMain();

    expect(mockPostPrComment).not.toHaveBeenCalled();
  });

  it("skips PR comment when no github token", async () => {
    setupInputs({ "api-key": "test-key" });
    mockEvaluateGate.mockResolvedValue(makeEvaluation());
    await runMain();

    expect(mockPostPrComment).not.toHaveBeenCalled();
  });

  it("sets report-url output when available", async () => {
    setupInputs({ "api-key": "test-key" });
    mockEvaluateGate.mockResolvedValue(
      makeEvaluation({ reportUrl: "https://example.com/report" }),
    );
    await runMain();

    expect(mockSetOutput).toHaveBeenCalledWith(
      "report-url",
      "https://example.com/report",
    );
  });

  it("calls core.warning on warn decision", async () => {
    setupInputs({ "api-key": "test-key", "self-heal": "false" });
    mockEvaluateGate.mockResolvedValue(
      makeEvaluation({ gateDecision: "warn", riskScore: 55 }),
    );
    await runMain();

    expect(mockWarning).toHaveBeenCalledWith("## Report");
    expect(mockSetFailed).not.toHaveBeenCalled();
  });

  it("calls core.setFailed on block decision", async () => {
    setupInputs({ "api-key": "test-key", "self-heal": "false" });
    mockEvaluateGate.mockResolvedValue(
      makeEvaluation({ gateDecision: "block", riskScore: 90 }),
    );
    await runMain();

    expect(mockSetFailed).toHaveBeenCalledWith(
      expect.stringContaining("Deployment blocked"),
    );
  });

  it("requests reviewers on warn when reviewers-on-risk is set", async () => {
    setupInputs({
      "api-key": "test-key",
      "github-token": "ghp_test",
      "self-heal": "false",
      "reviewers-on-risk": "alice, bob",
    });
    mockEvaluateGate.mockResolvedValue(
      makeEvaluation({ gateDecision: "warn", riskScore: 55 }),
    );
    await runMain();

    expect(mockRequestHighRiskReviewers).toHaveBeenCalledWith(
      42,
      ["alice", "bob"],
      "ghp_test",
    );
  });

  it("requests reviewers on block when reviewers-on-risk is set", async () => {
    setupInputs({
      "api-key": "test-key",
      "github-token": "ghp_test",
      "self-heal": "false",
      "reviewers-on-risk": "alice",
    });
    mockEvaluateGate.mockResolvedValue(
      makeEvaluation({ gateDecision: "block", riskScore: 90 }),
    );
    await runMain();

    expect(mockRequestHighRiskReviewers).toHaveBeenCalledWith(
      42,
      ["alice"],
      "ghp_test",
    );
  });

  it("does not request reviewers on allow", async () => {
    setupInputs({
      "api-key": "test-key",
      "github-token": "ghp_test",
      "reviewers-on-risk": "alice",
    });
    mockEvaluateGate.mockResolvedValue(makeEvaluation());
    await runMain();

    expect(mockRequestHighRiskReviewers).not.toHaveBeenCalled();
  });

  it("sends webhook when decision matches webhook-events", async () => {
    setupInputs({
      "api-key": "test-key",
      "webhook-url": "https://hooks.slack.com/test",
      "webhook-events": "warn,block",
      "self-heal": "false",
    });
    const eval_ = makeEvaluation({ gateDecision: "block", riskScore: 90 });
    mockEvaluateGate.mockResolvedValue(eval_);
    await runMain();

    expect(mockSendWebhook).toHaveBeenCalledWith(
      "https://hooks.slack.com/test",
      eval_,
    );
  });

  it("does not send webhook when decision does not match webhook-events", async () => {
    setupInputs({
      "api-key": "test-key",
      "webhook-url": "https://hooks.slack.com/test",
      "webhook-events": "block",
    });
    mockEvaluateGate.mockResolvedValue(makeEvaluation());
    await runMain();

    expect(mockSendWebhook).not.toHaveBeenCalled();
  });

  it("does not send webhook when webhook-url is not set", async () => {
    setupInputs({ "api-key": "test-key", "self-heal": "false" });
    mockEvaluateGate.mockResolvedValue(
      makeEvaluation({ gateDecision: "block", riskScore: 90 }),
    );
    await runMain();

    expect(mockSendWebhook).not.toHaveBeenCalled();
  });

  it("proceeds with warning on fail-open when evaluateGate throws", async () => {
    setupInputs({ "api-key": "test-key", "fail-mode": "open" });
    mockEvaluateGate.mockRejectedValue(new Error("API down"));
    await runMain();

    expect(mockWarning).toHaveBeenCalledWith(
      expect.stringContaining("fail-open"),
    );
    expect(mockSetFailed).not.toHaveBeenCalled();
  });

  it("blocks on fail-closed when evaluateGate throws", async () => {
    setupInputs({ "api-key": "test-key", "fail-mode": "closed" });
    mockEvaluateGate.mockRejectedValue(new Error("API down"));
    await runMain();

    expect(mockSetFailed).toHaveBeenCalledWith(
      expect.stringContaining("fail-closed"),
    );
  });

  it("defaults to fail-open when fail-mode input is empty", async () => {
    setupInputs({ "api-key": "test-key" });
    mockEvaluateGate.mockRejectedValue(new Error("boom"));
    await runMain();

    expect(mockWarning).toHaveBeenCalledWith(
      expect.stringContaining("fail-open"),
    );
    expect(mockSetFailed).not.toHaveBeenCalled();
  });

  it("runs self-heal on warn when enabled with test failures", async () => {
    setupInputs({ "api-key": "test-key", "github-token": "ghp_test" });
    mockEvaluateGate.mockResolvedValue(
      makeEvaluation({ gateDecision: "warn", riskScore: 55 }),
    );
    process.env.DEPLOYGUARD_TEST_FAILURES = JSON.stringify([
      { file: "src/foo.test.ts", error: "snapshot mismatch" },
    ]);
    mockAttemptRepair.mockResolvedValue({
      testFile: "src/foo.test.ts",
      failureType: "snapshot-mismatch",
      strategy: "update-snapshot",
      success: true,
      diff: "- old\n+ new",
    });
    await runMain();

    expect(mockAttemptRepair).toHaveBeenCalledWith(
      "src/foo.test.ts",
      "snapshot mismatch",
    );
    expect(mockInfo).toHaveBeenCalledWith(
      expect.stringContaining("Self-heal attempted 1 repair(s)"),
    );
  });

  it("does not run self-heal when disabled", async () => {
    setupInputs({ "api-key": "test-key", "self-heal": "false" });
    mockEvaluateGate.mockResolvedValue(
      makeEvaluation({ gateDecision: "warn", riskScore: 55 }),
    );
    process.env.DEPLOYGUARD_TEST_FAILURES = JSON.stringify([
      { file: "src/foo.test.ts", error: "snapshot mismatch" },
    ]);
    await runMain();

    expect(mockAttemptRepair).not.toHaveBeenCalled();
  });

  it("skips self-heal when no test failures env var is set", async () => {
    setupInputs({ "api-key": "test-key", "github-token": "ghp_test" });
    mockEvaluateGate.mockResolvedValue(
      makeEvaluation({ gateDecision: "warn", riskScore: 55 }),
    );
    await runMain();

    expect(mockAttemptRepair).not.toHaveBeenCalled();
  });

  it("handles invalid JSON in DEPLOYGUARD_TEST_FAILURES gracefully", async () => {
    setupInputs({ "api-key": "test-key", "github-token": "ghp_test" });
    mockEvaluateGate.mockResolvedValue(
      makeEvaluation({ gateDecision: "warn", riskScore: 55 }),
    );
    process.env.DEPLOYGUARD_TEST_FAILURES = "not-json{{{";
    await runMain();

    expect(mockAttemptRepair).not.toHaveBeenCalled();
    expect(mockDebug).toHaveBeenCalledWith(
      expect.stringContaining("Could not parse DEPLOYGUARD_TEST_FAILURES"),
    );
  });

  it("posts self-heal suggestion as PR comment on successful repair", async () => {
    setupInputs({ "api-key": "test-key", "github-token": "ghp_test" });
    mockEvaluateGate.mockResolvedValue(
      makeEvaluation({ gateDecision: "block", riskScore: 90 }),
    );
    process.env.DEPLOYGUARD_TEST_FAILURES = JSON.stringify([
      { file: "src/foo.test.ts", error: "timeout" },
    ]);
    mockAttemptRepair.mockResolvedValue({
      testFile: "src/foo.test.ts",
      failureType: "timeout",
      strategy: "increase-timeout",
      success: true,
      diff: "- old\n+ new",
    });
    await runMain();

    expect(mockCreateComment).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "test-owner",
        repo: "test-repo",
        issue_number: 42,
        body: expect.stringContaining("Self-Heal Suggestion"),
      }),
    );
    expect(mockSetFailed).toHaveBeenCalledWith(
      expect.stringContaining("Deployment blocked"),
    );
  });

  it("does not post comment when repair has no diff", async () => {
    setupInputs({ "api-key": "test-key", "github-token": "ghp_test" });
    mockEvaluateGate.mockResolvedValue(
      makeEvaluation({ gateDecision: "warn", riskScore: 55 }),
    );
    process.env.DEPLOYGUARD_TEST_FAILURES = JSON.stringify([
      { file: "src/foo.test.ts", error: "timeout" },
    ]);
    mockAttemptRepair.mockResolvedValue({
      testFile: "src/foo.test.ts",
      failureType: "timeout",
      strategy: "increase-timeout",
      success: true,
    });
    await runMain();

    expect(mockCreateComment).not.toHaveBeenCalled();
  });

  it("handles createComment failure gracefully during self-heal", async () => {
    setupInputs({ "api-key": "test-key", "github-token": "ghp_test" });
    mockEvaluateGate.mockResolvedValue(
      makeEvaluation({ gateDecision: "warn", riskScore: 55 }),
    );
    process.env.DEPLOYGUARD_TEST_FAILURES = JSON.stringify([
      { file: "src/foo.test.ts", error: "snapshot mismatch" },
    ]);
    mockAttemptRepair.mockResolvedValue({
      testFile: "src/foo.test.ts",
      failureType: "snapshot-mismatch",
      strategy: "update-snapshot",
      success: true,
      diff: "- old\n+ new",
    });
    mockCreateComment.mockRejectedValue(new Error("GitHub API error"));
    await runMain();

    expect(mockDebug).toHaveBeenCalledWith(
      expect.stringContaining("Failed to post self-heal suggestion"),
    );
  });

  it("handles attemptRepair returning null", async () => {
    setupInputs({ "api-key": "test-key", "github-token": "ghp_test" });
    mockEvaluateGate.mockResolvedValue(
      makeEvaluation({ gateDecision: "warn", riskScore: 55 }),
    );
    process.env.DEPLOYGUARD_TEST_FAILURES = JSON.stringify([
      { file: "src/unknown.test.ts", error: "some error" },
    ]);
    mockAttemptRepair.mockResolvedValue(null);
    await runMain();

    expect(mockCreateComment).not.toHaveBeenCalled();
  });

  it("passes warnThreshold when warn-threshold input is set", async () => {
    setupInputs({ "api-key": "test-key", "warn-threshold": "50" });
    mockEvaluateGate.mockResolvedValue(makeEvaluation());
    await runMain();

    expect(mockEvaluateGate).toHaveBeenCalledWith(
      expect.objectContaining({ warnThreshold: 50 }),
      "abc1234567890",
      42,
    );
  });

  it("leaves warnThreshold undefined when warn-threshold input is empty", async () => {
    setupInputs({ "api-key": "test-key" });
    mockEvaluateGate.mockResolvedValue(makeEvaluation());
    await runMain();

    expect(mockEvaluateGate).toHaveBeenCalledWith(
      expect.objectContaining({ warnThreshold: undefined }),
      "abc1234567890",
      42,
    );
  });

  it("passes riskThreshold to formatGateReport", async () => {
    setupInputs({ "api-key": "test-key", "risk-threshold": "65" });
    mockEvaluateGate.mockResolvedValue(makeEvaluation());
    await runMain();

    expect(mockFormatGateReport).toHaveBeenCalledWith(
      expect.objectContaining({ gateDecision: "allow" }),
      65,
    );
  });
});
