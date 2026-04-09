#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
const HEALTH_CHECK_TIMEOUT_MS = 10_000;
const VERCEL_TIMEOUT_MS = 10_000;
const SUPABASE_TIMEOUT_MS = 10_000;
const server = new McpServer({
    name: "deployguard",
    version: "1.0.0",
});
server.tool("check-http-health", "Check the health of an HTTP endpoint by sending a GET request and evaluating the response status", {
    url: z.string().url().describe("The URL to check"),
}, async ({ url }) => {
    const start = Date.now();
    try {
        const response = await fetch(url, {
            method: "GET",
            signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
        });
        const latencyMs = Date.now() - start;
        let status;
        if (response.ok)
            status = "healthy";
        else if (response.status < 500)
            status = "degraded";
        else
            status = "down";
        const result = {
            target: url,
            status,
            latencyMs,
            detail: { httpStatus: response.status },
        };
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
    catch (error) {
        const result = {
            target: url,
            status: "down",
            latencyMs: Date.now() - start,
            detail: { error: String(error) },
        };
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
});
server.tool("check-vercel-health", "Check the latest Vercel production deployment status. Requires VERCEL_TOKEN and VERCEL_PROJECT_ID environment variables.", {}, async () => {
    const token = process.env.VERCEL_TOKEN;
    const projectId = process.env.VERCEL_PROJECT_ID;
    if (!token || !projectId) {
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({
                        error: "Missing VERCEL_TOKEN or VERCEL_PROJECT_ID environment variables",
                    }),
                },
            ],
        };
    }
    const start = Date.now();
    try {
        const url = `https://api.vercel.com/v6/deployments?projectId=${encodeURIComponent(projectId)}&target=production&limit=1`;
        const response = await fetch(url, {
            method: "GET",
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(VERCEL_TIMEOUT_MS),
        });
        const latencyMs = Date.now() - start;
        if (!response.ok) {
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({
                            target: "vercel:production",
                            status: "degraded",
                            latencyMs,
                            detail: { httpStatus: response.status },
                        }),
                    },
                ],
            };
        }
        const body = (await response.json());
        const deployment = body?.deployments?.[0];
        const result = {
            target: "vercel:production",
            status: deployment?.readyState === "READY" ? "healthy" : "degraded",
            latencyMs,
            detail: {
                readyState: deployment?.readyState ?? "unknown",
                url: deployment?.url,
                createdAt: deployment?.createdAt
                    ? new Date(deployment.createdAt).toISOString()
                    : undefined,
            },
        };
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
    catch (error) {
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({
                        target: "vercel:production",
                        status: "down",
                        latencyMs: Date.now() - start,
                        detail: { error: String(error) },
                    }),
                },
            ],
        };
    }
});
server.tool("check-supabase-health", "Check the health of a Supabase project by pinging its REST API. Requires SUPABASE_URL and SUPABASE_ANON_KEY environment variables.", {}, async () => {
    const supabaseUrl = process.env.SUPABASE_URL;
    const anonKey = process.env.SUPABASE_ANON_KEY;
    if (!supabaseUrl || !anonKey) {
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({
                        error: "Missing SUPABASE_URL or SUPABASE_ANON_KEY environment variables",
                    }),
                },
            ],
        };
    }
    const start = Date.now();
    try {
        const response = await fetch(`${supabaseUrl}/rest/v1/`, {
            method: "GET",
            headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` },
            signal: AbortSignal.timeout(SUPABASE_TIMEOUT_MS),
        });
        const latencyMs = Date.now() - start;
        const result = {
            target: "supabase:rest",
            status: response.ok ? "healthy" : "degraded",
            latencyMs,
            detail: { httpStatus: response.status },
        };
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
    catch (error) {
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({
                        target: "supabase:rest",
                        status: "down",
                        latencyMs: Date.now() - start,
                        detail: { error: String(error) },
                    }),
                },
            ],
        };
    }
});
const TEST_FILE_PATTERN = /\.(test|spec)\.(ts|tsx|js|jsx)$|__tests__\/|\.cy\.(ts|js)$/;
const NON_SOURCE_PATTERN = /\.(sql|ya?ml|json|md|css|svg|lock|txt|env|png|jpg|gif)$/i;
const SENSITIVE_PATTERNS = [
    /(?:^|\/)migrations\//i,
    /(?:^|\/)auth/i,
    /(?:^|\/)security/i,
    /(?:^|\/)payment/i,
    /(?:^|\/)billing/i,
    /(?:^|\/)webhook/i,
    /(?:^|\/)infrastructure\//i,
    /(?:^|\/)\.github\/workflows\//i,
    /(?:^|\/)secrets/i,
    /(?:^|\/)\.env/i,
];
const HIGH_SENSITIVITY = /(?:^|\/)(?:auth|security|payment|billing|webhook)/i;
const INFRA_SENSITIVITY = /(?:^|\/)(?:migrations|infrastructure|\.github\/workflows|secrets|\.env)/i;
function sensitivityWeight(filename) {
    if (TEST_FILE_PATTERN.test(filename))
        return 0.3;
    if (HIGH_SENSITIVITY.test(filename))
        return 3;
    if (INFRA_SENSITIVITY.test(filename))
        return 2;
    if (NON_SOURCE_PATTERN.test(filename))
        return 0.5;
    return 1;
}
const FACTOR_WEIGHTS = {
    code_churn: 3,
    test_coverage: 2,
    file_count: 2,
    sensitive_files: 3,
};
server.tool("compute-risk-score", "Compute a deployment risk score for a set of changed files. Provide file names and their change counts.", {
    files: z
        .array(z.object({
        filename: z.string(),
        changes: z.number().int().min(0),
    }))
        .describe("Array of changed files with their line change counts"),
}, async ({ files }) => {
    if (files.length === 0) {
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({ score: 0, factors: [], decision: "allow" }),
                },
            ],
        };
    }
    const factors = [];
    const fileCountScore = Math.min(100, Math.round(30 * Math.log2(1 + files.length)));
    factors.push({
        type: "file_count",
        score: fileCountScore,
        detail: { fileCount: files.length },
    });
    const totalChanges = files.reduce((s, f) => s + f.changes, 0);
    const weightedChanges = files.reduce((s, f) => s + f.changes * sensitivityWeight(f.filename), 0);
    const churnScore = Math.min(100, Math.round(25 * Math.log2(1 + weightedChanges / 50)));
    factors.push({
        type: "code_churn",
        score: churnScore,
        detail: { totalChanges, weightedChanges: Math.round(weightedChanges) },
    });
    const testFiles = files.filter((f) => TEST_FILE_PATTERN.test(f.filename));
    const nonSource = files.filter((f) => !TEST_FILE_PATTERN.test(f.filename) && NON_SOURCE_PATTERN.test(f.filename));
    const sourceCount = files.length - testFiles.length - nonSource.length;
    if (sourceCount > 0) {
        const ratio = testFiles.length / sourceCount;
        factors.push({
            type: "test_coverage",
            score: Math.round(Math.max(0, 100 - ratio * 200)),
            detail: { testFiles: testFiles.length, sourceFiles: sourceCount },
        });
    }
    const sensitive = files.filter((f) => SENSITIVE_PATTERNS.some((p) => p.test(f.filename)));
    if (sensitive.length > 0) {
        factors.push({
            type: "sensitive_files",
            score: Math.min(100, sensitive.length * 25),
            detail: {
                count: sensitive.length,
                files: sensitive.map((f) => f.filename),
            },
        });
    }
    let totalWeight = 0;
    let weightedSum = 0;
    for (const f of factors) {
        const w = FACTOR_WEIGHTS[f.type] ?? 1;
        weightedSum += f.score * w;
        totalWeight += w;
    }
    const score = Math.min(100, Math.max(0, Math.round(weightedSum / totalWeight)));
    const decision = score > 70 ? "block" : score > 55 ? "warn" : "allow";
    return {
        content: [
            {
                type: "text",
                text: JSON.stringify({ score, factors, decision }, null, 2),
            },
        ],
    };
});
server.tool("evaluate-deployment", "Run a full DeployGuard evaluation including health checks and risk scoring. Provide the target URLs and file changes.", {
    healthUrls: z
        .array(z.string().url())
        .default([])
        .describe("URLs to health-check before scoring"),
    files: z
        .array(z.object({
        filename: z.string(),
        changes: z.number().int().min(0),
    }))
        .default([])
        .describe("Changed files with line counts"),
}, async ({ healthUrls, files, }) => {
    const healthChecks = [];
    const httpChecks = await Promise.all(healthUrls.map(async (url) => {
        const start = Date.now();
        try {
            const res = await fetch(url, {
                method: "GET",
                signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
            });
            return {
                target: url,
                status: (res.ok ? "healthy" : res.status < 500 ? "degraded" : "down"),
                latencyMs: Date.now() - start,
                detail: { httpStatus: res.status },
            };
        }
        catch (err) {
            return {
                target: url,
                status: "down",
                latencyMs: Date.now() - start,
                detail: { error: String(err) },
            };
        }
    }));
    healthChecks.push(...httpChecks);
    const healthScore = healthChecks.length > 0
        ? Math.round(healthChecks.reduce((sum, c) => sum + (c.status === "healthy" ? 100 : c.status === "degraded" ? 50 : 0), 0) / healthChecks.length)
        : 100;
    let riskScore = 0;
    const factors = [];
    if (files.length > 0) {
        const fileCountScore = Math.min(100, Math.round(30 * Math.log2(1 + files.length)));
        factors.push({
            type: "file_count",
            score: fileCountScore,
            detail: { fileCount: files.length },
        });
        const weightedChanges = files.reduce((s, f) => s + f.changes * sensitivityWeight(f.filename), 0);
        factors.push({
            type: "code_churn",
            score: Math.min(100, Math.round(25 * Math.log2(1 + weightedChanges / 50))),
            detail: {
                totalChanges: files.reduce((s, f) => s + f.changes, 0),
                weightedChanges: Math.round(weightedChanges),
            },
        });
        let totalW = 0;
        let wSum = 0;
        for (const f of factors) {
            const w = FACTOR_WEIGHTS[f.type] ?? 1;
            wSum += f.score * w;
            totalW += w;
        }
        riskScore = Math.min(100, Math.max(0, Math.round(wSum / totalW)));
    }
    const decision = riskScore > 70 ? "block" : riskScore > 55 || healthScore < 50 ? "warn" : "allow";
    return {
        content: [
            {
                type: "text",
                text: JSON.stringify({
                    healthScore,
                    riskScore,
                    decision,
                    healthChecks,
                    riskFactors: factors,
                }, null, 2),
            },
        ],
    };
});
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
}
main().catch((err) => {
    console.error("MCP server failed:", err);
    process.exit(1);
});
