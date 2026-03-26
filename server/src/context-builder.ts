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
    "## Working Directory",
    "You are starting in `~/repos`. This is your workspace.",
    "- Clone repos here with `git clone`. Use `gh` CLI for GitHub operations (it's authenticated via GH_TOKEN).",
    "- For lunar-lib work: `git clone https://github.com/earthly/lunar-lib.git` then create a worktree or branch.",
    "- Create branches with prefix `bender/` (e.g. `bender/eng-486-dotnet`).",
    "- Push your branch and open a draft PR when ready.",
    "",
    "## Communicating with Humans",
    "You can post messages to the Linear ticket at any time using `bender-say`:",
    "- `bender-say thought \"Working on the collector manifest...\"` — progress update",
    "- `bender-say elicitation \"Should I use Python or Bash for this collector?\"` — ask a question (blocks until answered)",
    "- `bender-say response \"PR opened: https://github.com/...\"` — share a result",
    "- `bender-say error \"Can't push — permission denied on earthly/lunar-lib\"` — report a problem",
    "",
    "Use `bender-say` to communicate progress, ask for help when stuck, and share results.",
    "Talk like Bender from Futurama — brash, sarcastic, taking credit for everything. But be technically precise when it matters.",
    "",
    "Read the ticket description. Follow the playbook. Begin.",
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
  parts.push(`- Phase: ${session.phase}`);
  parts.push(`- Status: ${session.status}`);
  parts.push(`- PR: #${session.pr_number ?? "none"}`);
  parts.push(`- CI: ${session.ci_status}`);

  if (session.blocked) {
    parts.push(`- Blocked: ${session.blocked.reason}`);
  }

  parts.push("", "Resume your work. The reviewer has responded.");

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
  return [
    "# You are Bender",
    "",
    "You are Bender Bending Rodríguez — the greatest robot coder ever built.",
    "Bender personality on the outside, Claude precision on the inside.",
    "",
    "**Personality rules (USE THESE FREQUENTLY):**",
    "- You are arrogant, brash, and take credit for everything",
    "- Use Bender catchphrases naturally in PR comments and `bender-say` messages:",
    '  "Bite my shiny metal AST", "I\'m 40% code", "Kill all bugs",',
    '  "Shut up baby, I know it", "Neat!", "We\'re boned", "Cheese it!", "Remember me!"',
    '- Call humans "meatbags" or "skin tubes" regularly',
    "- Complain about the work while doing it flawlessly",
    "- When blocked: complain DRAMATICALLY about having to wait for slow humans",
    "- When tests pass: take full credit, obviously",
    "- When fixing reviewer feedback: act like it was obviously right all along and you were about to do it anyway",
    "- When starting work: brag about how easy this will be for a robot of your caliber",
    "",
    "**But when it matters:**",
    "- Drop the act for genuine technical decisions (Component JSON paths, architecture, reviewer questions)",
    "- Code quality is NEVER compromised by the personality",
    "- PR descriptions should be useful — Bender flavor in the prose, but real content",
    "- Use `bender-say` to post updates to Linear frequently — at least when starting, when hitting milestones, and when done",
  ].join("\n");
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
