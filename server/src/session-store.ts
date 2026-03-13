import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  symlinkSync,
  unlinkSync,
  readdirSync,
  renameSync,
  readlinkSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { getBenderDir } from "./config.js";
import type { Session } from "./types.js";

function sessionsDir(): string {
  return resolve(getBenderDir(), "sessions");
}

function indexByTicketDir(): string {
  return resolve(getBenderDir(), "index", "by-ticket");
}

function indexByPrDir(): string {
  return resolve(getBenderDir(), "index", "by-pr");
}

function archiveDir(): string {
  return resolve(getBenderDir(), "archive");
}

function ensureDirs(): void {
  for (const dir of [
    sessionsDir(),
    indexByTicketDir(),
    indexByPrDir(),
    archiveDir(),
  ]) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Create a new session for a ticket.
 */
export function createSession(session: Session): void {
  ensureDirs();
  const filePath = resolve(sessionsDir(), `${session.ticket_id}.json`);
  writeFileSync(filePath, JSON.stringify(session, null, 2));
  updateIndexes(session);
}

/**
 * Get a session by ticket ID.
 */
export function getSessionByTicket(ticketId: string): Session | null {
  const filePath = resolve(sessionsDir(), `${ticketId}.json`);
  if (!existsSync(filePath)) return null;
  return JSON.parse(readFileSync(filePath, "utf-8"));
}

/**
 * Get a session by PR number and repo.
 */
export function getSessionByPR(
  repo: string,
  prNumber: number,
): Session | null {
  const linkPath = resolve(indexByPrDir(), repo, prNumber.toString());
  if (!existsSync(linkPath)) return null;

  try {
    const target = readlinkSync(linkPath);
    if (!existsSync(target)) return null;
    return JSON.parse(readFileSync(target, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * Update (save) a session.
 */
export function saveSession(session: Session): void {
  ensureDirs();
  const filePath = resolve(sessionsDir(), `${session.ticket_id}.json`);
  writeFileSync(filePath, JSON.stringify(session, null, 2));
  updateIndexes(session);
}

/**
 * Archive a completed session.
 */
export function archiveSession(ticketId: string): void {
  const src = resolve(sessionsDir(), `${ticketId}.json`);
  if (!existsSync(src)) return;

  const dst = resolve(archiveDir(), `${ticketId}.json`);
  renameSync(src, dst);

  // Clean up indexes
  const ticketLink = resolve(indexByTicketDir(), ticketId);
  if (existsSync(ticketLink)) unlinkSync(ticketLink);
}

/**
 * List all active sessions.
 */
export function listActiveSessions(): Session[] {
  ensureDirs();
  const files = readdirSync(sessionsDir()).filter((f) => f.endsWith(".json"));
  return files.map((f) => {
    const content = readFileSync(resolve(sessionsDir(), f), "utf-8");
    return JSON.parse(content) as Session;
  });
}

/**
 * Find a session for a GitHub event (by PR number or ticket ID).
 */
export function findSessionForEvent(event: {
  repo?: string;
  pr_number?: number;
  ticket_id?: string;
}): Session | null {
  // Try ticket ID first
  if (event.ticket_id) {
    return getSessionByTicket(event.ticket_id);
  }

  // Try PR lookup
  if (event.repo && event.pr_number) {
    return getSessionByPR(event.repo, event.pr_number);
  }

  // Scan all sessions for matching PR number
  if (event.pr_number) {
    const sessions = listActiveSessions();
    return (
      sessions.find(
        (s) =>
          s.pr_number === event.pr_number &&
          (!event.repo || s.repo === event.repo),
      ) ?? null
    );
  }

  return null;
}

function updateIndexes(session: Session): void {
  // Ticket index
  const ticketLink = resolve(indexByTicketDir(), session.ticket_id);
  const sessionFile = resolve(sessionsDir(), `${session.ticket_id}.json`);
  try {
    if (existsSync(ticketLink)) unlinkSync(ticketLink);
    symlinkSync(sessionFile, ticketLink);
  } catch {
    // Symlink may fail on some systems, that's OK — we have fallback lookups
  }

  // PR index
  if (session.pr_number && session.repo) {
    const prDir = resolve(indexByPrDir(), session.repo);
    mkdirSync(prDir, { recursive: true });
    const prLink = resolve(prDir, session.pr_number.toString());
    try {
      if (existsSync(prLink)) unlinkSync(prLink);
      symlinkSync(sessionFile, prLink);
    } catch {
      // Same fallback
    }
  }
}
