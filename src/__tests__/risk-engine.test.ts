import {
  computeRiskScore,
  weightedAverageScores,
  detectDependencyChanges,
  decideGate,
  isTestFile,
  isNonSourceFile,
  isSensitiveFile,
  sensitivityWeight,
  matchesGlobs,
  matchRiskProfile,
  isRollback,
  isInFreezeWindow,
  computeSecurityFactor,
  computeDeploymentHistoryFactor,
  FACTOR_WEIGHTS,
} from "../risk-engine.js";

describe("risk-engine", () => {
  describe("matchesGlobs", () => {
    it("matches simple globs", () => {
      expect(matchesGlobs("src/auth/login.ts", ["src/auth/**"])).toBe(true);
      expect(matchesGlobs("src/utils/helper.ts", ["src/auth/**"])).toBe(false);
    });

    it("matches wildcard file names", () => {
      expect(matchesGlobs("test.spec.ts", ["*.spec.ts"])).toBe(true);
    });
  });

  describe("file classification", () => {
    it("identifies test files", () => {
      expect(isTestFile("src/auth.test.ts")).toBe(true);
      expect(isTestFile("src/__tests__/auth.ts")).toBe(true);
      expect(isTestFile("e2e.cy.ts")).toBe(true);
      expect(isTestFile("src/auth.ts")).toBe(false);
    });

    it("identifies non-source files", () => {
      expect(isNonSourceFile("README.md")).toBe(true);
      expect(isNonSourceFile("data.json")).toBe(true);
      expect(isNonSourceFile("src/main.ts")).toBe(false);
    });

    it("identifies sensitive files", () => {
      expect(isSensitiveFile("src/auth/login.ts")).toBe(true);
      expect(isSensitiveFile("migrations/001.sql")).toBe(true);
      expect(isSensitiveFile("src/payment/stripe.ts")).toBe(true);
      expect(isSensitiveFile("src/utils/helper.ts")).toBe(false);
    });
  });

  describe("sensitivityWeight", () => {
    it("returns default weights without config", () => {
      expect(sensitivityWeight("src/auth/login.ts")).toBe(3);
      expect(sensitivityWeight("migrations/001.sql")).toBe(2);
      expect(sensitivityWeight("src/main.ts")).toBe(1);
      expect(sensitivityWeight("src/main.test.ts")).toBe(0.3);
      expect(sensitivityWeight("README.md")).toBe(0.5);
    });

    it("respects config overrides", () => {
      const config = {
        sensitivity: {
          high: ["src/critical/**"],
          medium: ["src/important/**"],
          low: ["src/trivial/**"],
        },
        ignore: ["dist/**"],
      };
      expect(sensitivityWeight("src/critical/core.ts", config)).toBe(3);
      expect(sensitivityWeight("src/important/utils.ts", config)).toBe(2);
      expect(sensitivityWeight("src/trivial/helper.ts", config)).toBe(0.5);
      expect(sensitivityWeight("dist/index.js", config)).toBe(0);
    });
  });

  describe("computeRiskScore", () => {
    it("returns zero for empty files", () => {
      const result = computeRiskScore([]);
      expect(result.score).toBe(0);
      expect(result.factors).toEqual([]);
    });

    it("computes factors for source files", () => {
      const files = [
        { filename: "src/main.ts", changes: 50 },
        { filename: "src/auth/login.ts", changes: 30 },
      ];
      const result = computeRiskScore(files);
      expect(result.score).toBeGreaterThan(0);
      expect(result.factors.length).toBeGreaterThan(0);
      expect(result.factors.some((f) => f.type === "file_count")).toBe(true);
      expect(result.factors.some((f) => f.type === "code_churn")).toBe(true);
    });

    it("detects sensitive files", () => {
      const files = [
        { filename: "src/auth/login.ts", changes: 10 },
        { filename: "src/payment/stripe.ts", changes: 20 },
      ];
      const result = computeRiskScore(files);
      expect(result.factors.some((f) => f.type === "sensitive_files")).toBe(true);
    });

    it("respects ignore patterns", () => {
      const files = [
        { filename: "src/main.ts", changes: 50 },
        { filename: "dist/index.js", changes: 1000 },
      ];
      const result = computeRiskScore(files, { ignore: ["dist/**"] });
      const churn = result.factors.find((f) => f.type === "code_churn");
      expect((churn?.detail as { totalChanges: number }).totalChanges).toBe(50);
    });
  });

  describe("weightedAverageScores", () => {
    it("returns 0 for empty factors", () => {
      expect(weightedAverageScores([])).toBe(0);
    });

    it("computes weighted average", () => {
      const factors = [
        { type: "code_churn", score: 60 },
        { type: "file_count", score: 40 },
      ];
      const result = weightedAverageScores(factors);
      expect(result).toBeGreaterThan(0);
      expect(result).toBeLessThanOrEqual(100);
    });
  });

  describe("detectDependencyChanges", () => {
    it("returns null when no dep files", () => {
      const files = [{ filename: "src/main.ts", changes: 50 }];
      expect(detectDependencyChanges(files)).toBeNull();
    });

    it("detects package.json dependency section changes", () => {
      const files = [
        {
          filename: "package.json",
          changes: 5,
          patch:
            '@@ -4,7 +4,7 @@\n  "dependencies": {\n-    "zod": "^3.22.0"\n+    "zod": "^3.24.0"\n   }\n',
        },
        { filename: "package-lock.json", changes: 200 },
      ];
      const result = detectDependencyChanges(files);
      expect(result).not.toBeNull();
      expect(result?.type).toBe("dependency_changes");
    });

    it("ignores package.json script/version-only edits", () => {
      const files = [
        {
          filename: "package.json",
          changes: 6,
          patch:
            '@@ -2,8 +2,9 @@\n-  "version": "2.0.0",\n+  "version": "2.1.0",\n   "scripts": {\n+    "playground:pilot": "tsx src/playground/pilot.ts",\n     "test": "vitest"\n   }\n',
        },
      ];
      const result = detectDependencyChanges(files);
      expect(result).toBeNull();
    });
  });

  describe("decideGate", () => {
    it("allows low risk", () => {
      expect(decideGate(30, 100, 70)).toBe("allow");
    });

    it("warns on moderate risk", () => {
      expect(decideGate(60, 100, 70)).toBe("warn");
    });

    it("blocks on high risk", () => {
      expect(decideGate(80, 100, 70)).toBe("block");
    });

    it("warns on low health", () => {
      expect(decideGate(30, 40, 70)).toBe("warn");
    });
  });

  describe("isRollback", () => {
    it("detects revert in title", () => {
      expect(isRollback("Revert 'feat: add login'")).toBe(true);
    });

    it("detects rollback in title", () => {
      expect(isRollback("rollback production deploy")).toBe(true);
    });

    it("returns false for normal title", () => {
      expect(isRollback("feat: add login")).toBe(false);
    });
  });

  describe("isInFreezeWindow", () => {
    it("returns not frozen for empty freeze list", () => {
      expect(isInFreezeWindow([])).toEqual({ frozen: false });
    });

    it("detects freeze on matching day and hour", () => {
      const friday = new Date("2024-01-05T18:00:00Z");
      const result = isInFreezeWindow([{ days: ["friday"], afterHour: 15 }], friday);
      expect(result.frozen).toBe(true);
    });

    it("allows outside freeze window", () => {
      const monday = new Date("2024-01-01T10:00:00Z");
      const result = isInFreezeWindow([{ days: ["friday"], afterHour: 15 }], monday);
      expect(result.frozen).toBe(false);
    });
  });

  describe("computeSecurityFactor", () => {
    it("returns null for zero alerts", () => {
      expect(
        computeSecurityFactor({
          critical: 0,
          high: 0,
          medium: 0,
          low: 0,
          total: 0,
        }),
      ).toBeNull();
    });

    it("scores critical alerts heavily", () => {
      const result = computeSecurityFactor({
        critical: 2,
        high: 0,
        medium: 0,
        low: 0,
        total: 2,
      });
      expect(result?.score).toBe(60);
      expect(result?.type).toBe("security_alerts");
    });

    it("caps at 100", () => {
      const result = computeSecurityFactor({
        critical: 5,
        high: 5,
        medium: 5,
        low: 5,
        total: 20,
      });
      expect(result?.score).toBeLessThanOrEqual(100);
    });
  });

  describe("computeDeploymentHistoryFactor", () => {
    it("returns null for zero total", () => {
      expect(
        computeDeploymentHistoryFactor({
          recentFailures: 0,
          recentTotal: 0,
          lastDeployFailed: false,
          lastRollback: false,
        }),
      ).toBeNull();
    });

    it("returns null for all successful", () => {
      expect(
        computeDeploymentHistoryFactor({
          recentFailures: 0,
          recentTotal: 5,
          lastDeployFailed: false,
          lastRollback: false,
        }),
      ).toBeNull();
    });

    it("scores recent failures", () => {
      const result = computeDeploymentHistoryFactor({
        recentFailures: 2,
        recentTotal: 5,
        lastDeployFailed: false,
        lastRollback: false,
      });
      expect(result?.score).toBe(40);
      expect(result?.type).toBe("deployment_history");
    });

    it("adds rollback penalty", () => {
      const result = computeDeploymentHistoryFactor({
        recentFailures: 1,
        recentTotal: 3,
        lastDeployFailed: false,
        lastRollback: true,
      });
      expect(result?.score).toBe(50);
    });
  });

  describe("FACTOR_WEIGHTS", () => {
    it("includes v3 factor types", () => {
      expect(FACTOR_WEIGHTS.security_alerts).toBe(4);
      expect(FACTOR_WEIGHTS.deployment_history).toBe(2);
      expect(FACTOR_WEIGHTS.canary_status).toBe(2);
    });
  });

  describe("matchRiskProfile", () => {
    it("returns null when no profiles defined", () => {
      expect(matchRiskProfile(["src/main.ts"], [])).toBeNull();
    });

    it("matches a release-shaped profile by files_include", () => {
      const profiles = [
        {
          name: "release",
          match: {
            files_include: ["CHANGELOG.md", "package.json"],
            files_exclude: [],
            min_files: 5,
          },
          weights: { file_count: 1, code_churn: 1 },
        },
      ];
      const files = [
        "CHANGELOG.md",
        "package.json",
        "src/index.ts",
        "src/lib.ts",
        "src/lib.test.ts",
        "src/types.ts",
        "README.md",
      ];
      const result = matchRiskProfile(files, profiles);
      expect(result).not.toBeNull();
      expect(result!.name).toBe("release");
      expect(result!.weights).toEqual({ file_count: 1, code_churn: 1 });
    });

    it("rejects profile when files_include patterns are not all present", () => {
      const profiles = [
        {
          name: "release",
          match: {
            files_include: ["CHANGELOG.md", "package.json"],
            files_exclude: [],
          },
          weights: { file_count: 1 },
        },
      ];
      const result = matchRiskProfile(["CHANGELOG.md", "src/index.ts"], profiles);
      expect(result).toBeNull();
    });

    it("rejects profile when files_exclude patterns match", () => {
      const profiles = [
        {
          name: "safe-release",
          match: {
            files_include: ["CHANGELOG.md"],
            files_exclude: ["**/migrations/**"],
          },
          weights: { file_count: 1 },
        },
      ];
      const files = ["CHANGELOG.md", "package.json", "supabase/migrations/001.sql"];
      const result = matchRiskProfile(files, profiles);
      expect(result).toBeNull();
    });

    it("rejects profile when file count is below min_files", () => {
      const profiles = [
        {
          name: "large-release",
          match: { files_include: [], files_exclude: [], min_files: 10 },
          weights: { file_count: 0.5 },
        },
      ];
      const result = matchRiskProfile(["src/a.ts", "src/b.ts"], profiles);
      expect(result).toBeNull();
    });

    it("rejects profile when file count exceeds max_files", () => {
      const profiles = [
        {
          name: "small-only",
          match: { files_include: [], files_exclude: [], max_files: 3 },
          weights: { code_churn: 0.5 },
        },
      ];
      const files = ["a.ts", "b.ts", "c.ts", "d.ts"];
      const result = matchRiskProfile(files, profiles);
      expect(result).toBeNull();
    });

    it("returns the first matching profile when multiple could match", () => {
      const profiles = [
        {
          name: "first",
          match: { files_include: [], files_exclude: [], min_files: 2 },
          weights: { file_count: 1 },
        },
        {
          name: "second",
          match: { files_include: [], files_exclude: [], min_files: 2 },
          weights: { file_count: 0.5 },
        },
      ];
      const result = matchRiskProfile(["a.ts", "b.ts", "c.ts"], profiles);
      expect(result!.name).toBe("first");
    });

    it("matches profile with no constraints (empty include/exclude, no min/max)", () => {
      const profiles = [
        {
          name: "catch-all",
          match: { files_include: [], files_exclude: [] },
          weights: { code_churn: 0.5 },
        },
      ];
      const result = matchRiskProfile(["src/main.ts"], profiles);
      expect(result!.name).toBe("catch-all");
    });
  });
});
