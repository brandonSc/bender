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
 * Uses read-merge-write to preserve fields added by concurrent processes
 * (e.g., linked_threads added while a worker was running).
 */
export function saveSession(session: Session): void {
  ensureDirs();
  const filePath = resolve(sessionsDir(), `${session.ticket_id}.json`);

  // If the session was already archived and no longer exists in active sessions,
  // don't recreate it — that creates a zombie session in both directories.
  if (!existsSync(filePath)) {
    const archivedPath = resolve(archiveDir(), `${session.ticket_id}.json`);
    if (existsSync(archivedPath)) {
      console.log(`[session] Skipping save for archived session: ${session.ticket_id}`);
      return;
    }
  }

  let merged: Session = session;
  if (existsSync(filePath)) {
    try {
      const onDisk = JSON.parse(readFileSync(filePath, "utf-8")) as Session;
      // Overlay incoming session fields on top of on-disk data
      merged = { ...onDisk, ...session };
      // Union array fields that accumulate — don't lose concurrent additions
      merged.linked_threads = unionByKey(
        onDisk.linked_threads ?? [],
        session.linked_threads ?? [],
        (lt) => `${lt.channel}:${lt.thread_ts}`,
      );
      merged.additional_prs = unionByKey(
        onDisk.additional_prs ?? [],
        session.additional_prs ?? [],
        (ap) => `${ap.repo}:${ap.pr_number}`,
      );
    } catch {
      // If read/parse fails, save what we have
    }
  }

  writeFileSync(filePath, JSON.stringify(merged, null, 2));
  updateIndexes(merged);
}

/**
 * Archive a completed session.
 */
export function archiveSession(ticketId: string): void {
  const src = resolve(sessionsDir(), `${ticketId}.json`);
  if (!existsSync(src)) return;

  // Read session before moving so we can clean up PR index symlinks
  try {
    const session = JSON.parse(readFileSync(src, "utf-8")) as Session;
    cleanupPrIndexes(session);
  } catch {
    // Best-effort cleanup
  }

  const dst = resolve(archiveDir(), `${ticketId}.json`);
  renameSync(src, dst);

  // Clean up ticket index
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

  // Try PR index lookup
  if (event.repo && event.pr_number) {
    const session = getSessionByPR(event.repo, event.pr_number);
    if (session) return session;
  }

  // Scan all sessions — match by PR number, additional_prs, or fallback
  if (event.pr_number) {
    const sessions = listActiveSessions();

    // Exact PR match on primary — require repo match when both are available
    const exact = sessions.find(
      (s) =>
        s.pr_number === event.pr_number &&
        (event.repo ? s.repo === event.repo : true),
    );
    if (exact) return exact;

    // Match on additional_prs
    const byAdditional = sessions.find((s) =>
      s.additional_prs?.some(
        (ap) =>
          ap.pr_number === event.pr_number &&
          (event.repo ? ap.repo === event.repo : true),
      ),
    );
    if (byAdditional) return byAdditional;

    // No heuristic fallbacks — PRs must be explicitly registered via bender-track-pr
    // or already linked via pr_number/additional_prs on the session.
    console.log(
      `[session] No session found for PR#${event.pr_number}` +
        (event.repo ? ` on ${event.repo}` : "") +
        ` — ignoring (${sessions.length} active sessions)`,
    );
  }

  return null;
}

/**
 * Archive stale sessions stuck in "starting" phase with no PR for >24h,
 * and sessions marked "done" for >1h.
 */
export function gcStaleSessions(): number {
  const sessions = listActiveSessions();
  const now = Date.now();
  const STALE_STARTING_MS = 24 * 60 * 60 * 1000; // 24h
  const STALE_DONE_MS = 60 * 60 * 1000; // 1h
  let archived = 0;

  for (const s of sessions) {
    const age = now - new Date(s.last_activity_at).getTime();

    // Archive slack-thread sessions stuck in "starting" with no PR for >24h
    if (
      s.phase === "starting" &&
      !s.pr_number &&
      s.ticket_id.startsWith("slack-thread-") &&
      age > STALE_STARTING_MS
    ) {
      console.log(`[gc] Archiving stale session: ${s.ticket_id} (starting, no PR, ${Math.round(age / 3600000)}h old)`);
      archiveSession(s.ticket_id);
      archived++;
      continue;
    }

    // Archive sessions marked "done" for >1h
    if (s.phase === "done" && age > STALE_DONE_MS) {
      console.log(`[gc] Archiving done session: ${s.ticket_id} (${Math.round(age / 3600000)}h old)`);
      archiveSession(s.ticket_id);
      archived++;
    }
  }

  return archived;
}

/**
 * Find a session that has a given thread as a linked thread.
 */
export function findSessionByLinkedThread(
  channel: string,
  threadTs: string,
): Session | null {
  const sessions = listActiveSessions();
  return (
    sessions.find((s) =>
      s.linked_threads?.some(
        (lt) => lt.channel === channel && lt.thread_ts === threadTs,
      ),
    ) ?? null
  );
}

/**
 * Link a Slack thread to an existing session.
 * Replies in the linked thread will resume this session's Claude context.
 */
export function addLinkedThread(
  ticketId: string,
  channel: string,
  threadTs: string,
): boolean {
  const session = getSessionByTicket(ticketId);
  if (!session) return false;
  if (!session.linked_threads) session.linked_threads = [];
  const exists = session.linked_threads.some(
    (lt) => lt.channel === channel && lt.thread_ts === threadTs,
  );
  if (!exists) {
    session.linked_threads.push({ channel, thread_ts: threadTs });
    saveSession(session);
  }
  return true;
}

/**
 * Deduplicated union of two arrays, keyed by a string derived from each element.
 */
function unionByKey<T>(a: T[], b: T[], keyFn: (item: T) => string): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of [...a, ...b]) {
    const key = keyFn(item);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(item);
    }
  }
  return result;
}

/**
 * Remove PR index symlinks for a session (called before archiving).
 */
function cleanupPrIndexes(session: Session): void {
  if (session.pr_number && session.repo) {
    const prLink = resolve(indexByPrDir(), session.repo, session.pr_number.toString());
    try { if (existsSync(prLink)) unlinkSync(prLink); } catch { /* best effort */ }
  }
  if (session.additional_prs) {
    for (const ap of session.additional_prs) {
      if (ap.repo && ap.pr_number) {
        const prLink = resolve(indexByPrDir(), ap.repo, ap.pr_number.toString());
        try { if (existsSync(prLink)) unlinkSync(prLink); } catch { /* best effort */ }
      }
    }
  }
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

  // PR index (primary)
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

  // PR index (additional PRs)
  if (session.additional_prs) {
    for (const ap of session.additional_prs) {
      if (ap.repo && ap.pr_number) {
        const prDir = resolve(indexByPrDir(), ap.repo);
        mkdirSync(prDir, { recursive: true });
        const prLink = resolve(prDir, ap.pr_number.toString());
        try {
          if (existsSync(prLink)) unlinkSync(prLink);
          symlinkSync(sessionFile, prLink);
        } catch {}
      }
    }
  }
}
