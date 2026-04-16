import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { DeployGuardConfig } from "../types.js";

const mockListFiles = vi.fn();
const mockListCommits = vi.fn();
const mockGetCommit = vi.fn();
const mockPullsGet = vi.fn();
const mockReposListCommits = vi.fn();

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
        listFiles: mockListFiles,
        listCommits: mockListCommits,
        get: mockPullsGet,
      },
      repos: {
        listCommits: mockReposListCommits,
        getCommit: mockGetCommit,
      },
    },
  }),
}));

function makeConfig(overrides: Partial<DeployGuardConfig> = {}): DeployGuardConfig {
  return {
    apiKey: "",
    apiUrl: "",
    riskThreshold: 70,
    failMode: "open",
    selfHeal: false,
    addRiskLabels: true,
    reviewersOnRisk: [],
    webhookEvents: ["warn", "block"],
    healthCheckUrls: [],
    githubToken: "ghp_test",
    ...overrides,
  };
}

function makeFile(name: string, changes = 10) {
  return {
    filename: name,
    additions: Math.ceil(changes / 2),
    deletions: Math.floor(changes / 2),
    changes,
  };
}

describe("merge-base drift detection", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    mockPullsGet.mockResolvedValue({
      data: { user: { login: "test-author" }, created_at: new Date().toISOString() },
    });
    mockReposListCommits.mockResolvedValue({
      data: Array.from({ length: 10 }, (_, i) => ({
        sha: `commit-${i}`,
        commit: { message: `commit ${i}` },
      })),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("uses API file list when file count is below drift-check threshold", async () => {
    const apiFiles = Array.from({ length: 20 }, (_, i) => makeFile(`src/file-${i}.ts`));
    mockListFiles.mockResolvedValue({ data: apiFiles });
    mockListCommits.mockResolvedValue({
      data: [{ sha: "c1", commit: { message: "feat" } }],
    });

    const { evaluateGate } = await import("../gate.js");
    const result = await evaluateGate(makeConfig(), "abc1234567890", 42);

    expect(result.files).toHaveLength(20);
    expect(mockGetCommit).not.toHaveBeenCalled();
  });

  it("falls back to commit-derived files when merge-base is drifted", async () => {
    const realFiles = Array.from({ length: 17 }, (_, i) =>
      makeFile(`dashboard/src/file-${i}.tsx`, 30),
    );
    const ghostFiles = Array.from({ length: 68 }, (_, i) =>
      makeFile(`src/ghost-${i}.ts`, 15),
    );
    mockListFiles.mockResolvedValue({ data: [...realFiles, ...ghostFiles] });

    mockListCommits.mockResolvedValue({
      data: [
        { sha: "real-commit-1", commit: { message: "feat: dashboard wiring" } },
        { sha: "real-commit-2", commit: { message: "fix: auth types" } },
      ],
    });

    mockGetCommit
      .mockResolvedValueOnce({
        data: {
          sha: "real-commit-1",
          files: realFiles.slice(0, 10).map((f) => ({
            filename: f.filename,
            additions: f.additions,
            deletions: f.deletions,
            changes: f.changes,
          })),
        },
      })
      .mockResolvedValueOnce({
        data: {
          sha: "real-commit-2",
          files: realFiles.slice(10).map((f) => ({
            filename: f.filename,
            additions: f.additions,
            deletions: f.deletions,
            changes: f.changes,
          })),
        },
      });

    const { evaluateGate } = await import("../gate.js");
    const result = await evaluateGate(makeConfig(), "abc1234567890", 42);

    expect(result.files).toHaveLength(17);
    expect(result.files!.every((f) => f.startsWith("dashboard/"))).toBe(true);
    expect(result.files!.some((f) => f.includes("ghost"))).toBe(false);
  });

  it("keeps API file list when commit files are comparable in count", async () => {
    const files = Array.from({ length: 40 }, (_, i) => makeFile(`src/file-${i}.ts`, 20));
    mockListFiles.mockResolvedValue({ data: files });

    mockListCommits.mockResolvedValue({
      data: [
        { sha: "c1", commit: { message: "feat: big refactor" } },
        { sha: "c2", commit: { message: "fix: cleanup" } },
      ],
    });

    mockGetCommit
      .mockResolvedValueOnce({
        data: {
          sha: "c1",
          files: files.slice(0, 30).map((f) => ({
            filename: f.filename,
            additions: f.additions,
            deletions: f.deletions,
            changes: f.changes,
          })),
        },
      })
      .mockResolvedValueOnce({
        data: {
          sha: "c2",
          files: files.slice(20).map((f) => ({
            filename: f.filename,
            additions: f.additions,
            deletions: f.deletions,
            changes: f.changes,
          })),
        },
      });

    const { evaluateGate } = await import("../gate.js");
    const result = await evaluateGate(makeConfig(), "abc1234567890", 42);

    expect(result.files).toHaveLength(40);
  });

  it("produces a lower risk score after drift correction", async () => {
    const realFiles = [
      makeFile("dashboard/src/lib/api.ts", 40),
      makeFile("dashboard/src/app/page.tsx", 30),
      makeFile("dashboard/package.json", 20),
      makeFile("dashboard/package-lock.json", 500),
    ];
    const ghostFiles = [
      makeFile("migrations/001_cost_confirmation.sql", 80),
      makeFile(".github/workflows/ci.yml", 15),
      makeFile("src/auth.ts", 50),
      makeFile(".env.example", 10),
      ...Array.from({ length: 60 }, (_, i) => makeFile(`src/other-${i}.ts`, 20)),
    ];

    mockListFiles.mockResolvedValue({ data: [...realFiles, ...ghostFiles] });

    mockListCommits.mockResolvedValue({
      data: [{ sha: "c1", commit: { message: "feat: dashboard" } }],
    });

    mockGetCommit.mockResolvedValue({
      data: {
        sha: "c1",
        files: realFiles.map((f) => ({
          filename: f.filename,
          additions: f.additions,
          deletions: f.deletions,
          changes: f.changes,
        })),
      },
    });

    const { evaluateGate } = await import("../gate.js");
    const result = await evaluateGate(makeConfig(), "abc1234567890", 42);

    expect(result.files).toHaveLength(4);
    // With drift correction the score drops substantially — ghost sensitive
    // files (migrations, auth, .env, CI) are excluded, and churn/file_count
    // reflect only the 4 real files.  The remaining score comes from
    // dependency_changes and author_history.
    expect(result.riskScore).toBeLessThan(80);

    const sensitiveFactors = result.riskFactors.find((f) => f.type === "sensitive_files");
    expect(sensitiveFactors).toBeUndefined();
  });

  it("gracefully falls back to API files when commit enumeration fails", async () => {
    const files = Array.from({ length: 40 }, (_, i) => makeFile(`src/file-${i}.ts`));
    mockListFiles.mockResolvedValue({ data: files });

    mockListCommits.mockResolvedValue({
      data: [{ sha: "c1", commit: { message: "feat" } }],
    });
    mockGetCommit.mockRejectedValue(new Error("API rate limit"));

    const { evaluateGate } = await import("../gate.js");

    const result = await evaluateGate(makeConfig(), "abc1234567890", 42);
    // When commit enumeration fails, we gracefully fall back to the API
    // file list rather than losing data.
    expect(result.files).toHaveLength(40);
    expect(result.riskScore).toBeGreaterThanOrEqual(0);
  });
});
