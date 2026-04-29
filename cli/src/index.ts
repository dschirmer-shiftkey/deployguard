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

function ask(
  rl: readline.Interface,
  question: string,
  defaultValue?: string,
): Promise<string> {
  const suffix = defaultValue ? ` ${DIM}(${defaultValue})${RESET}` : "";
  return new Promise((resolve) => {
    rl.question(`  ${question}${suffix}: `, (answer) => {
      resolve(answer.trim() || defaultValue || "");
    });
  });
}

function askYN(
  rl: readline.Interface,
  question: string,
  defaultYes: boolean,
): Promise<boolean> {
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
  environments: Array<{ name: string; risk: number; warn: number }>;
  services: Array<{ name: string; paths: string[]; env: string }>;
  securityGate: boolean;
  canaryType: string;
}): string {
  const lines: string[] = [
    "# DeployGuard v3 configuration",
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

  if (options.environments.length > 0) {
    lines.push("environments:");
    for (const env of options.environments) {
      lines.push(`  ${env.name}:`);
      lines.push(`    risk: ${env.risk}`);
      lines.push(`    warn: ${env.warn}`);
    }
    lines.push("");
  }

  if (options.services.length > 0) {
    lines.push("services:");
    for (const svc of options.services) {
      lines.push(`  ${svc.name}:`);
      lines.push("    paths:");
      for (const p of svc.paths) lines.push(`      - "${p}"`);
      if (svc.env) lines.push(`    environment: ${svc.env}`);
    }
    lines.push("");
  }

  if (options.securityGate) {
    lines.push("security:");
    lines.push("  severity_threshold: warning");
    lines.push("  block_on_critical: true");
    lines.push("");
  }

  if (options.canaryType) {
    lines.push("canary:");
    lines.push(`  webhook_type: ${options.canaryType}`);
    lines.push("");
  }

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
  doraEnvironment: string;
  otelEndpoint: string;
  evaluationStoreUrl: string;
  storeSecretName: string;
  supabaseFallback: boolean;
  securityGate: boolean;
  environment: string;
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
    "  security-events: read",
    "",
    "jobs:",
    "  deployguard:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v4",
    "",
    "      - uses: dschirmer-shiftkey/deployguard@v3",
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

  if (options.doraEnvironment) {
    lines.push(`          dora-environment: "${options.doraEnvironment}"`);
  }

  if (options.environment) {
    lines.push(`          environment: "${options.environment}"`);
  }

  if (!options.securityGate) {
    lines.push('          security-gate: "false"');
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
    lines.push('          echo "dora-lead:    ${{ steps.gate.outputs.dora-lead-time }}"');
    lines.push('          echo "dora-fdrt:    ${{ steps.gate.outputs.dora-fdrt }}"');
    lines.push(
      '          echo "dora-rework:  ${{ steps.gate.outputs.dora-rework-rate }}"',
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
${BOLD}${GREEN}DeployGuard CLI v3.0.2${RESET}

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

  print(`\n${BOLD}${GREEN}DeployGuard v3 Setup Wizard${RESET}\n`);
  print(
    `${DIM}This will create .deployguard.yml and a GitHub Actions workflow.${RESET}\n`,
  );

  const riskStr = await ask(
    rl,
    `${CYAN}Risk threshold${RESET} (block above this score, 0-100)`,
    "70",
  );
  const riskThreshold = Math.max(0, Math.min(100, parseInt(riskStr, 10) || 70));

  const warnStr = await ask(
    rl,
    `${CYAN}Warn threshold${RESET} (warn above this score)`,
    String(riskThreshold - 15),
  );
  const warnThreshold = Math.max(
    0,
    Math.min(100, parseInt(warnStr, 10) || riskThreshold - 15),
  );

  print(
    `\n${BOLD}Sensitive file patterns${RESET} ${DIM}(files that carry extra risk weight)${RESET}`,
  );
  const highInput = await ask(rl, "High-sensitivity globs (comma-separated)", "");
  const highSensitivity = highInput
    ? highInput
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  const medInput = await ask(rl, "Medium-sensitivity globs (comma-separated)", "");
  const mediumSensitivity = medInput
    ? medInput
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  print(
    `\n${BOLD}Environment configuration${RESET} ${DIM}(per-environment threshold overrides)${RESET}`,
  );
  const wantEnvs = await askYN(rl, "Configure environment-specific thresholds?", false);
  const environments: Array<{
    name: string;
    risk: number;
    warn: number;
  }> = [];
  let environment = "";
  if (wantEnvs) {
    const envsInput = await ask(
      rl,
      "Environment names (comma-separated)",
      "production,staging",
    );
    const envNames = envsInput
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const name of envNames) {
      const r = await ask(rl, `  ${name} risk threshold`, String(riskThreshold));
      const w = await ask(rl, `  ${name} warn threshold`, String(parseInt(r, 10) - 15));
      environments.push({
        name,
        risk: parseInt(r, 10) || riskThreshold,
        warn: parseInt(w, 10) || riskThreshold - 15,
      });
    }
    environment = envNames[0] ?? "";
  }

  print(
    `\n${BOLD}Service mapping${RESET} ${DIM}(monorepo per-service DORA + risk)${RESET}`,
  );
  const wantServices = await askYN(rl, "Configure service boundaries?", false);
  const services: Array<{
    name: string;
    paths: string[];
    env: string;
  }> = [];
  if (wantServices) {
    const svcInput = await ask(rl, "Service names (comma-separated)", "api,web");
    const svcNames = svcInput
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const name of svcNames) {
      const p = await ask(rl, `  ${name} path globs (comma-separated)`, `src/${name}/**`);
      const e = await ask(rl, `  ${name} environment`, "");
      services.push({
        name,
        paths: p
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        env: e,
      });
    }
  }

  print(`\n${BOLD}Health checks${RESET} ${DIM}(URLs to ping before scoring)${RESET}`);
  const healthInput = await ask(
    rl,
    "Health check URLs (comma-separated, or blank to skip)",
    "",
  );
  const healthCheckUrls = healthInput
    ? healthInput
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  const doraMetrics = await askYN(rl, `${CYAN}Enable DORA-5 metrics?${RESET}`, true);
  const doraEnvironment = doraMetrics
    ? await ask(
        rl,
        `${CYAN}DORA environment filter${RESET} (blank for all)`,
        environment || "",
      )
    : "";

  const securityGate = await askYN(
    rl,
    `${CYAN}Enable security alerts gate?${RESET} ${DIM}(requires Code Scanning)${RESET}`,
    true,
  );

  print(
    `\n${BOLD}Canary / deploy tracking${RESET} ${DIM}(track deployment outcomes)${RESET}`,
  );
  const wantCanary = await askYN(rl, "Configure deployment outcome webhooks?", false);
  let canaryType = "";
  if (wantCanary) {
    canaryType = await ask(rl, "Webhook type (vercel/generic)", "vercel");
  }

  const otelEndpoint = await ask(rl, `${CYAN}OTLP endpoint${RESET} (blank to skip)`, "");

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

  print(
    `\n${BOLD}Release freeze${RESET} ${DIM}(block deploys during specific times)${RESET}`,
  );
  const wantFreeze = await askYN(rl, "Configure a freeze window?", false);
  let freezeDays: string[] = [];
  let freezeAfterHour: number | null = null;
  if (wantFreeze) {
    const daysInput = await ask(rl, "Freeze days (e.g. friday,saturday)", "friday");
    freezeDays = daysInput
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const hourStr = await ask(rl, "Freeze after hour (0-23, UTC)", "15");
    freezeAfterHour = Math.max(0, Math.min(23, parseInt(hourStr, 10) || 15));
  }

  rl.close();

  print(`\n${BOLD}Writing files...${RESET}\n`);

  const configContent = generateDeployguardYml({
    highSensitivity,
    mediumSensitivity,
    riskThreshold,
    warnThreshold,
    freezeDays,
    freezeAfterHour,
    environments,
    services,
    securityGate,
    canaryType,
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
    doraEnvironment,
    otelEndpoint,
    evaluationStoreUrl,
    storeSecretName,
    supabaseFallback,
    securityGate,
    environment,
  });

  const workflowPath = path.join(workflowDir, "deployguard.yml");
  if (fs.existsSync(workflowPath)) {
    print(
      `  ${YELLOW}⚠${RESET} .github/workflows/deployguard.yml already exists — writing to deployguard-generated.yml`,
    );
    fs.writeFileSync(
      path.join(workflowDir, "deployguard-generated.yml"),
      workflowContent,
      "utf-8",
    );
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
