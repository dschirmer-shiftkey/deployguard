import { describe, it, expect } from "vitest";
import { parseVercelWebhook, parseGenericWebhook } from "../canary.js";

describe("parseVercelWebhook", () => {
  it("parses a successful Vercel deployment", () => {
    const payload = {
      id: "hook_123",
      type: "deployment.ready",
      payload: {
        deploymentId: "dep_abc",
        target: "production",
        readyState: "READY",
        url: "my-app-123.vercel.app",
        createdAt: 1700000000000,
        ready: 1700000060000,
      },
    };

    const result = parseVercelWebhook(payload);
    expect(result).not.toBeNull();
    expect(result?.status).toBe("success");
    expect(result?.environment).toBe("production");
    expect(result?.durationMs).toBe(60000);
    expect(result?.source).toBe("vercel");
  });

  it("parses a failed Vercel deployment", () => {
    const payload = {
      id: "hook_456",
      payload: {
        deploymentId: "dep_def",
        target: "production",
        readyState: "ERROR",
      },
    };

    const result = parseVercelWebhook(payload);
    expect(result?.status).toBe("failure");
  });

  it("parses a cancelled Vercel deployment", () => {
    const payload = {
      payload: {
        deploymentId: "dep_ghi",
        target: "preview",
        readyState: "CANCELED",
      },
    };

    const result = parseVercelWebhook(payload);
    expect(result?.status).toBe("cancelled");
    expect(result?.environment).toBe("preview");
  });

  it("returns null for in-progress deployments", () => {
    const payload = {
      payload: {
        readyState: "BUILDING",
      },
    };

    expect(parseVercelWebhook(payload)).toBeNull();
  });

  it("returns null for missing payload", () => {
    expect(parseVercelWebhook({})).toBeNull();
  });
});

describe("parseGenericWebhook", () => {
  it("parses a successful generic deployment", () => {
    const payload = {
      deployment: {
        state: "success",
        environment: "staging",
        url: "https://staging.example.com",
      },
      id: "deploy-123",
    };

    const config = {
      webhook_type: "generic" as const,
      field_map: {
        status: "$.deployment.state",
        environment: "$.deployment.environment",
        url: "$.deployment.url",
        deployment_id: "$.id",
      },
      rollback_on_failure: false,
    };

    const result = parseGenericWebhook(payload, config);
    expect(result).not.toBeNull();
    expect(result?.status).toBe("success");
    expect(result?.environment).toBe("staging");
    expect(result?.deploymentId).toBe("deploy-123");
    expect(result?.source).toBe("generic");
  });

  it("parses a failed generic deployment", () => {
    const payload = {
      status: "failed",
      environment: "production",
    };

    const config = {
      webhook_type: "generic" as const,
      field_map: {
        status: "$.status",
        environment: "$.environment",
      },
      rollback_on_failure: false,
    };

    const result = parseGenericWebhook(payload, config);
    expect(result?.status).toBe("failure");
  });

  it("returns null without field_map", () => {
    const config = {
      webhook_type: "generic" as const,
      rollback_on_failure: false,
    };

    expect(parseGenericWebhook({}, config)).toBeNull();
  });

  it("returns null for unknown status values", () => {
    const payload = { status: "pending" };

    const config = {
      webhook_type: "generic" as const,
      field_map: { status: "$.status" },
      rollback_on_failure: false,
    };

    expect(parseGenericWebhook(payload, config)).toBeNull();
  });
});
