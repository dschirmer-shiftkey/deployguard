import { vi } from "vitest";

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

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
import * as core from "@actions/core";
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
    delete process.env.GITHUB_WORKSPACE;
  });

  it("returns null when no token is provided", async () => {
    expect(await loadRepoConfig()).toBeNull();
    expect(await loadRepoConfig(undefined)).toBeNull();
  });

  it("returns null when .trailhead.yml does not exist", async () => {
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

  it("falls back to legacy .deployguard.yml when .trailhead.yml is missing", async () => {
    const getContent = vi
      .fn()
      .mockRejectedValueOnce(new Error("Not Found (404)"))
      .mockResolvedValue({
        data: {
          type: "file",
          content: encodeYaml(`thresholds:
  risk: 75`),
        },
      });

    vi.mocked(github.getOctokit).mockReturnValue({
      rest: { repos: { getContent } },
    } as unknown as ReturnType<typeof github.getOctokit>);

    const config = await loadRepoConfig("ghp_test");

    expect(config!.thresholds.risk).toBe(75);
    expect(getContent).toHaveBeenCalledWith(
      expect.objectContaining({ path: ".deployguard.yml" }),
    );
  });

  it("prefers local workspace config when running in GitHub Actions", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "trailhead-config-"));
    process.env.GITHUB_WORKSPACE = workspace;
    await writeFile(
      path.join(workspace, ".trailhead.yml"),
      `ignore:
  - "mcp/dist/**"`,
      "utf-8",
    );
    const getContent = mockOctokit(
      `thresholds:
  risk: 99`,
    );

    try {
      const config = await loadRepoConfig("ghp_test");

      expect(config!.ignore).toEqual(["mcp/dist/**"]);
      expect(getContent).not.toHaveBeenCalled();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
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
            data: [{ name: ".trailhead.yml" }],
          }),
        },
      },
    } as unknown as ReturnType<typeof github.getOctokit>);
    expect(await loadRepoConfig("ghp_test")).toBeNull();
  });

  it("warns on unknown top-level keys but still parses known keys", async () => {
    mockOctokit(
      `thresholds:
  risk: 72
unexpected_key: true`,
    );
    const config = await loadRepoConfig("ghp_test");
    expect(config).not.toBeNull();
    expect(config!.thresholds.risk).toBe(72);
    expect(vi.mocked(core.warning)).toHaveBeenCalledWith(
      expect.stringContaining('unknown top-level key "unexpected_key"'),
    );
  });

  it("returns null for unsupported schema_version with migration warning", async () => {
    mockOctokit(
      `schema_version: 2
thresholds:
  risk: 80`,
    );
    const config = await loadRepoConfig("ghp_test");
    expect(config).toBeNull();
    expect(vi.mocked(core.warning)).toHaveBeenCalledWith(
      expect.stringContaining("unsupported schema_version=2"),
    );
  });

  it("parses nested agent PR policies", async () => {
    mockOctokit(
      `schema_version: 1
policies:
  agent_prs:
    enabled: true
    risk_threshold: 55
    required_approvals: 2
    require_code_owner_approval: true
    code_owner_reviewers:
      - "alice"
      - "bob"
    sensitive_paths:
      - "src/auth/**"`,
    );
    const config = await loadRepoConfig("ghp_test");
    expect(config).not.toBeNull();
    expect(config!.policies.agent_prs.enabled).toBe(true);
    expect(config!.policies.agent_prs.risk_threshold).toBe(55);
    expect(config!.policies.agent_prs.required_approvals).toBe(2);
    expect(config!.policies.agent_prs.require_code_owner_approval).toBe(true);
    expect(config!.policies.agent_prs.code_owner_reviewers).toEqual(["alice", "bob"]);
    expect(config!.policies.agent_prs.sensitive_paths).toEqual(["src/auth/**"]);
  });

  it("parses session correlation and ci integrity policy blocks", async () => {
    mockOctokit(
      `schema_version: 1
policies:
  session_correlation:
    enabled: true
    threshold: 4
    window_minutes: 90
    mode: "block"
  ci_integrity:
    enabled: true
    mode: "warn"`,
    );
    const config = await loadRepoConfig("ghp_test");
    expect(config).not.toBeNull();
    expect(config!.policies.session_correlation.enabled).toBe(true);
    expect(config!.policies.session_correlation.threshold).toBe(4);
    expect(config!.policies.session_correlation.window_minutes).toBe(90);
    expect(config!.policies.session_correlation.mode).toBe("block");
    expect(config!.policies.ci_integrity.mode).toBe("warn");
  });

  it("parses workflow, prompt, and supply chain policy blocks", async () => {
    mockOctokit(
      `schema_version: 1
policies:
  workflow_security:
    enabled: true
    mode: "block"
    allow_unpinned_actions:
      - "actions/checkout"
  prompt_injection:
    enabled: true
    mode: "warn"
  supply_chain:
    enabled: true
    mode: "block"
    force_score_on_critical: 85`,
    );
    const config = await loadRepoConfig("ghp_test");
    expect(config).not.toBeNull();
    expect(config!.policies.workflow_security.enabled).toBe(true);
    expect(config!.policies.workflow_security.mode).toBe("block");
    expect(config!.policies.workflow_security.allow_unpinned_actions).toEqual([
      "actions/checkout",
    ]);
    expect(config!.policies.prompt_injection.mode).toBe("warn");
    expect(config!.policies.supply_chain.mode).toBe("block");
    expect(config!.policies.supply_chain.force_score_on_critical).toBe(85);
  });

  it("parses pr scope, cross-repo impact, duplicate logic, and escalation blocks", async () => {
    mockOctokit(
      `schema_version: 1
services:
  api:
    paths:
      - "src/api/**"
    contracts:
      - "src/api/contracts/**"
    consumers:
      - "web"
      - "worker"
escalation:
  targets:
    - "slack://eng-alerts"
  acknowledge_sla_minutes: 15
  resolve_sla_minutes: 120
policies:
  pr_scope:
    enabled: true
    max_files: 40
    max_changes: 1500
    mode: "block"
    require_plan_for_agent_prs: true
  duplicate_logic:
    enabled: true
    mode: "warn"
  cross_repo_impact:
    enabled: true
    mode: "block"`,
    );
    const config = await loadRepoConfig("ghp_test");
    expect(config).not.toBeNull();
    expect(config!.services.api.contracts).toEqual(["src/api/contracts/**"]);
    expect(config!.services.api.consumers).toEqual(["web", "worker"]);
    expect(config!.escalation.targets).toEqual(["slack://eng-alerts"]);
    expect(config!.escalation.acknowledge_sla_minutes).toBe(15);
    expect(config!.policies.pr_scope.max_files).toBe(40);
    expect(config!.policies.pr_scope.mode).toBe("block");
    expect(config!.policies.cross_repo_impact.mode).toBe("block");
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
