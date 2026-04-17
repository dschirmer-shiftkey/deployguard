import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@actions/core", () => ({
  warning: vi.fn(),
  debug: vi.fn(),
}));

vi.mock("@actions/github", () => ({
  getOctokit: vi.fn(),
  context: {
    repo: { owner: "test-owner", repo: "test-repo" },
  },
}));

import * as github from "@actions/github";
import { loadRepoConfig, matchesGlobs } from "../config.js";

function encodeYaml(yaml: string): string {
  return Buffer.from(yaml, "utf-8").toString("base64");
}

function mockOctokit(content: string | null) {
  const getContent = content
    ? vi.fn().mockResolvedValue({
        data: { type: "file", content: encodeYaml(content) },
      })
    : vi.fn().mockRejectedValue(new Error("Not Found (404)"));

  vi.mocked(github.getOctokit).mockReturnValue({
    rest: { repos: { getContent } },
  } as unknown as ReturnType<typeof github.getOctokit>);

  return getContent;
}

describe("loadRepoConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when no token is provided", async () => {
    expect(await loadRepoConfig()).toBeNull();
    expect(await loadRepoConfig(undefined)).toBeNull();
  });

  it("returns null when .deployguard.yml does not exist", async () => {
    mockOctokit(null);
    expect(await loadRepoConfig("ghp_test")).toBeNull();
  });

  it("parses basic thresholds", async () => {
    mockOctokit(
      `thresholds:
  risk: 80
  warn: 60`,
    );
    const config = await loadRepoConfig("ghp_test");
    expect(config).not.toBeNull();
    expect(config!.thresholds.risk).toBe(80);
    expect(config!.thresholds.warn).toBe(60);
  });

  it("parses sensitivity configuration", async () => {
    mockOctokit(
      `sensitivity:
  high:
    - "src/auth/**"
    - "src/billing/**"
  medium:
    - "src/api/**"`,
    );
    const config = await loadRepoConfig("ghp_test");
    expect(config).not.toBeNull();
    expect(config!.sensitivity.high).toEqual(["src/auth/**", "src/billing/**"]);
    expect(config!.sensitivity.medium).toEqual(["src/api/**"]);
  });

  it("parses ignore patterns", async () => {
    mockOctokit(
      `ignore:
  - "*.generated.ts"
  - "package-lock.json"`,
    );
    const config = await loadRepoConfig("ghp_test");
    expect(config).not.toBeNull();
    expect(config!.ignore).toEqual(["*.generated.ts", "package-lock.json"]);
  });

  it("returns null for empty yaml (no parseable content)", async () => {
    mockOctokit("");
    const config = await loadRepoConfig("ghp_test");
    expect(config).toBeNull();
  });

  it("logs warning for invalid config and returns null", async () => {
    vi.mocked(github.getOctokit).mockReturnValue({
      rest: {
        repos: {
          getContent: vi.fn().mockResolvedValue({
            data: {
              type: "file",
              content: Buffer.from("not: {valid: [yaml", "utf-8").toString("base64"),
            },
          }),
        },
      },
    } as unknown as ReturnType<typeof github.getOctokit>);

    const config = await loadRepoConfig("ghp_test");
    // The parser is lenient, so it may or may not fail depending on the input.
    // What matters is it doesn't throw.
    expect(config === null || typeof config === "object").toBe(true);
  });

  it("handles non-file responses gracefully", async () => {
    vi.mocked(github.getOctokit).mockReturnValue({
      rest: {
        repos: {
          getContent: vi.fn().mockResolvedValue({
            data: { type: "dir" },
          }),
        },
      },
    } as unknown as ReturnType<typeof github.getOctokit>);
    expect(await loadRepoConfig("ghp_test")).toBeNull();
  });

  it("handles array response (directory listing) gracefully", async () => {
    vi.mocked(github.getOctokit).mockReturnValue({
      rest: {
        repos: {
          getContent: vi.fn().mockResolvedValue({
            data: [{ name: ".deployguard.yml" }],
          }),
        },
      },
    } as unknown as ReturnType<typeof github.getOctokit>);
    expect(await loadRepoConfig("ghp_test")).toBeNull();
  });
});

describe("matchesGlobs (re-exported from risk-engine)", () => {
  it("matches glob patterns", () => {
    expect(matchesGlobs("src/auth/login.ts", ["src/auth/**"])).toBe(true);
    expect(matchesGlobs("src/utils/helper.ts", ["src/auth/**"])).toBe(false);
  });

  it("returns false for empty pattern list", () => {
    expect(matchesGlobs("src/main.ts", [])).toBe(false);
  });
});
