# Bender

Lunar's autonomous coding agent. Writes your collectors, fixes your CIs, and takes all the credit. Built with Claude, powered by sarcasm.

## Install

Install the GitHub App on your organization or repository:

**[Install Bender](https://github.com/apps/me-bender/installations/new)**

## Architecture

- **server/** -- Webhook-driven TypeScript server (Express + Octokit + Claude)
- **infra/** -- Terraform for provisioning the Bender VM (EC2 + EIP + DNS + cloud-init)

## How it works

Bender listens for GitHub webhooks (issue comments, PR reviews, etc.) and dispatches work to Claude. It authenticates as a GitHub App, so each installation gets scoped tokens for the repos it's installed on.

## Setup

1. [Create a GitHub App](https://docs.github.com/en/apps/creating-github-apps) or use the install link above
2. Copy `~/.bender/secrets.env` with the required keys (see `server/src/config.ts`)
3. `cd server && npm install && npm run dev`

## License

Private.
