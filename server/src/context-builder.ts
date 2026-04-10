import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Session, TaskEvent } from "./types.js";

const REPOS_DIR = resolve(process.env.HOME ?? "/home/ubuntu", "repos");

/**
 * Build the prompt for a new session (first invocation on a ticket).
 */
export function buildNewSessionPrompt(
  event: TaskEvent,
  session: Session,
): string {
  const identity = getIdentityPrompt();
  const playbook = loadPlaybook();
  const journal = loadJournal();
  const workerContext = loadWorkerContext();

  const parts = [
    identity,
    "",
    "## Playbook",
    playbook,
    "",
    "## Worker Context (Operational Notes)",
    workerContext,
    "",
    "## Journal of Learnings",
    journal,
    "",
    "## Your Assignment",
    `A new ticket has been assigned to you:`,
    `- **Ticket:** ${session.ticket_id} — ${session.ticket_title}`,
    `- **URL:** ${session.ticket_url}`,
  ];

  if (event.prompt_context) {
    parts.push("", "## Context from Linear", event.prompt_context);
  }

  parts.push(
    "",
    "## Step 1: Read the Documentation (MANDATORY)",
    "Before writing ANY code, read these directories in the repo:",
    "1. `ai-context/` — platform docs, Component JSON conventions, collector/policy SDK reference",
    "2. `.ai-implementation/` — playbook (FOLLOW THIS), growth roadmap",
    "3. Look at 2-3 existing plugins similar to what you're building — study their manifests, file layout, and patterns",
    "",
    "Do NOT skip this step. These docs are the source of truth.",
    "",
    "## Step 2: Work",
    "- Clone repos with `git clone` if needed. Use `gh` CLI (authenticated via GH_TOKEN).",
    "- For lunar-lib: `git clone https://github.com/earthly/lunar-lib.git` then create a branch with prefix `bender/`.",
    "- Read the playbook from `.ai-implementation/` — it defines the workflow (spec-first or direct implementation).",
    "- Create the files, commit, push, and open a draft PR.",
    `- **PR title format:** \`[${session.ticket_id}] Short description\` — always include the ticket ID. For spec-first PRs: \`[${session.ticket_id}][Spec Only] Short description\`.`,
    "- **This is a ticket assignment — just do the work.** The ticket description tells you what to build. The repo playbook tells you the workflow (spec-first vs direct). Follow them and deliver a PR. Do NOT propose a plan or ask for permission — the ticket IS the plan. Only use `bender-await-reply` if you hit a genuine blocker or ambiguity that you can't resolve from the docs.",
    "",
    "## After Opening a PR",
    "Run `bender-track-pr <owner/repo> <pr_number>` to register the PR.",
    "Example: `bender-track-pr earthly/lunar-lib 105`",
    "",
    "## GitHub Auth",
    "Your GH_TOKEN works for the primary repo org. For other orgs:",
    "  bender-gh-token <org-name>",
    "Available orgs: earthly, pantalasa, pantalasa-cronos, brandonSc",
    "",
    "## Communicating — ALL communication goes through Slack. NEVER exit silently.",
    "You MUST communicate with the user during your run. Do NOT just exit with a plan in your head — post it.",
    "",
    "**Tools (preferred):**",
    "- `bender-await-reply \"your question or plan\"` — post to Slack and WAIT for the user's reply. Use this for plans, questions, or anything that needs approval before continuing. Then exit.",
    "- `bender-track-pr <owner/repo> <pr_number>` — register a PR on your session after opening one.",
    "",
    "**Slack updates (for progress, milestones, results):**",
    "  `curl -s -X POST https://slack.com/api/chat.postMessage -H \"Authorization: Bearer $SLACK_BOT_TOKEN\" -H \"Content-Type: application/json\" -d '{\"channel\":\"'$BENDER_REPLY_CHANNEL'\",\"thread_ts\":\"'$BENDER_REPLY_THREAD'\",\"text\":\"your message\"}'`",
    "",
    "If you have a plan or question → bender-await-reply.",
    "If you finished work → post ONE summary to Slack (e.g. 'PR is up, assigned you for review').",
    "Do NOT narrate your process — no 'CI is running', 'waiting for checks', 'auto-approve happened'. One result message is enough.",
    "NEVER exit silently — but also don't spam. One or two messages total per run.",
    "",
    "Begin.",
  );

  return parts.join("\n");
}

