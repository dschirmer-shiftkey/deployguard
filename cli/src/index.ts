#!/usr/bin/env node

import * as readline from "node:readline";
import * as fs from "node:fs";
import * as path from "node:path";

const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";

function print(msg: string) {
  process.stdout.write(msg + "\n");
}

function ask(rl: readline.Interface, question: string, defaultValue?: string): Promise<string> {
  const suffix = defaultValue ? ` ${DIM}(${defaultValue})${RESET}` : "";
  return new Promise((resolve) => {
    rl.question(`  ${question}${suffix}: `, (answer) => {
      resolve(answer.trim() || defaultValue || "");
    });
  });
}

function askYN(rl: readline.Interface, question: string, defaultYes: boolean): Promise<boolean> {
  const hint = defaultYes ? "Y/n" : "y/N";
  return new Promise((resolve) => {
    rl.question(`  ${question} ${DIM}(${hint})${RESET}: `, (answer) => {
      const a = answer.trim().toLowerCase();
      if (a === "") resolve(defaultYes);
      else resolve(a === "y" || a === "yes");
    });
  });
}

function generateDeployguardYml(options: {
  highSensitivity: string[];
  mediumSensitivity: string[];
  riskThreshold: number;
  warnThreshold: number;
  freezeDays: string[];
  freezeAfterHour: number | null;
}): string {
  const lines: string[] = [
    "# DeployGuard configuration",
    "# https://github.com/dschirmer-shiftkey/deployguard",
    "",
  ];

  if (options.highSensitivity.length > 0 || options.mediumSensitivity.length > 0) {
    lines.push("sensitivity:");
    if (options.highSensitivity.length > 0) {
      lines.push("  high:");
      for (const p of options.highSensitivity) lines.push(`    - "${p}"`);
    }
    if (options.mediumSensitivity.length > 0) {
      lines.push("  medium:");
      for (const p of options.mediumSensitivity) lines.push(`    - "${p}"`);
    }
    lines.push("");
  }

  lines.push("thresholds:");
  lines.push(`  risk: ${options.riskThreshold}`);
  lines.push(`  warn: ${options.warnThreshold}`);
  lines.push("");

  if (options.freezeDays.length > 0 && options.freezeAfterHour !== null) {
    lines.push("freeze:");
    lines.push("  - days:");
    for (const d of options.freezeDays) lines.push(`      - "${d}"`);
    lines.push(`    afterHour: ${options.freezeAfterHour}`);
    lines.push(`    message: "No deploys during freeze window"`);
    lines.push("");
  }

  return lines.join("\n") + "\n";
}

