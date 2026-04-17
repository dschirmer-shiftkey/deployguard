import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { handleDeploymentProtectionRule, verifySignature } from "./handler.js";
import { parseVercelPayload, parseGenericPayload, executeRollback } from "./rollback.js";

function logJson(level: string, msg: string, extra?: Record<string, unknown>): void {
  const entry = {
    level,
    msg,
    service: "deployguard-app",
    ts: new Date().toISOString(),
    ...extra,
  };
  process.stdout.write(JSON.stringify(entry) + "\n");
}

const app = new Hono();

app.get("/health", (c) => c.json({ status: "ok", service: "deployguard-app" }));

app.use("/dashboard/*", serveStatic({ root: "./public" }));
app.get("/dashboard", (c) => c.redirect("/dashboard/dashboard.html"));

app.post("/webhook", async (c) => {
  const event = c.req.header("x-github-event");
  if (event !== "deployment_protection_rule") {
    return c.json({ skipped: true, reason: `unhandled event: ${event}` }, 200);
  }

  const rawBody = await c.req.text();
  const signature = c.req.header("x-hub-signature-256") ?? "";
  const payload = JSON.parse(rawBody);

  try {
    await handleDeploymentProtectionRule(payload, rawBody, signature);
    return c.json({ ok: true });
  } catch (err) {
    logJson("error", "Webhook handler error", { error: String(err) });
    return c.json({ error: "internal error" }, 500);
  }
});

app.post("/webhook/deploy-outcome", async (c) => {
  const secret = process.env.CANARY_WEBHOOK_SECRET ?? "";
  const rawBody = await c.req.text();

  if (secret) {
    const sig =
      c.req.header("x-signature-256") ?? c.req.header("x-hub-signature-256") ?? "";
    if (!verifySignature(rawBody, sig, secret)) {
      return c.json({ error: "invalid signature" }, 401);
    }
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return c.json({ error: "invalid JSON" }, 400);
  }

  const webhookType = (payload as Record<string, unknown>).type as string | undefined;
  const outcome =
    webhookType === "deployment" || (payload as Record<string, unknown>).payload
      ? parseVercelPayload(payload)
      : parseGenericPayload(payload);

  if (!outcome) {
    return c.json({ received: true, parsed: false, type: webhookType ?? "unknown" });
  }

  logJson("info", "Deploy outcome received", {
    status: outcome.status,
    environment: outcome.environment,
    source: outcome.source,
  });

  const rollbackEnabled = process.env.ROLLBACK_ON_FAILURE === "true";

  if (outcome.status === "failure" && rollbackEnabled) {
    const githubToken = process.env.GITHUB_APP_INSTALLATION_TOKEN;
    const repoFullName = process.env.GITHUB_REPOSITORY;
    const rollbackResult = await executeRollback(outcome, githubToken, repoFullName);
    return c.json({
      received: true,
      outcome: {
        status: outcome.status,
        environment: outcome.environment,
        source: outcome.source,
      },
      rollback: rollbackResult,
    });
  }

  return c.json({
    received: true,
    outcome: {
      status: outcome.status,
      environment: outcome.environment,
      source: outcome.source,
    },
  });
});

app.get("/.well-known/deployguard.json", (c) =>
  c.json({
    name: "DeployGuard",
    version: "3.0.2",
    description:
      "Deployment gate — scores code risk, checks production health, blocks dangerous releases.",
    capabilities: [
      "deployment-protection-rule",
      "risk-scoring",
      "health-checks",
      "dora-metrics",
      "security-alerts",
      "canary-hooks",
    ],
    homepage: "https://github.com/dschirmer-shiftkey/deployguard",
  }),
);

const port = parseInt(process.env.PORT ?? "3000", 10);
logJson("info", "Server starting", { port });
serve({ fetch: app.fetch, port });
