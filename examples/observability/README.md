# DeployGuard Observability

Pre-built dashboards and monitors for DeployGuard's OpenTelemetry spans.

## Span Schema

DeployGuard exports a single span per evaluation:

| Attribute                                | Type   | Description                                                                                                                          |
| ---------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `service.name`                           | string | Always `deployguard`                                                                                                                 |
| `service.namespace`                      | string | `owner/repo`                                                                                                                         |
| `deployguard.repo`                       | string | `owner/repo`                                                                                                                         |
| `deployguard.commit_sha`                 | string | Commit SHA being evaluated                                                                                                           |
| `deployguard.decision`                   | string | `allow`, `warn`, or `block`                                                                                                          |
| `deployguard.risk_score`                 | int    | Risk score (0-100)                                                                                                                   |
| `deployguard.health_score`               | int    | Health score (0-100)                                                                                                                 |
| `deployguard.evaluation_ms`              | int    | Evaluation duration in ms                                                                                                            |
| `deployguard.pr_number`                  | int    | PR number (when available)                                                                                                           |
| `deployguard.file_count`                 | int    | Number of files changed                                                                                                              |
| `deployguard.factor.<type>`              | int    | Per-factor risk score (e.g. `code_churn`, `file_count`, `sensitive_files`, `test_coverage`, `security_alerts`, `deployment_history`) |
| `deployguard.health.<target>.status`     | string | Per-endpoint health status                                                                                                           |
| `deployguard.health.<target>.latency_ms` | int    | Per-endpoint latency                                                                                                                 |

Span name: `deployguard.evaluate`  
Span kind: `INTERNAL`  
Status code: `OK` (1) for allow/warn, `ERROR` (2) for block

## Enabling OTel Export

Add these inputs to the DeployGuard action:

```yaml
- uses: dschirmer-shiftkey/deployguard@v3
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    otel-endpoint: https://your-collector:4318
    otel-headers: Authorization=Bearer ${{ secrets.OTEL_TOKEN }}
```

Or set environment variables:

```yaml
env:
  OTEL_EXPORTER_OTLP_ENDPOINT: https://your-collector:4318
  OTEL_EXPORTER_OTLP_HEADERS: Authorization=Bearer ${{ secrets.OTEL_TOKEN }}
```

## Grafana + Tempo

### Prerequisites

- Grafana 10+ with the Tempo data source configured
- An OTLP-compatible collector (Grafana Alloy, OpenTelemetry Collector, or Tempo directly)

### Import

1. In Grafana, go to **Dashboards > Import**
2. Upload `grafana-dashboard.json` or paste its contents
3. Select your Tempo data source when prompted
4. Click **Import**

### What You Get

| Panel                     | Description                                      |
| ------------------------- | ------------------------------------------------ |
| Total Evaluations         | Count of gate runs in the time window            |
| Block Rate                | Number of blocked deployments                    |
| Avg Risk Score            | Mean risk score with green/yellow/red thresholds |
| Avg Health Score          | Mean health score                                |
| Avg Evaluation Time       | Mean gate latency                                |
| Warn Rate                 | Number of warned deployments                     |
| Risk Score Over Time      | Time series of risk decisions                    |
| Gate Decisions            | Donut chart: allow/warn/block split              |
| Risk Factors              | Horizontal bar chart of average factor scores    |
| Health Check Latency      | Evaluation duration trend                        |
| Recent Evaluations        | Table of latest spans with scores and decisions  |
| Evaluations by Repository | Stacked bar chart by `service.namespace`         |

### Customizing

The dashboard uses a `repository` template variable bound to `resource.service.namespace`. Use it to filter to a specific repo.

## Datadog

### Prerequisites

- Datadog with APM and Trace Analytics enabled
- An OTLP-compatible intake (Datadog Agent with OTLP receiver, or Datadog exporter in your OTel Collector)

### Collector Config (Datadog Agent)

```yaml
# datadog.yaml
otlp_config:
  receiver:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318
```

Point DeployGuard's `otel-endpoint` at `http://your-agent:4318`.

### Import Dashboard

```bash
curl -X POST "https://api.datadoghq.com/api/v1/dashboard" \
  -H "DD-API-KEY: ${DD_API_KEY}" \
  -H "DD-APPLICATION-KEY: ${DD_APP_KEY}" \
  -H "Content-Type: application/json" \
  -d @datadog-dashboard.json
```

### Import Monitors

```bash
for monitor in $(jq -c '.monitors[]' datadog-monitors.json); do
  curl -X POST "https://api.datadoghq.com/api/v1/monitor" \
    -H "DD-API-KEY: ${DD_API_KEY}" \
    -H "DD-APPLICATION-KEY: ${DD_APP_KEY}" \
    -H "Content-Type: application/json" \
    -d "$monitor"
done
```

### What You Get

**Dashboard:**

| Widget                   | Description                 |
| ------------------------ | --------------------------- |
| Evaluations              | Total count                 |
| Block Rate               | Blocked deployment count    |
| Avg Risk Score           | Color-coded risk average    |
| Avg Health Score         | Color-coded health average  |
| p95 Evaluation Time      | Latency percentile          |
| Warn Count               | Warning count               |
| Gate Decisions Over Time | Stacked bar by decision     |
| Risk Score Distribution  | Histogram of risk scores    |
| Risk Score by Repository | Per-repo risk trend         |
| Top Risk Factors         | Ranked code churn by repo   |
| Recent Evaluations       | Live stream of latest spans |

**Monitors (5):**

| Monitor                      | Threshold         | Severity |
| ---------------------------- | ----------------- | -------- |
| High block rate              | >5 blocks/hour    | Critical |
| Risk score spike             | Avg >70 over 30m  | Critical |
| Health score degradation     | Avg <50 over 15m  | High     |
| Slow evaluation latency      | p95 >15s over 30m | Warning  |
| No evaluations (silent gate) | 0 evals in 6h     | Warning  |

All monitors send to `@slack-deployguard-alerts` by default — update the `message` field with your notification channels.

## Terraform

If you manage Datadog via Terraform, you can import the monitor JSON into `datadog_monitor` resources:

```hcl
resource "datadog_monitor" "deployguard_block_rate" {
  name    = "[DeployGuard] High block rate"
  type    = "trace-analytics alert"
  query   = "trace-analytics(\"deployguard.decision:block service:deployguard\").rollup(\"count\").by(\"resource_name\").last(\"1h\") > 5"
  message = "DeployGuard blocked >5 deployments in 1h. @slack-deployguard-alerts"

  monitor_thresholds {
    critical = 5
    warning  = 2
  }

  tags = ["service:deployguard", "team:platform"]
}
```
