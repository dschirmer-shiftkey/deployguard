import { describe, it, expect } from "vitest";
import {
  extractMajorVersion,
  isMajorVersionBump,
  parsePkgJsonDiff,
  scorePackageChanges,
  analyseSupplyChain,
} from "../supply-chain.js";

// ---------------------------------------------------------------------------
// extractMajorVersion
// ---------------------------------------------------------------------------
describe("extractMajorVersion", () => {
  it("parses caret range", () => {
    expect(extractMajorVersion("^1.2.3")).toBe(1);
  });
  it("parses tilde range", () => {
    expect(extractMajorVersion("~2.0.0")).toBe(2);
  });
  it("parses exact version", () => {
    expect(extractMajorVersion("3.4.5")).toBe(3);
  });
  it("parses gte range", () => {
    expect(extractMajorVersion(">=4.0.0")).toBe(4);
  });
  it("returns null for wildcard", () => {
    expect(extractMajorVersion("*")).toBeNull();
  });
  it("returns null for workspace protocol", () => {
    expect(extractMajorVersion("workspace:*")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// isMajorVersionBump
// ---------------------------------------------------------------------------
describe("isMajorVersionBump", () => {
  it("detects major bump", () => {
    expect(isMajorVersionBump("^1.2.3", "^2.0.0")).toBe(true);
  });
  it("ignores minor bump", () => {
    expect(isMajorVersionBump("^1.0.0", "^1.5.0")).toBe(false);
  });
  it("ignores same major", () => {
    expect(isMajorVersionBump("^2.0.0", "^2.1.0")).toBe(false);
  });
  it("ignores downgrade", () => {
    expect(isMajorVersionBump("^3.0.0", "^2.0.0")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parsePkgJsonDiff
// ---------------------------------------------------------------------------
describe("parsePkgJsonDiff", () => {
  const patchAddPackage = `
--- a/package.json
+++ b/package.json
@@ -10,6 +10,8 @@
   "dependencies": {
     "express": "^4.18.0",
+    "axios": "^1.0.0",
+    "stripe": "^12.0.0",
     "lodash": "^4.17.21"
   }
 }
`;

  const patchMajorBump = `
--- a/package.json
+++ b/package.json
@@ -5,7 +5,7 @@
   "dependencies": {
-    "express": "^4.18.0",
+    "express": "^5.0.0",
     "lodash": "^4.17.21"
   }
 }
`;

  const patchRemovePackage = `
--- a/package.json
+++ b/package.json
@@ -5,7 +5,6 @@
   "dependencies": {
-    "express": "^4.18.0",
     "lodash": "^4.17.21"
   }
 }
`;

  it("detects newly added packages", () => {
    const changes = parsePkgJsonDiff(patchAddPackage);
    const names = changes.map((c) => c.name);
    expect(names).toContain("axios");
    expect(names).toContain("stripe");
    expect(changes.find((c) => c.name === "axios")?.changeType).toBe("added");
  });

  it("marks stripe as critical scope", () => {
    const changes = parsePkgJsonDiff(patchAddPackage);
    const stripe = changes.find((c) => c.name === "stripe");
    expect(stripe?.isCriticalScope).toBe(true);
  });

  it("detects major version bump", () => {
    const changes = parsePkgJsonDiff(patchMajorBump);
    const express = changes.find((c) => c.name === "express");
    expect(express?.changeType).toBe("updated");
    expect(express?.isMajorBump).toBe(true);
    expect(express?.fromVersion).toBe("^4.18.0");
    expect(express?.toVersion).toBe("^5.0.0");
  });

  it("detects removed package", () => {
    const changes = parsePkgJsonDiff(patchRemovePackage);
    const express = changes.find((c) => c.name === "express");
    expect(express?.changeType).toBe("removed");
    expect(express?.toVersion).toBeNull();
  });

  it("returns empty array for lockfile-only diff", () => {
    const lockPatch = `
--- a/package-lock.json
+++ b/package-lock.json
@@ -1,5 +1,5 @@
-  "version": "1.0.0",
+  "version": "1.0.1",
`;
    const changes = parsePkgJsonDiff(lockPatch);
    expect(changes).toHaveLength(0);
  });

  it("flags suspicious typosquat name", () => {
    const patch = `
--- a/package.json
+++ b/package.json
@@ -5,6 +5,7 @@
   "dependencies": {
+    "axois": "^1.0.0",
     "lodash": "^4.17.21"
   }
 }
`;
    const changes = parsePkgJsonDiff(patch);
    const axois = changes.find((c) => c.name === "axois");
    expect(axois?.isSuspiciousName).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// scorePackageChanges
// ---------------------------------------------------------------------------
describe("scorePackageChanges", () => {
  it("scores zero for empty list", () => {
    expect(scorePackageChanges([]).score).toBe(0);
  });

  it("adds risk for each new package", () => {
    const pkg = {
      name: "some-package",
      fromVersion: null,
      toVersion: "^1.0.0",
      changeType: "added" as const,
      isMajorBump: false,
      isCriticalScope: false,
      isSuspiciousName: false,
    };
    const { score } = scorePackageChanges([pkg]);
    expect(score).toBeGreaterThan(0);
  });

  it("assigns high score for suspicious package", () => {
    const pkg = {
      name: "axois",
      fromVersion: null,
      toVersion: "^1.0.0",
      changeType: "added" as const,
      isMajorBump: false,
      isCriticalScope: false,
      isSuspiciousName: true,
    };
    const { score, signals } = scorePackageChanges([pkg]);
    expect(score).toBeGreaterThanOrEqual(30);
    expect(signals.some((s) => s.includes("typosquat"))).toBe(true);
  });

  it("caps at 100", () => {
    const pkgs = Array.from({ length: 20 }, (_, i) => ({
      name: `pkg-${i}`,
      fromVersion: null,
      toVersion: "^1.0.0",
      changeType: "added" as const,
      isMajorBump: false,
      isCriticalScope: true,
      isSuspiciousName: true,
    }));
    const { score } = scorePackageChanges(pkgs);
    expect(score).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// analyseSupplyChain
// ---------------------------------------------------------------------------
describe("analyseSupplyChain", () => {
  it("returns null for null patch", () => {
    expect(analyseSupplyChain(null)).toBeNull();
  });

  it("returns null when no package changes found", () => {
    expect(analyseSupplyChain("diff --git a/readme.md")).toBeNull();
  });

  it("returns analysis with counts and score", () => {
    const patch = `
--- a/package.json
+++ b/package.json
@@ -5,6 +5,8 @@
   "dependencies": {
+    "stripe": "^12.0.0",
+    "new-pkg": "^1.0.0",
-    "old-pkg": "^2.0.0",
     "lodash": "^4.17.21"
   }
 }
`;
    const result = analyseSupplyChain(patch);
    expect(result).not.toBeNull();
    expect(result!.addedCount).toBe(2);
    expect(result!.removedCount).toBe(1);
    expect(result!.criticalScopeCount).toBe(1); // stripe
    expect(result!.riskScore).toBeGreaterThan(0);
    expect(result!.riskSignals.length).toBeGreaterThan(0);
  });
});
