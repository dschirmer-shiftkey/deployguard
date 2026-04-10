# DeployGuard App — Deployment Protection Rule

A lightweight webhook server that acts as a GitHub **Custom Deployment Protection Rule**.
When installed on a repository's environment, it automatically evaluates risk and approves
or rejects deployments without any workflow YAML changes.

## How It Works

1. A workflow reaches a job targeting a protected environment (e.g., `production`).
2. GitHub sends a `deployment_protection_rule` webhook to this server.
3. The server fetches the associated PR, scores risk, and responds with `approved` or `rejected`.
4. The deployment proceeds or is blocked based on the response.

## Setup

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GITHUB_APP_ID` | Yes | GitHub App ID |
| `GITHUB_APP_PRIVATE_KEY` | Yes | PEM private key (newlines as `\n`) |
| `GITHUB_WEBHOOK_SECRET` | No | Webhook secret for signature verification |
| `RISK_THRESHOLD` | No | Block above this score (default: 70) |
| `WARN_THRESHOLD` | No | Warn above this score (default: 55) |
| `PORT` | No | Server port (default: 3000) |

### Deploy

```bash
# Docker
docker build -t deployguard-app .
docker run -p 3000:3000 --env-file .env deployguard-app

# Node.js
npm install && npm run build && npm start
```

### Register the GitHub App

1. Create a GitHub App with **Repository permissions**: Actions (read), Deployments (read+write)
2. Subscribe to the `deployment_protection_rule` event
3. Set the webhook URL to `https://your-host/webhook`
4. Install the app on your repository
5. In the repository's environment settings, enable the app as a protection rule
