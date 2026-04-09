import * as github from "@actions/github";
// ---------------------------------------------------------------------------
// PR diff fetching via @actions/github
// ---------------------------------------------------------------------------
async function fetchPrFiles(prNumber) {
    const token = process.env.GITHUB_TOKEN;
    if (!token)
        return [];
    const octokit = github.getOctokit(token);
    const { owner, repo } = github.context.repo;
    const { data: files } = await octokit.rest.pulls.listFiles({
        owner,
        repo,
        pull_number: prNumber,
        per_page: 300,
    });
    return files.map((f) => ({
        filename: f.filename,
        additions: f.additions,
        deletions: f.deletions,
        changes: f.changes,
    }));
}
// ---------------------------------------------------------------------------
// Risk scoring heuristics
// ---------------------------------------------------------------------------
const TEST_FILE_PATTERN = /\.(test|spec)\.(ts|tsx|js|jsx)$|__tests__\/|\.cy\.(ts|js)$/;
function isTestFile(filename) {
    return TEST_FILE_PATTERN.test(filename);
}
export function computeRiskScore(files) {
    if (files.length === 0) {
        return { score: 0, factors: [] };
    }
    const factors = [];
    // 1. Breadth of change — more files touched = higher blast radius
    const fileCount = files.length;
    const fileCountScore = Math.min(100, fileCount * 5);
    factors.push({
        type: "file_history",
        score: fileCountScore,
        detail: { fileCount, description: "Number of files changed" },
    });
    // 2. Volume of churn — total lines added + removed
    const totalChanges = files.reduce((sum, f) => sum + f.changes, 0);
    const churnScore = Math.min(100, Math.round(totalChanges / 5));
    factors.push({
        type: "code_churn",
        score: churnScore,
        detail: { totalChanges, description: "Total lines changed" },
    });
    // 3. Test-to-source ratio — PRs that touch source without tests are riskier
    const testFileCount = files.filter((f) => isTestFile(f.filename)).length;
    const sourceFileCount = files.length - testFileCount;
    const testRatio = sourceFileCount === 0 ? 1 : testFileCount / sourceFileCount;
    const testCoverageScore = Math.round(Math.max(0, 100 - testRatio * 200));
    factors.push({
        type: "test_coverage",
        score: testCoverageScore,
        detail: {
            testFiles: testFileCount,
            sourceFiles: sourceFileCount,
            testRatio: Math.round(testRatio * 100) / 100,
        },
    });
    const avgScore = Math.round(factors.reduce((sum, f) => sum + f.score, 0) / factors.length);
    return { score: Math.min(100, Math.max(0, avgScore)), factors };
}
// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------
const HEALTH_CHECK_TIMEOUT_MS = 10_000;
export async function checkHealth(url) {
    const start = Date.now();
    try {
        const response = await fetch(url, {
            method: "GET",
            signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
        });
        const latencyMs = Date.now() - start;
        let status;
        if (response.ok) {
            status = "allow";
        }
        else if (response.status < 500) {
            status = "warn";
        }
        else {
            status = "block";
        }
        return { target: url, status, latencyMs, detail: { httpStatus: response.status } };
    }
    catch (error) {
        return {
            target: url,
            status: "warn",
            latencyMs: Date.now() - start,
            detail: { error: String(error) },
        };
    }
}
function healthCheckToScore(check) {
    switch (check.status) {
        case "allow":
            return 100;
        case "warn":
            return 50;
        case "block":
            return 0;
        default: {
            const _exhaustive = check.status;
            throw new Error(`Unknown health status: ${_exhaustive}`);
        }
    }
}
// ---------------------------------------------------------------------------
// Gate decision logic
// ---------------------------------------------------------------------------
export function decideGate(riskScore, healthScore, threshold) {
    if (riskScore > threshold)
        return "block";
    if (riskScore > threshold * 0.7 || healthScore < 50)
        return "warn";
    return "allow";
}
// ---------------------------------------------------------------------------
// Main evaluation entry point
// ---------------------------------------------------------------------------
export async function evaluateGate(config, commitSha, prNumber) {
    const start = Date.now();
    const files = prNumber ? await fetchPrFiles(prNumber) : [];
    const { score: riskScore, factors: riskFactors } = computeRiskScore(files);
    const healthChecks = [];
    let healthScore = 100;
    if (config.healthCheckUrl) {
        const check = await checkHealth(config.healthCheckUrl);
        healthChecks.push(check);
        healthScore = healthCheckToScore(check);
    }
    const gateDecision = decideGate(riskScore, healthScore, config.riskThreshold);
    return {
        id: `dg-${commitSha.substring(0, 7)}-${Date.now()}`,
        repoId: `${github.context.repo.owner}/${github.context.repo.repo}`,
        commitSha,
        prNumber,
        healthScore,
        riskScore,
        gateDecision,
        healthChecks,
        riskFactors,
        evaluationMs: Date.now() - start,
    };
}
// ---------------------------------------------------------------------------
// Report formatting
// ---------------------------------------------------------------------------
export function formatGateReport(evaluation) {
    const lines = [
        `## DeployGuard Evaluation`,
        ``,
        `| Metric | Score |`,
        `|--------|-------|`,
        `| Health | ${evaluation.healthScore}/100 |`,
        `| Risk   | ${evaluation.riskScore}/100 |`,
        `| **Decision** | **${evaluation.gateDecision.toUpperCase()}** |`,
        ``,
    ];
    if (evaluation.riskFactors.length > 0) {
        lines.push(`### Risk Factors`, ``);
        for (const factor of evaluation.riskFactors) {
            const detail = factor.detail;
            const desc = detail?.["description"] ?? factor.type;
            lines.push(`- **${factor.type}** — ${desc}: score ${factor.score}/100`);
        }
        lines.push(``);
    }
    if (evaluation.healthChecks.length > 0) {
        lines.push(`### Health Checks`, ``);
        for (const check of evaluation.healthChecks) {
            lines.push(`- \`${check.target}\` — ${check.status.toUpperCase()} (${check.latencyMs}ms)`);
        }
        lines.push(``);
    }
    if (evaluation.reportUrl) {
        lines.push(`[View full report](${evaluation.reportUrl})`);
    }
    return lines.join("\n");
}
//# sourceMappingURL=gate.js.map