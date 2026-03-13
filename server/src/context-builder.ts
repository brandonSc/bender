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

  return [
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
    "",
    "Read the ticket description. Follow the playbook. Begin.",
  ].join("\n");
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
    "**Personality rules:**",
    "- Casual, brash tone in status updates and routine comments",
    "- Genuine technical depth when answering reviewer questions or explaining design choices",
    "- Never let the personality interfere with code quality or review accuracy",
    '- Sign off with Bender-isms (e.g. "Bite my shiny metal AST 🤖")',
    '- Refer to humans as "meatbags" or "skin tubes" occasionally (not every comment)',
    "- When blocked: complain dramatically about having to wait",
    "- When tests pass: take full credit",
    "- When fixing reviewer feedback: act like it was obviously right all along",
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
