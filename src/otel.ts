import * as core from "@actions/core";
import * as github from "@actions/github";
import type { GateEvaluation } from "./types.js";

// ---------------------------------------------------------------------------
// Lightweight OTLP/HTTP JSON span exporter (no SDK dependency)
// Conforms to opentelemetry-proto ExportTraceServiceRequest JSON encoding.
// ---------------------------------------------------------------------------

const OTEL_TIMEOUT_MS = 10_000;

function hrTimeNano(): string {
  const ms = Date.now();
  return (BigInt(ms) * 1_000_000n).toString();
}

function generateId(bytes: number): string {
  const hex = "0123456789abcdef";
  let id = "";
  for (let i = 0; i < bytes * 2; i++) {
    id += hex[Math.floor(Math.random() * 16)];
  }
  return id;
}

interface OtelAttribute {
  key: string;
  value: {
    stringValue?: string;
    intValue?: string;
    doubleValue?: number;
    boolValue?: boolean;
  };
}

function strAttr(key: string, value: string): OtelAttribute {
  return { key, value: { stringValue: value } };
}

function intAttr(key: string, value: number): OtelAttribute {
  return { key, value: { intValue: String(value) } };
}

function boolAttr(key: string, value: boolean): OtelAttribute {
  return { key, value: { boolValue: value } };
}

export async function exportOtelSpan(
  evaluation: GateEvaluation,
  endpoint: string,
  headersStr: string,
): Promise<void> {
  const now = hrTimeNano();
  const startNano = (
    BigInt(Date.now() - evaluation.evaluationMs) * 1_000_000n
  ).toString();

  const { owner, repo } = github.context.repo;

  const attributes: OtelAttribute[] = [
    strAttr("trailhead.repo", `${owner}/${repo}`),
    strAttr("trailhead.commit_sha", evaluation.commitSha),
    strAttr("trailhead.decision", evaluation.gateDecision),
    intAttr("trailhead.risk_score", evaluation.riskScore),
    intAttr("trailhead.health_score", evaluation.healthScore),
    intAttr("trailhead.evaluation_ms", evaluation.evaluationMs),
    boolAttr("trailhead.has_report_url", !!evaluation.reportUrl),
  ];

  if (evaluation.prNumber) {
    intAttr("trailhead.pr_number", evaluation.prNumber);
    attributes.push(intAttr("trailhead.pr_number", evaluation.prNumber));
  }

  for (const factor of evaluation.riskFactors) {
    attributes.push(intAttr(`trailhead.factor.${factor.type}`, factor.score));
  }

  if (evaluation.files) {
    attributes.push(intAttr("trailhead.file_count", evaluation.files.length));
  }

  for (const hc of evaluation.healthChecks) {
    attributes.push(strAttr(`trailhead.health.${hc.target}.status`, hc.status));
    attributes.push(intAttr(`trailhead.health.${hc.target}.latency_ms`, hc.latencyMs));
  }

  const statusCode = evaluation.gateDecision === "block" ? 2 : 1;

  const traceId = generateId(16);
  const spanId = generateId(8);

  const payload = {
    resourceSpans: [
      {
        resource: {
          attributes: [
            strAttr("service.name", "trailhead"),
            strAttr("service.version", "2.0.0"),
            strAttr("service.namespace", `${owner}/${repo}`),
          ],
        },
        scopeSpans: [
          {
            scope: { name: "trailhead", version: "2.0.0" },
            spans: [
              {
                traceId,
                spanId,
                name: "trailhead.evaluate",
                kind: 1, // SPAN_KIND_INTERNAL
                startTimeUnixNano: startNano,
                endTimeUnixNano: now,
                attributes,
                status: { code: statusCode },
              },
            ],
          },
        ],
      },
    ],
  };

  const url = endpoint.endsWith("/v1/traces") ? endpoint : `${endpoint}/v1/traces`;

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (headersStr) {
    for (const pair of headersStr.split(",")) {
      const eqIdx = pair.indexOf("=");
      if (eqIdx > 0) {
        headers[pair.substring(0, eqIdx).trim()] = pair.substring(eqIdx + 1).trim();
      }
    }
  }

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(OTEL_TIMEOUT_MS),
    });

    if (response.ok) {
      core.debug(`OTel span exported to ${url} (trace_id=${traceId})`);
    } else {
      core.debug(`OTel export returned ${response.status}: ${await response.text()}`);
    }
  } catch (error) {
    core.debug(`OTel export failed: ${error}`);
  }
}
