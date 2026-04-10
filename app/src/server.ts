import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { handleDeploymentProtectionRule } from "./handler.js";

const app = new Hono();

app.get("/health", (c) => c.json({ status: "ok", service: "deployguard-app" }));

app.post("/webhook", async (c) => {
  const event = c.req.header("x-github-event");
  if (event !== "deployment_protection_rule") {
    return c.json({ skipped: true, reason: `unhandled event: ${event}` }, 200);
  }

  const payload = await c.req.json();
  const signature = c.req.header("x-hub-signature-256") ?? "";

  try {
    await handleDeploymentProtectionRule(payload, signature);
    return c.json({ ok: true });
  } catch (err) {
    console.error("Webhook handler error:", err);
    return c.json({ error: "internal error" }, 500);
  }
});

app.get("/.well-known/deployguard.json", (c) =>
  c.json({
    name: "DeployGuard",
    version: "2.0.0",
    description: "Deployment gate — scores code risk, checks production health, blocks dangerous releases.",
    capabilities: [
      "deployment-protection-rule",
      "risk-scoring",
      "health-checks",
      "dora-metrics",
    ],
    homepage: "https://github.com/dschirmer-shiftkey/deployguard",
  }),
);

const port = parseInt(process.env.PORT ?? "3000", 10);
console.log(`DeployGuard App listening on port ${port}`);
serve({ fetch: app.fetch, port });
