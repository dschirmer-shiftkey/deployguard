import * as core from "@actions/core";
import * as github from "@actions/github";
import type { SecurityConfig } from "./types.js";
import {
  computeSecurityFactor,
  type SecurityAlertCounts,
  type RiskFactorResult,
} from "./risk-engine.js";

// ---------------------------------------------------------------------------
// Code Scanning alert types
// ---------------------------------------------------------------------------

interface CodeScanningAlert {
  number: number;
  state: string;
  rule: {
    id: string;
    severity: string;
    description: string;
    security_severity_level?: string;
  };
  tool: {
    name: string;
  };
  most_recent_instance: {
    ref: string;
    state: string;
    location?: {
      path: string;
      start_line: number;
    };
  };
}

type SeverityLevel =
  | "critical"
  | "high"
  | "medium"
  | "low"
  | "warning"
  | "note"
  | "error";

const SEVERITY_ORDER: Record<string, number> = {
  critical: 0,
  error: 1,
  high: 1,
  warning: 2,
  medium: 2,
  note: 3,
  low: 3,
};

function normalizeSeverity(alert: CodeScanningAlert): SeverityLevel {
  const secLevel = alert.rule.security_severity_level;
  if (secLevel && secLevel in SEVERITY_ORDER) return secLevel as SeverityLevel;

  const ruleSev = alert.rule.severity;
  if (ruleSev && ruleSev in SEVERITY_ORDER) return ruleSev as SeverityLevel;

  return "medium";
}

function severityToBucket(
  severity: SeverityLevel,
): keyof Omit<SecurityAlertCounts, "total" | "topRules"> {
  switch (severity) {
    case "critical":
      return "critical";
    case "error":
    case "high":
      return "high";
    case "warning":
    case "medium":
      return "medium";
    case "note":
    case "low":
      return "low";
    default:
      return "medium";
  }
}

// ---------------------------------------------------------------------------
// Fetch alerts from GitHub Code Scanning API
// ---------------------------------------------------------------------------

export async function fetchCodeScanningAlerts(
  token: string,
  config?: SecurityConfig | null,
): Promise<SecurityAlertCounts> {
  const empty: SecurityAlertCounts = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    total: 0,
    topRules: [],
  };

  try {
    const octokit = github.getOctokit(token);
    const { owner, repo } = github.context.repo;

    const { data: alerts } = (await octokit.request(
      "GET /repos/{owner}/{repo}/code-scanning/alerts",
      {
        owner,
        repo,
        state: "open",
        per_page: 100,
      },
    )) as { data: CodeScanningAlert[] };

    if (!alerts || alerts.length === 0) return empty;

    const threshold = config?.severity_threshold ?? "warning";
    const thresholdOrder = SEVERITY_ORDER[threshold] ?? 2;
    const ignoreRules = new Set(config?.ignore_rules ?? []);

    const filtered = alerts.filter((a) => {
      if (ignoreRules.has(a.rule.id)) return false;
      const sev = normalizeSeverity(a);
      return (SEVERITY_ORDER[sev] ?? 3) <= thresholdOrder;
    });

    const counts: SecurityAlertCounts = {
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
      total: filtered.length,
      topRules: [],
    };

    const ruleCount = new Map<string, number>();

    for (const alert of filtered) {
      const sev = normalizeSeverity(alert);
      const bucket = severityToBucket(sev);
      counts[bucket]++;

      ruleCount.set(alert.rule.id, (ruleCount.get(alert.rule.id) ?? 0) + 1);
    }

    counts.topRules = [...ruleCount.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([ruleId, count]) => `${ruleId} (${count})`);

    return counts;
  } catch (error) {
    const msg = String(error);
    if (msg.includes("403") || msg.includes("Advanced Security")) {
      core.debug("Code Scanning API not available (requires GitHub Advanced Security)");
    } else if (!msg.includes("404")) {
      core.debug(`Code Scanning fetch failed: ${msg}`);
    }
    return empty;
  }
}

// ---------------------------------------------------------------------------
// Compute the risk factor from alert counts
// ---------------------------------------------------------------------------

export function computeSecurityRiskFactor(
  alerts: SecurityAlertCounts,
  config?: SecurityConfig | null,
): RiskFactorResult | null {
  const factor = computeSecurityFactor(alerts);
  if (!factor) return null;

  if (config?.block_on_critical && alerts.critical > 0) {
    factor.score = Math.max(factor.score, 90);
    factor.detail = {
      ...factor.detail,
      block_reason: `${alerts.critical} critical alert(s) — block_on_critical enabled`,
    };
  }

  return factor;
}

// ---------------------------------------------------------------------------
// Markdown section for report
// ---------------------------------------------------------------------------

export function formatSecuritySection(alerts: SecurityAlertCounts): string {
  if (alerts.total === 0) return "";

  const lines = [
    `### Security Alerts`,
    ``,
    `| Severity | Count |`,
    `|----------|-------|`,
  ];

  if (alerts.critical > 0) lines.push(`| 🔴 Critical | ${alerts.critical} |`);
  if (alerts.high > 0) lines.push(`| 🟠 High | ${alerts.high} |`);
  if (alerts.medium > 0) lines.push(`| 🟡 Medium | ${alerts.medium} |`);
  if (alerts.low > 0) lines.push(`| 🔵 Low | ${alerts.low} |`);
  lines.push(`| **Total** | **${alerts.total}** |`);

  if (alerts.topRules && alerts.topRules.length > 0) {
    lines.push(``, `**Top rules:** ${alerts.topRules.join(", ")}`);
  }

  lines.push(``);
  return lines.join("\n");
}
