import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { handleDeploymentProtectionRule, verifySignature } from "./handler.js";

const app = new Hono();

app.get("/health", (c) => c.json({ status: "ok", service: "deployguard-app" }));

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
    console.error("Webhook handler error:", err);
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

  try {
    const payload = JSON.parse(rawBody);
    return c.json({ received: true, type: payload.type ?? "unknown" });
  } catch {
    return c.json({ error: "invalid JSON" }, 400);
  }
});

app.get("/.well-known/deployguard.json", (c) =>
  c.json({
    name: "DeployGuard",
    version: "3.0.0",
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
console.log(`DeployGuard App listening on port ${port}`);
serve({ fetch: app.fetch, port });
