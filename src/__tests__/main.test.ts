import { vi } from "vitest";
import * as core from "@actions/core";
import * as github from "@actions/github";
import * as gate from "../gate.js";
import * as notify from "../notify.js";
import * as healers from "../healers/index.js";
import type { GateEvaluation } from "../types.js";

function makeEvaluation(overrides: Partial<GateEvaluation> = {}): GateEvaluation {
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
  vi.mocked(core.getInput).mockImplementation((name: string) => inputs[name] ?? "");
}

describe("run (main entrypoint)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(core.getInput).mockReturnValue("");
    (github.context as { payload: { pull_request?: { number: number } } }).payload = {
      pull_request: { number: 42 },
    };

    vi.mocked(github.getOctokit).mockReturnValue({
      rest: {
        issues: {
          createComment: vi.fn().mockResolvedValue({}),
          listComments: vi.fn().mockResolvedValue({ data: [] }),
          updateComment: vi.fn().mockResolvedValue({}),
          listLabelsOnIssue: vi.fn().mockResolvedValue({ data: [] }),
          createLabel: vi.fn().mockResolvedValue({}),
          removeLabel: vi.fn().mockResolvedValue({}),
          addLabels: vi.fn().mockResolvedValue({}),
        },
        checks: {
          create: vi.fn().mockResolvedValue({}),
        },
        pulls: {
          requestReviewers: vi.fn().mockResolvedValue({}),
          listFiles: vi.fn().mockResolvedValue({ data: [] }),
          get: vi.fn().mockResolvedValue({ data: {} }),
          listCommits: vi.fn().mockResolvedValue({ data: [] }),
          listReviews: vi.fn().mockResolvedValue({ data: [] }),
        },
        repos: {
          getContent: vi.fn().mockRejectedValue(new Error("not found")),
          listCommits: vi.fn().mockResolvedValue({ data: [] }),
        },
      },
      request: vi.fn().mockResolvedValue({ data: [] }),
    } as never);

    delete process.env.TRAILHEAD_TEST_FAILURES;
  });

  it("runs end-to-end with mocked dependencies", async () => {
    const registerSpy = vi
      .spyOn(healers, "registerHealer")
      .mockImplementation(() => undefined);
    vi.spyOn(gate, "evaluateGate").mockResolvedValue(makeEvaluation());
    setupInputs({ "api-key": "test-key" });

    const eval_ = makeEvaluation();
    vi.spyOn(gate, "evaluateGate").mockResolvedValue(eval_);
    vi.spyOn(gate, "formatGateReport").mockReturnValue("## Report");
    const commentSpy = vi.spyOn(gate, "postPrComment").mockResolvedValue();
    const checkSpy = vi.spyOn(gate, "createCheckRun").mockResolvedValue();
    const webhookSpy = vi.spyOn(notify, "sendWebhook").mockResolvedValue();
    const storeSpy = vi.spyOn(notify, "storeEvaluation").mockResolvedValue();
    setupInputs({
      "api-key": "test-key",
      "github-token": "ghp_test",
      "webhook-url": "https://hooks.slack.com/test",
      "webhook-events": "warn,block",
      "evaluation-store-url": "https://example.com/api/trailhead/store",
    });

    await import("../main.js");
    await new Promise((r) => setTimeout(r, 0));

    expect(registerSpy).toHaveBeenCalledTimes(3);
    expect(core.setOutput).toHaveBeenCalledWith("health-score", "100");
    expect(core.setOutput).toHaveBeenCalledWith("risk-score", "30");
    expect(core.setOutput).toHaveBeenCalledWith("gate-decision", "allow");
    expect(core.setOutput).toHaveBeenCalledWith(
      "evaluation-json",
      expect.stringContaining('"gateDecision":"allow"'),
    );
    expect(core.setOutput).toHaveBeenCalledWith(
      "rollout-readiness-json",
      expect.stringContaining('"band"'),
    );
    expect(commentSpy).toHaveBeenCalledWith("## Report", 42, "ghp_test");
    expect(checkSpy).toHaveBeenCalled();
    expect(webhookSpy).not.toHaveBeenCalled();
    expect(storeSpy).toHaveBeenCalledWith(
      "https://example.com/api/trailhead/store",
      eval_,
    );
    expect(core.info).toHaveBeenCalledWith("## Report");
    expect(core.setFailed).not.toHaveBeenCalled();
  });
});
