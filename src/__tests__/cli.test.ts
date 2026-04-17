import { describe, it, expect } from "vitest";

/**
 * Tests for the CLI generator functions (cli/src/index.ts).
 *
 * Since the CLI is a separate TypeScript project with interactive I/O,
 * we test the pure generation logic by re-implementing the generator
 * functions here (they have no external dependencies).
 */

// ---------------------------------------------------------------------------
// generateDeployguardYml — extracted from cli/src/index.ts
// ---------------------------------------------------------------------------

interface DeployguardYmlOptions {
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
}

function generateDeployguardYml(options: DeployguardYmlOptions): string {
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

// ---------------------------------------------------------------------------
// generateWorkflowYml — extracted from cli/src/index.ts
// ---------------------------------------------------------------------------

interface WorkflowYmlOptions {
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
}

function generateWorkflowYml(options: WorkflowYmlOptions): string {
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

// ===========================================================================
// TESTS
// ===========================================================================

describe("CLI: generateDeployguardYml", () => {
  const defaults: DeployguardYmlOptions = {
    highSensitivity: [],
    mediumSensitivity: [],
    riskThreshold: 70,
    warnThreshold: 55,
    freezeDays: [],
    freezeAfterHour: null,
    environments: [],
    services: [],
    securityGate: false,
    canaryType: "",
  };

  it("generates minimal config with just thresholds", () => {
    const yml = generateDeployguardYml(defaults);
    expect(yml).toContain("thresholds:");
    expect(yml).toContain("risk: 70");
    expect(yml).toContain("warn: 55");
    expect(yml).not.toContain("sensitivity:");
    expect(yml).not.toContain("environments:");
    expect(yml).not.toContain("freeze:");
  });

  it("includes sensitivity patterns when provided", () => {
    const yml = generateDeployguardYml({
      ...defaults,
      highSensitivity: ["src/auth/**", "src/billing/**"],
      mediumSensitivity: ["src/api/**"],
    });
    expect(yml).toContain("sensitivity:");
    expect(yml).toContain('- "src/auth/**"');
    expect(yml).toContain('- "src/billing/**"');
    expect(yml).toContain('- "src/api/**"');
  });

  it("includes environment overrides", () => {
    const yml = generateDeployguardYml({
      ...defaults,
      environments: [
        { name: "production", risk: 50, warn: 35 },
        { name: "staging", risk: 80, warn: 65 },
      ],
    });
    expect(yml).toContain("environments:");
    expect(yml).toContain("  production:");
    expect(yml).toContain("    risk: 50");
    expect(yml).toContain("  staging:");
    expect(yml).toContain("    risk: 80");
  });

  it("includes service boundaries", () => {
    const yml = generateDeployguardYml({
      ...defaults,
      services: [
        { name: "api", paths: ["src/api/**", "src/models/**"], env: "production" },
      ],
    });
    expect(yml).toContain("services:");
    expect(yml).toContain("  api:");
    expect(yml).toContain('- "src/api/**"');
    expect(yml).toContain("environment: production");
  });

  it("includes security gate config", () => {
    const yml = generateDeployguardYml({ ...defaults, securityGate: true });
    expect(yml).toContain("security:");
    expect(yml).toContain("severity_threshold: warning");
    expect(yml).toContain("block_on_critical: true");
  });

  it("includes canary config", () => {
    const yml = generateDeployguardYml({ ...defaults, canaryType: "vercel" });
    expect(yml).toContain("canary:");
    expect(yml).toContain("webhook_type: vercel");
  });

  it("includes freeze windows", () => {
    const yml = generateDeployguardYml({
      ...defaults,
      freezeDays: ["friday", "saturday"],
      freezeAfterHour: 15,
    });
    expect(yml).toContain("freeze:");
    expect(yml).toContain('- "friday"');
    expect(yml).toContain('- "saturday"');
    expect(yml).toContain("afterHour: 15");
  });

  it("starts with a header comment", () => {
    const yml = generateDeployguardYml(defaults);
    expect(yml.startsWith("# DeployGuard v3 configuration")).toBe(true);
  });

  it("ends with a trailing newline", () => {
    const yml = generateDeployguardYml(defaults);
    expect(yml.endsWith("\n")).toBe(true);
  });
});

describe("CLI: generateWorkflowYml", () => {
  const defaults: WorkflowYmlOptions = {
    riskThreshold: 70,
    healthCheckUrls: [],
    doraMetrics: false,
    doraEnvironment: "",
    otelEndpoint: "",
    evaluationStoreUrl: "",
    storeSecretName: "",
    supabaseFallback: false,
    securityGate: true,
    environment: "",
  };

  it("generates valid workflow yaml structure", () => {
    const yml = generateWorkflowYml(defaults);
    expect(yml).toContain("name: DeployGuard");
    expect(yml).toContain("on:");
    expect(yml).toContain("pull_request:");
    expect(yml).toContain("permissions:");
    expect(yml).toContain("jobs:");
    expect(yml).toContain("dschirmer-shiftkey/deployguard@v3");
  });

  it("includes risk threshold", () => {
    const yml = generateWorkflowYml({ ...defaults, riskThreshold: 85 });
    expect(yml).toContain('risk-threshold: "85"');
  });

  it("includes health check URLs", () => {
    const yml = generateWorkflowYml({
      ...defaults,
      healthCheckUrls: [
        "https://api.example.com/health",
        "https://web.example.com/health",
      ],
    });
    expect(yml).toContain("health-check-urls:");
    expect(yml).toContain("api.example.com/health,https://web.example.com/health");
  });

  it("includes DORA metrics config and outputs step", () => {
    const yml = generateWorkflowYml({
      ...defaults,
      doraMetrics: true,
      doraEnvironment: "production",
    });
    expect(yml).toContain('dora-metrics: "true"');
    expect(yml).toContain('dora-environment: "production"');
    expect(yml).toContain("DORA outputs");
    expect(yml).toContain("dora-rating");
  });

  it("disables security gate when false", () => {
    const yml = generateWorkflowYml({ ...defaults, securityGate: false });
    expect(yml).toContain('security-gate: "false"');
  });

  it("does not include security-gate line when enabled (default)", () => {
    const yml = generateWorkflowYml(defaults);
    expect(yml).not.toContain("security-gate:");
  });

  it("includes OTel endpoint", () => {
    const yml = generateWorkflowYml({
      ...defaults,
      otelEndpoint: "https://otel.example.com:4318/v1/traces",
    });
    expect(yml).toContain("otel-endpoint:");
    expect(yml).toContain("otel.example.com");
  });

  it("includes evaluation store with secret", () => {
    const yml = generateWorkflowYml({
      ...defaults,
      evaluationStoreUrl: "https://api.example.com/store",
      storeSecretName: "INTERNAL_API_SECRET",
    });
    expect(yml).toContain("evaluation-store-url:");
    expect(yml).toContain("evaluation-store-secret:");
    expect(yml).toContain("INTERNAL_API_SECRET");
  });

  it("includes Supabase fallback env vars", () => {
    const yml = generateWorkflowYml({
      ...defaults,
      evaluationStoreUrl: "https://api.example.com/store",
      storeSecretName: "SECRET",
      supabaseFallback: true,
    });
    expect(yml).toContain("SUPABASE_URL");
    expect(yml).toContain("SUPABASE_SERVICE_ROLE_KEY");
  });

  it("includes environment input", () => {
    const yml = generateWorkflowYml({ ...defaults, environment: "production" });
    expect(yml).toContain('environment: "production"');
  });

  it("ends with a trailing newline", () => {
    const yml = generateWorkflowYml(defaults);
    expect(yml.endsWith("\n")).toBe(true);
  });
});
