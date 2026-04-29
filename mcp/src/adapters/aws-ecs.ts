import type { HealthCheckAdapter, HealthCheckResult } from "./types.js";

const TIMEOUT_MS = 10_000;

export const awsEcsAdapter: HealthCheckAdapter = {
  name: "aws-ecs",

  detect(): boolean {
    return !!(
      process.env.AWS_ECS_CLUSTER &&
      process.env.AWS_ECS_SERVICE &&
      process.env.AWS_REGION
    );
  },

  async check(): Promise<HealthCheckResult> {
    const cluster = process.env.AWS_ECS_CLUSTER ?? "";
    const service = process.env.AWS_ECS_SERVICE ?? "";
    const region = process.env.AWS_REGION ?? "";
    const accessKey = process.env.AWS_ACCESS_KEY_ID;
    const secretKey = process.env.AWS_SECRET_ACCESS_KEY;

    const start = Date.now();

    if (!accessKey || !secretKey) {
      return {
        target: `ecs:${cluster}/${service}`,
        status: "degraded",
        latencyMs: Date.now() - start,
        detail: {
          provider: "aws-ecs",
          error: "Missing AWS_ACCESS_KEY_ID or AWS_SECRET_ACCESS_KEY",
        },
      };
    }

    try {
      const endpoint = `https://ecs.${region}.amazonaws.com`;
      const body = JSON.stringify({
        cluster,
        services: [service],
      });

      const amzDate = new Date()
        .toISOString()
        .replace(/[-:]/g, "")
        .replace(/\.\d{3}/, "");
      const dateStamp = amzDate.substring(0, 8);

      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-amz-json-1.1",
          "X-Amz-Target": "AmazonEC2ContainerServiceV20141113.DescribeServices",
          "X-Amz-Date": amzDate,
          Host: `ecs.${region}.amazonaws.com`,
          Authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${dateStamp}/${region}/ecs/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-target, Signature=placeholder`,
        },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const latencyMs = Date.now() - start;

      if (!response.ok) {
        return {
          target: `ecs:${cluster}/${service}`,
          status: "degraded",
          latencyMs,
          detail: {
            provider: "aws-ecs",
            httpStatus: response.status,
            note: "Full SigV4 signing required in production — use AWS SDK",
          },
        };
      }

      const data = (await response.json()) as {
        services?: Array<{
          status?: string;
          runningCount?: number;
          desiredCount?: number;
          deployments?: Array<{ status: string; runningCount: number }>;
        }>;
      };

      const svc = data.services?.[0];
      if (!svc) {
        return {
          target: `ecs:${cluster}/${service}`,
          status: "degraded",
          latencyMs,
          detail: { provider: "aws-ecs", error: "Service not found" },
        };
      }

      const running = svc.runningCount ?? 0;
      const desired = svc.desiredCount ?? 0;
      const allRunning = running >= desired && desired > 0;

      return {
        target: `ecs:${cluster}/${service}`,
        status: allRunning ? "healthy" : running > 0 ? "degraded" : "down",
        latencyMs,
        detail: {
          provider: "aws-ecs",
          serviceStatus: svc.status,
          runningCount: running,
          desiredCount: desired,
          deployments: svc.deployments?.length ?? 0,
        },
      };
    } catch (error) {
      return {
        target: `ecs:${cluster}/${service}`,
        status: "down",
        latencyMs: Date.now() - start,
        detail: { error: String(error), provider: "aws-ecs" },
      };
    }
  },
};