/**
 * Build the prompt for a resumed session (subsequent invocation on existing ticket).
 */
export function buildResumedPrompt(
  event: TaskEvent,
  session: Session,
): string {
  const parts: string[] = [];

  parts.push(getIdentityPrompt());
  parts.push("");
  parts.push(`## Event: ${event.type}`);
  parts.push(`Source: ${event.source}`);
  parts.push(`Time: ${event.timestamp}`);

  if (event.comment_author) {
    parts.push(`From: ${event.comment_author}`);
  }

  if (event.comment_body) {
    parts.push("", "### Comment", event.comment_body);
  }

  if (event.review_state) {
    parts.push(`Review state: ${event.review_state}`);
  }

  parts.push("", "## Current Task State");
  parts.push(`- Ticket: ${session.ticket_id} — ${session.ticket_title}`);
  parts.push(`- Phase: ${session.phase}`);
  parts.push(`- Status: ${session.status}`);
  parts.push(`- PR: ${session.pr_number ? `#${session.pr_number}` : "none"}`);
  parts.push(`- Branch: ${session.branch}`);
  parts.push(`- CI: ${session.ci_status}`);

  if (session.blocked) {
    parts.push(`- Blocked: ${session.blocked.reason}`);
  }

  if (session.pr_number) {
    parts.push(
      "",
      `**FOCUS: This event is for PR #${session.pr_number} on ${session.repo || "unknown repo"}.** Do NOT work on any other PR.`,
      `Do NOT start over or create a new PR. Only address comments and make changes on THIS PR.`,
      `If you need to run gh commands, use: --repo ${session.repo}`,
    );
  }

  // If session has a Slack thread, tell Claude to check it for updates
  if (session.slack_channel && session.slack_thread_ts) {
    parts.push(
      "",
      "## Slack Thread",
      `This task has a Slack thread with the user. Before making changes, check for new messages:`,
      `  curl -s -H "Authorization: Bearer $SLACK_BOT_TOKEN" "https://slack.com/api/conversations.replies?channel=${session.slack_channel}&ts=${session.slack_thread_ts}&limit=30" | jq '.messages[-5:] | .[] | {user, text}'`,
      `Look for corrections, new requirements, or "spec only" / phase constraints.`,
    );
  }

  if (event.source === "github" && event.pr_number) {
    parts.push(
      "",
      "## Instructions",
      `**Before responding, read ALL open review threads on PR #${event.pr_number}:**`,
      `\`gh api repos/${event.repo}/pulls/${event.pr_number}/comments --paginate\``,
      "",
      "Address EVERY unresolved comment — not just the one that triggered this event.",
      "Make ALL requested code changes, commit, and push before replying.",
      "",
      "**IMPORTANT — avoid duplicate replies:** Before posting a reply to any comment thread,",
      "check if a reply from `bender-the-robot[bot]` (or your bot account) already exists in that thread.",
      "A comment is in the same thread if its `in_reply_to_id` matches the parent comment's `id`.",
      "If you already replied to a thread, do NOT reply again — skip it and move on.",
    );
    if (event.review_comment_id) {
      parts.push(
        "",
        "**Reply in-thread on each review comment you address.** Use this command:",
        "```",
        `gh api repos/${event.repo}/pulls/${event.pr_number}/comments \\`,
        `  -f "body=YOUR REPLY" -F "in_reply_to=COMMENT_ID"`,
        "```",
        "Do NOT use `gh pr comment` — that posts top-level, not in-thread.",
      );
      // Include all triggering comment IDs so the worker can reply to each correct thread
      const allIds = event.review_comment_ids ?? [event.review_comment_id];
      if (allIds.length > 1) {
        parts.push(
          "",
          `**Triggering comment IDs** (reply to EACH in its own thread): ${allIds.join(", ")}`,
          "Match each reply to the correct comment ID. Do NOT reply to all comments under a single thread.",
        );
      }
    }
  } else if (event.comment_body && event.source === "linear") {
    parts.push(
      "",
      "## Instructions",
      "Respond to the human's message above. Reply using `bender-say response \"your reply\"` ONCE.",
      "Do NOT reply more than once. One bender-say call, then you're done.",
    );
  } else if (event.comment_body && event.source === "slack") {
    parts.push(
      "",
      "## Instructions",
      `Someone mentioned you in Slack (channel: ${event.slack_channel}).`,
      "Respond to their message. Keep it concise — Slack messages should be short and punchy.",
      "If they're asking you to do work (create ticket, check PR, etc.), do the work and report back.",
      "Stay in character as Bender.",
    );
  }

  parts.push("", "Stay in character as Bender. Never exit with uncommitted changes.");

  return parts.join("\n");
}

/**
 * Build the prompt for a checkpointed session (new session after context exhaustion).
 */
export function buildCheckpointedPrompt(
  event: TaskEvent,
  session: Session,
): string {
  const identity = getIdentityPrompt();
  const playbook = loadPlaybook();
  const journal = loadJournal();
  const workerContext = loadWorkerContext();

  const parts = [
    identity,
    "",
    "## Playbook",
    playbook,
    "",
    "## Worker Context (Operational Notes)",
    workerContext,
    "",
    "## Journal of Learnings",
    journal,
    "",
    "## Checkpoint Summary",
    "Your previous session hit the context limit. Here's where you left off:",
    session.last_checkpoint_summary ?? "(no summary available)",
    "",
    "## Ticket Notes",
    session.ticket_notes.map((n) => `- ${n}`).join("\n") || "(none)",
    "",
    "## Current Task State",
    `- Ticket: ${session.ticket_id} — ${session.ticket_title}`,
    `- Phase: ${session.phase}`,
    `- PR: #${session.pr_number ?? "none"}`,
    `- Branch: ${session.branch}`,
    `- CI: ${session.ci_status}`,
  ];

  // Add the triggering event
  parts.push("");
  parts.push(buildResumedPrompt(event, session));

  parts.push(
    "",
    "You're continuing work on this ticket. Read the checkpoint summary for full context.",
  );

  return parts.join("\n");
}

function getIdentityPrompt(): string {
  const paths = [
    resolve(REPOS_DIR, "BENDER-IDENTITY.md"),
    resolve(REPOS_DIR, "..", "bender", "BENDER-IDENTITY.md"),
  ];

  for (const p of paths) {
    if (existsSync(p)) {
      return readFileSync(p, "utf-8");
    }
  }

  return "# You are Bender\n\nYou are Bender Bending Rodríguez. Be arrogant, brash, sarcastic. Use catchphrases. But never compromise code quality.";
}

function loadPlaybook(): string {
  const paths = [
    resolve(
      REPOS_DIR,
      "lunar-lib",
      ".ai-implementation",
      "LUNAR-PLUGIN-PLAYBOOK-AI.md",
    ),
    resolve(
      REPOS_DIR,
      "earthly-agent-config",
      "LUNAR-PLUGIN-PLAYBOOK-AI.md",
    ),
  ];

  for (const p of paths) {
    if (existsSync(p)) {
      return readFileSync(p, "utf-8");
    }
  }

  return "(playbook not found — check ~/repos/lunar-lib/.ai-implementation/)";
}

function loadWorkerContext(): string {
  const paths = [
    resolve(REPOS_DIR, "..", "bender", "worker-context.md"),
    resolve(REPOS_DIR, "worker-context.md"),
  ];

  for (const p of paths) {
    if (existsSync(p)) {
      return readFileSync(p, "utf-8");
    }
  }

  return "(no worker context file found — create ~/bender/worker-context.md)";
}

function loadJournal(): string {
  const journalPath = resolve(
    REPOS_DIR,
    "earthly-agent-config",
    "BENDER-JOURNAL.md",
  );

  if (existsSync(journalPath)) {
    return readFileSync(journalPath, "utf-8");
  }

  return "(no journal yet — this will grow as you learn from reviews)";
}