function generateWorkflowYml(options: {
  riskThreshold: number;
  healthCheckUrls: string[];
  doraMetrics: boolean;
  otelEndpoint: string;
  evaluationStoreUrl: string;
  storeSecretName: string;
  supabaseFallback: boolean;
}): string {
  const lines: string[] = [
    "name: DeployGuard",
    "",
    "on:",
    "  pull_request:",
    "    types: [opened, synchronize, reopened]",
    "",
    "permissions:",
    "  contents: read",
    "  pull-requests: write",
    "  checks: write",
    "",
    "jobs:",
    "  deployguard:",
    '    runs-on: ubuntu-latest',
    "    steps:",
    "      - uses: actions/checkout@v4",
    "",
    "      - uses: dschirmer-shiftkey/deployguard@v2",
    "        id: gate",
    "        with:",
    `          risk-threshold: "${options.riskThreshold}"`,
  ];

  if (options.healthCheckUrls.length > 0) {
    lines.push(`          health-check-urls: "${options.healthCheckUrls.join(",")}"`);
  }

  if (options.doraMetrics) {
    lines.push('          dora-metrics: "true"');
  }

  if (options.otelEndpoint) {
    lines.push(`          otel-endpoint: "${options.otelEndpoint}"`);
  }

  if (options.evaluationStoreUrl) {
    lines.push(`          evaluation-store-url: "${options.evaluationStoreUrl}"`);
    if (options.storeSecretName) {
      lines.push(
        `          evaluation-store-secret: \${{ secrets.${options.storeSecretName} }}`,
      );
    }
  }

  const envLines: string[] = [];
  if (options.evaluationStoreUrl && options.storeSecretName) {
    envLines.push(
      `          EVALUATION_STORE_SECRET: \${{ secrets.${options.storeSecretName} }}`,
    );
  }
  if (options.supabaseFallback) {
    envLines.push(`          SUPABASE_URL: \${{ secrets.SUPABASE_URL }}`);
    envLines.push(
      `          SUPABASE_SERVICE_ROLE_KEY: \${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}`,
    );
  }

  if (envLines.length > 0) {
    lines.push("        env:");
    for (const el of envLines) lines.push(el);
  }

  if (options.doraMetrics) {
    lines.push("");
    lines.push("      - name: DORA outputs");
    lines.push("        if: always()");
    lines.push("        run: |");
    lines.push('          echo "dora-rating:  ${{ steps.gate.outputs.dora-rating }}"');
    lines.push(
      '          echo "dora-freq:    ${{ steps.gate.outputs.dora-deployment-frequency }}"',
    );
    lines.push(
      '          echo "dora-cfr:     ${{ steps.gate.outputs.dora-change-failure-rate }}"',
    );
    lines.push(
      '          echo "dora-lead:    ${{ steps.gate.outputs.dora-lead-time }}"',
    );
  }

  lines.push("");
  return lines.join("\n") + "\n";
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command !== "init") {
    print(`
${BOLD}${GREEN}DeployGuard CLI v2.2.0${RESET}

${BOLD}Usage:${RESET}
  npx deployguard init    Interactive setup wizard

${BOLD}Learn more:${RESET}
  https://github.com/dschirmer-shiftkey/deployguard
`);
    return;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  print(`\n${BOLD}${GREEN}DeployGuard Setup Wizard${RESET}\n`);
  print(`${DIM}This will create .deployguard.yml and a GitHub Actions workflow.${RESET}\n`);

  // Risk threshold
  const riskStr = await ask(rl, `${CYAN}Risk threshold${RESET} (block above this score, 0-100)`, "70");
  const riskThreshold = Math.max(0, Math.min(100, parseInt(riskStr, 10) || 70));

  const warnStr = await ask(rl, `${CYAN}Warn threshold${RESET} (warn above this score)`, String(riskThreshold - 15));
  const warnThreshold = Math.max(0, Math.min(100, parseInt(warnStr, 10) || riskThreshold - 15));

  // Sensitive files
  print(`\n${BOLD}Sensitive file patterns${RESET} ${DIM}(files that carry extra risk weight)${RESET}`);
  const highInput = await ask(rl, "High-sensitivity globs (comma-separated)", "");
  const highSensitivity = highInput ? highInput.split(",").map((s) => s.trim()).filter(Boolean) : [];

  const medInput = await ask(rl, "Medium-sensitivity globs (comma-separated)", "");
  const mediumSensitivity = medInput ? medInput.split(",").map((s) => s.trim()).filter(Boolean) : [];

  // Health checks
  print(`\n${BOLD}Health checks${RESET} ${DIM}(URLs to ping before scoring)${RESET}`);
  const healthInput = await ask(rl, "Health check URLs (comma-separated, or blank to skip)", "");
  const healthCheckUrls = healthInput ? healthInput.split(",").map((s) => s.trim()).filter(Boolean) : [];

  // DORA
  const doraMetrics = await askYN(rl, `${CYAN}Enable DORA metrics?${RESET}`, true);

  // OTel
  const otelEndpoint = await ask(rl, `${CYAN}OTLP endpoint${RESET} (blank to skip)`, "");

  // Evaluation store (trend dashboards)
  const wantStore = await askYN(
    rl,
    `${CYAN}POST evaluations to a trend-store URL?${RESET} ${DIM}(optional)${RESET}`,
    false,
  );
  let evaluationStoreUrl = "";
  let storeSecretName = "";
  let supabaseFallback = false;
  if (wantStore) {
    evaluationStoreUrl = await ask(
      rl,
      "Store URL (your API that accepts DeployGuard evaluation JSON)",
      "",
    );
    storeSecretName = await ask(
      rl,
      "GitHub Actions secret name for the Bearer token",
      "INTERNAL_API_SECRET",
    );
    supabaseFallback = await askYN(
      rl,
      "Include Supabase URL + service role for direct-insert fallback?",
      true,
    );
  }

  // Freeze window
  print(`\n${BOLD}Release freeze${RESET} ${DIM}(block deploys during specific times)${RESET}`);
  const wantFreeze = await askYN(rl, "Configure a freeze window?", false);
  let freezeDays: string[] = [];
  let freezeAfterHour: number | null = null;
  if (wantFreeze) {
    const daysInput = await ask(rl, "Freeze days (e.g. friday,saturday)", "friday");
    freezeDays = daysInput.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    const hourStr = await ask(rl, "Freeze after hour (0-23, UTC)", "15");
    freezeAfterHour = Math.max(0, Math.min(23, parseInt(hourStr, 10) || 15));
  }

  rl.close();

  // Write files
  print(`\n${BOLD}Writing files...${RESET}\n`);

  const configContent = generateDeployguardYml({
    highSensitivity,
    mediumSensitivity,
    riskThreshold,
    warnThreshold,
    freezeDays,
    freezeAfterHour,
  });

  const configPath = path.join(process.cwd(), ".deployguard.yml");
  fs.writeFileSync(configPath, configContent, "utf-8");
  print(`  ${GREEN}✓${RESET} .deployguard.yml`);

  const workflowDir = path.join(process.cwd(), ".github", "workflows");
  fs.mkdirSync(workflowDir, { recursive: true });

  const workflowContent = generateWorkflowYml({
    riskThreshold,
    healthCheckUrls,
    doraMetrics,
    otelEndpoint,
    evaluationStoreUrl,
    storeSecretName,
    supabaseFallback,
  });

  const workflowPath = path.join(workflowDir, "deployguard.yml");
  if (fs.existsSync(workflowPath)) {
    print(`  ${YELLOW}⚠${RESET} .github/workflows/deployguard.yml already exists — writing to deployguard-generated.yml`);
    fs.writeFileSync(path.join(workflowDir, "deployguard-generated.yml"), workflowContent, "utf-8");
  } else {
    fs.writeFileSync(workflowPath, workflowContent, "utf-8");
    print(`  ${GREEN}✓${RESET} .github/workflows/deployguard.yml`);
  }

  print(`
${BOLD}${GREEN}Setup complete!${RESET}

${BOLD}Next steps:${RESET}
  1. Review the generated files
  2. Commit and push to your repository
  3. Open a PR to see DeployGuard in action

${DIM}Docs: https://github.com/dschirmer-shiftkey/deployguard${RESET}
`);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
