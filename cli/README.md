# DeployGuard CLI

Interactive setup wizard for DeployGuard. Generates `.deployguard.yml` and the GitHub Actions workflow YAML with all v3 features configured.

## Usage

```bash
npx deployguard init
```

No installation required. The wizard walks you through:

1. **Sensitivity patterns** — which file paths are high/medium risk (auth, payments, migrations)
2. **Thresholds** — risk and warn scores (defaults: 70/55)
3. **Freeze windows** — days and hours when deployments are blocked
4. **Environments** — per-environment threshold overrides (production, staging, etc.)
5. **Services** — monorepo service boundaries with path patterns
6. **Security gate** — whether to include Code Scanning alerts as a risk factor
7. **Canary tracking** — Vercel or generic deploy outcome webhook type
8. **DORA metrics** — whether to compute DORA-5 alongside gate evaluations
9. **Health checks** — URLs to probe before scoring
10. **Webhooks** — Slack/Discord notification URL and trigger events
11. **OpenTelemetry** — OTLP endpoint for evaluation span export
12. **Evaluation store** — URL for persisting evaluations to a trend dashboard

## Output

The wizard generates two files:

- **`.deployguard.yml`** — per-repo configuration (sensitivity, thresholds, freeze windows, environments, services, security, canary)
- **`.github/workflows/deployguard.yml`** — GitHub Actions workflow with all selected features

## Development

```bash
cd cli
npm install
npx tsc
node dist/index.js
```

The CLI is a zero-dependency ESM module. Build output goes to `cli/dist/` (gitignored — build before npm publish).

## Publishing

```bash
cd cli
npx tsc
npm publish
```

The package is published as `deployguard` on npm, making `npx deployguard init` work without installation.
