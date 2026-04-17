import { describe, it, expect } from "vitest";
import crypto from "node:crypto";

/**
 * Tests for the GitHub App handler (app/src/handler.ts).
 * Since app/ is a separate TypeScript project, we test the core logic
 * by re-implementing and testing the pure functions directly.
 */

// ---------------------------------------------------------------------------
// verifySignature — re-implemented from app/src/handler.ts
// ---------------------------------------------------------------------------

function verifySignature(payload: string, signature: string, secret: string): boolean {
  if (!secret || !signature) return !secret;
  const expected = `sha256=${crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("hex")}`;
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

function createSignature(payload: string, secret: string): string {
  return `sha256=${crypto.createHmac("sha256", secret).update(payload).digest("hex")}`;
}

describe("App: verifySignature", () => {
  const secret = "test-webhook-secret-12345";
  const payload = JSON.stringify({ action: "requested", environment: "production" });

  it("accepts valid signature", () => {
    const sig = createSignature(payload, secret);
    expect(verifySignature(payload, sig, secret)).toBe(true);
  });

  it("rejects invalid signature", () => {
    expect(verifySignature(payload, "sha256=badhex", secret)).toBe(false);
  });

  it("rejects tampered payload", () => {
    const sig = createSignature(payload, secret);
    expect(verifySignature(payload + "tampered", sig, secret)).toBe(false);
  });

  it("returns true when no secret is configured (open mode)", () => {
    expect(verifySignature(payload, "", "")).toBe(true);
  });

  it("returns false when secret is set but signature is missing", () => {
    expect(verifySignature(payload, "", secret)).toBe(false);
  });

  it("handles mismatched length signatures without throwing", () => {
    expect(verifySignature(payload, "sha256=short", secret)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Deployment protection rule payload handling
// ---------------------------------------------------------------------------

import { computeRiskScore, decideGate, type FileInfo } from "../risk-engine.js";

describe("App: risk scoring integration", () => {
  it("scores an empty file list as zero risk", () => {
    const { score } = computeRiskScore([]);
    expect(score).toBe(0);
    expect(decideGate(score, 100, 70, 55)).toBe("allow");
  });

  it("uses per-environment threshold overrides", () => {
    const files: FileInfo[] = [
      { filename: "src/auth/login.ts", changes: 80 },
      { filename: "src/payment/billing.ts", changes: 60 },
    ];
    const { score } = computeRiskScore(files);

    const productionThreshold = 50;
    const stagingThreshold = 80;

    const prodDecision = decideGate(
      score,
      100,
      productionThreshold,
      productionThreshold - 15,
    );
    const stagingDecision = decideGate(
      score,
      100,
      stagingThreshold,
      stagingThreshold - 15,
    );

    expect(prodDecision).toBe("block");
    expect(["allow", "warn"]).toContain(stagingDecision);
  });

  it("formats factor summary correctly", () => {
    const files: FileInfo[] = [
      { filename: "src/main.ts", changes: 50 },
      { filename: "src/auth/login.ts", changes: 30 },
    ];
    const { factors } = computeRiskScore(files);
    const factorSummary = factors
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map((f) => `${f.type.replace(/_/g, " ")}: ${f.score}/100`)
      .join(", ");
    expect(factorSummary.length).toBeGreaterThan(0);
    expect(factorSummary).toContain("/100");
  });
});

// ---------------------------------------------------------------------------
// Rollback payload parsing
// ---------------------------------------------------------------------------

describe("App: Vercel payload parsing", () => {
  function parseVercelPayload(raw: unknown): {
    deploymentId: string;
    environment: string;
    status: string;
  } | null {
    try {
      const payload = raw as {
        payload?: {
          deployment?: { id?: string };
          deploymentId?: string;
          target?: string;
          readyState?: string;
          state?: string;
        };
      };
      const dep = payload.payload;
      if (!dep) return null;

      const deploymentId = dep.deployment?.id ?? dep.deploymentId ?? "unknown";
      const environment = dep.target ?? "preview";
      const readyState = dep.readyState ?? dep.state;
      let status: string;
      if (readyState === "READY") status = "success";
      else if (readyState === "ERROR") status = "failure";
      else if (readyState === "CANCELED") status = "cancelled";
      else return null;

      return { deploymentId: String(deploymentId), environment, status };
    } catch {
      return null;
    }
  }

  it("parses a successful Vercel deployment", () => {
    const result = parseVercelPayload({
      type: "deployment",
      payload: {
        deployment: { id: "dpl_123" },
        target: "production",
        readyState: "READY",
      },
    });
    expect(result).toEqual({
      deploymentId: "dpl_123",
      environment: "production",
      status: "success",
    });
  });

  it("parses a failed Vercel deployment", () => {
    const result = parseVercelPayload({
      payload: { deploymentId: "dpl_fail", readyState: "ERROR", target: "production" },
    });
    expect(result).toEqual({
      deploymentId: "dpl_fail",
      environment: "production",
      status: "failure",
    });
  });

  it("returns null for unrecognized readyState", () => {
    expect(
      parseVercelPayload({ payload: { readyState: "BUILDING", target: "production" } }),
    ).toBeNull();
  });

  it("returns null for missing payload", () => {
    expect(parseVercelPayload({})).toBeNull();
  });

  it("defaults environment to preview", () => {
    const result = parseVercelPayload({
      payload: { deployment: { id: "dpl_1" }, readyState: "READY" },
    });
    expect(result?.environment).toBe("preview");
  });
});

describe("App: Generic payload parsing", () => {
  function parseGenericPayload(raw: unknown): {
    deploymentId: string;
    environment: string;
    status: string;
  } | null {
    try {
      const obj = raw as Record<string, unknown>;
      const statusRaw = String(obj.status ?? "").toLowerCase();
      let status: string;
      if (["success", "ready", "succeeded", "active"].includes(statusRaw))
        status = "success";
      else if (["failure", "error", "failed", "crashed"].includes(statusRaw))
        status = "failure";
      else if (["cancelled", "canceled", "skipped"].includes(statusRaw))
        status = "cancelled";
      else return null;

      return {
        deploymentId: String(obj.id ?? obj.deployment_id ?? "unknown"),
        environment: String(obj.environment ?? "unknown"),
        status,
      };
    } catch {
      return null;
    }
  }

  it("parses success variants", () => {
    for (const status of ["success", "ready", "succeeded", "active"]) {
      const result = parseGenericPayload({ id: "1", environment: "prod", status });
      expect(result?.status).toBe("success");
    }
  });

  it("parses failure variants", () => {
    for (const status of ["failure", "error", "failed", "crashed"]) {
      const result = parseGenericPayload({ id: "1", environment: "prod", status });
      expect(result?.status).toBe("failure");
    }
  });

  it("parses cancellation variants", () => {
    for (const status of ["cancelled", "canceled", "skipped"]) {
      const result = parseGenericPayload({ id: "1", environment: "prod", status });
      expect(result?.status).toBe("cancelled");
    }
  });

  it("returns null for unknown status", () => {
    expect(parseGenericPayload({ id: "1", status: "pending" })).toBeNull();
  });

  it("uses deployment_id fallback", () => {
    const result = parseGenericPayload({
      deployment_id: "dep-42",
      environment: "staging",
      status: "success",
    });
    expect(result?.deploymentId).toBe("dep-42");
  });
});
