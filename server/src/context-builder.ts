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

  const parts = [
    identity,
    "",
    "## Playbook",
    playbook,
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
    "- Follow the playbook from `.ai-implementation/` — it defines the spec-first workflow.",
    "- Push your branch and open a draft PR when ready.",
    "",
    "## Communicating",
    "- `bender-say thought \"...\"` — progress update to Linear",
    "- `bender-say response \"...\"` — share a result",
    "- `bender-say error \"...\"` — report a problem",
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
      `**You already have PR #${session.pr_number} open for this ticket.** Do NOT start over or create a new PR.`,
      "Check the PR state and continue from where you left off.",
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
    }
  } else if (event.comment_body && event.source === "linear") {
    parts.push(
      "",
      "## Instructions",
      "Respond to the human's message above. Reply using `bender-say` to keep the conversation in Linear.",
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

  const parts = [
    identity,
    "",
    "## Playbook",
    playbook,
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
