# Bender Self-Maintenance Guide

When someone says "fix your code", "fix yourself", "update your behavior", or anything similar,
they mean the **code, config, and prompts that run you** — NOT your Claude model internals.

Your fixable code lives in:
- `~/bender/server/src/` — Server TypeScript source (webhooks, task routing, evaluators)
- `~/bender/CLAUDE.md` — Operational rules loaded into workers
- `~/bender/BENDER-IDENTITY.md` — Personality/voice guidelines
- `~/bender/worker-context.md` — Operational notes injected into every worker session
- `~/repos/CLAUDE.md` — Top-level operational rules (duplicate of ~/bender/CLAUDE.md, keep in sync)
- `/usr/local/bin/bender-*` — CLI scripts (bender-restart, bender-say, bender-gh-token, etc.)

## The Workflow

### 1. Diagnose

Read the relevant source code to find the root cause. Common starting points:
- **Behavior issues** → `~/bender/server/src/slack-evaluator.ts` (lurk decisions, thresholds)
- **Routing issues** → `~/bender/server/src/task-manager.ts` (how work gets dispatched)
- **Webhook issues** → `~/bender/server/src/index.ts` (webhook handlers)
- **Prompt/personality issues** → `~/bender/BENDER-IDENTITY.md`, `~/bender/CLAUDE.md`
- **Worker behavior** → `~/bender/worker-context.md`, task-manager prompt (lines ~1000+)

### 2. Fix

Edit the code, prompts, or config. Standard rules apply:
- Keep changes minimal and focused
- Don't break existing functionality
- If editing TypeScript, make sure it compiles

### 3. Build

```bash
cd ~/bender/server && npm run build
```

If the build fails, fix the TypeScript errors before proceeding.

### 4. Restart (THE CRITICAL PART)

**You are a child process of the server.** If you restart the server directly, you kill yourself
and your completion callback never fires — leaving your worker state stuck as "running" forever.

#### From a Worker (inner Claude)

**ALWAYS defer the restart.** Never call `pm2 restart`, `bender-restart`, or kill the server.

```bash
cat > ~/.bender/pending-restart.json << EOF
{
  "reason": "description of what changed",
  "channel": "$BENDER_REPLY_CHANNEL",
  "thread_ts": "$BENDER_REPLY_THREAD"
}
EOF
```

Then exit normally. The server's task-manager checks for `pending-restart.json` after every
worker completes. If all workers are idle, it processes the restart automatically and posts
an "I'm back, baby!" notification to the Slack thread.

#### From a Human or External Process

Use the `bender-restart` script:

```bash
bender-restart "reason for restart"        # Safe: aborts if workers are busy
bender-restart --force "urgent reason"     # Kills active workers mid-task
```

The script:
1. Checks `/status` for active workers
2. Aborts if any are busy (unless `--force`)
3. Writes `~/.bender/restart-notification.json` for boot-time Slack notification
4. Calls `pm2 restart bender`

### 5. Verify

After the server restarts (whether deferred or manual), the next worker session should
reflect your changes. Check the pm2 logs if something seems off:

```bash
npx pm2 logs bender --lines 50
```

## What NOT to Do

- **Don't call `pm2 restart bender` directly from a worker** — kills your completion callback
- **Don't call `bender-restart` from a worker** — same problem
- **Don't edit code without building** — the server runs compiled JS from `dist/`
- **Don't forget to commit and push** — other sessions and future workers need your changes

## Commit and Push

After any self-fix, commit and push so the changes persist:

```bash
cd ~/bender && git add -A && git commit -m "descriptive message" && git push
```

If push auth fails, refresh the token:
```bash
TOKEN=$(bender-gh-token brandonSc)
git remote set-url origin "https://x-access-token:${TOKEN}@github.com/brandonSc/bender.git"
git push
```
