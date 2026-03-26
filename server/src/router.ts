import type { TaskEvent, Session, Phase } from "./types.js";
import {
  findSessionForEvent,
  createSession,
  saveSession,
} from "./session-store.js";
import { resolve } from "node:path";

const REPOS_DIR = resolve(process.env.HOME ?? "/home/ubuntu", "repos");

export interface RouteResult {
  action: "invoke" | "skip" | "cancel";
  session: Session;
  event: TaskEvent;
  isNewSession: boolean;
  needsCheckpoint: boolean;
}

/**
 * Route an incoming event to the appropriate session and determine the action.
 */
export function routeEvent(event: TaskEvent): RouteResult | null {
  // New ticket from Linear → create session
  if (event.type === "new_ticket" && event.ticket_id) {
    const existing = findSessionForEvent(event);
    if (existing) {
      // Already have a session for this ticket — resume it
      existing.last_event_id = event.id;
      existing.last_activity_at = event.timestamp;
      saveSession(existing);
      return {
        action: "invoke",
        session: existing,
        event,
        isNewSession: false,
        needsCheckpoint: false,
      };
    }

    const session = newSession(event);
    createSession(session);
    return {
      action: "invoke",
      session,
      event,
      isNewSession: true,
      needsCheckpoint: false,
    };
  }

  // Agent prompt — user sent a follow-up in an existing AgentSession
  if (event.type === "agent_prompt" && event.ticket_id) {
    const existing = findSessionForEvent(event);
    if (!existing) return null;

    if (event.agent_session_id && !existing.agent_session_id) {
      existing.agent_session_id = event.agent_session_id;
    }
    existing.last_event_id = event.id;
    existing.last_activity_at = event.timestamp;
    existing.status = "active";
    if (existing.blocked) existing.blocked = null;
    saveSession(existing);
    return {
      action: "invoke",
      session: existing,
      event,
      isNewSession: false,
      needsCheckpoint: false,
    };
  }

  // GitHub events → find existing session
  const session = findSessionForEvent(event);
  if (!session) {
    // No session for this PR/event — ignore
    return null;
  }

  // Update activity timestamp
  session.last_event_id = event.id;
  session.last_activity_at = event.timestamp;

  // Handle specific event types
  switch (event.type) {
    case "ci_failure":
      session.ci_status = "failing";
      session.status = "active";
      saveSession(session);
      return {
        action: "invoke",
        session,
        event,
        isNewSession: false,
        needsCheckpoint: false,
      };

    case "reviewer_unblock":
      updatePhaseOnUnblock(session, event);
      session.status = "active";
      if (session.blocked) session.blocked = null;
      saveSession(session);
      return {
        action: "invoke",
        session,
        event,
        isNewSession: false,
        needsCheckpoint: false,
      };

    case "reviewer_comment":
      session.status = "active";
      saveSession(session);
      return {
        action: "invoke",
        session,
        event,
        isNewSession: false,
        needsCheckpoint: false,
      };

    case "pr_review":
      if (event.review_state === "approved") {
        updateApprovalsOnReview(session, event);
      }
      session.status = "active";
      saveSession(session);
      return {
        action: "invoke",
        session,
        event,
        isNewSession: false,
        needsCheckpoint: false,
      };

    case "informational":
      // CI pass, PR merged, push events — update state but may not need invocation
      if (event.id.startsWith("pr_merged:")) {
        session.phase = "done";
        session.status = "done";
        saveSession(session);
        return {
          action: "invoke", // Let Claude do cleanup (Linear status, archive)
          session,
          event,
          isNewSession: false,
          needsCheckpoint: false,
        };
      }
      // CI pass
      if (event.id.startsWith("check_suite:")) {
        session.ci_status = "passing";
        saveSession(session);
        return { action: "skip", session, event, isNewSession: false, needsCheckpoint: false };
      }
      saveSession(session);
      return { action: "skip", session, event, isNewSession: false, needsCheckpoint: false };

    default:
      return null;
  }
}

function newSession(event: TaskEvent): Session {
  const ticketId = event.ticket_id!;
  const branchName = `bender/${ticketId.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`;

  return {
    ticket_id: ticketId,
    ticket_title: event.ticket_title ?? "",
    ticket_url: event.ticket_url ?? "",

    repo: "", // Claude determines the repo from the ticket context
    pr_number: null,
    branch: branchName,

    phase: "starting",
    status: "active",

    go_ahead: { brandon: false, vlad: false, override: null },
    approvals: { brandon: false, vlad: false, override: null },

    blocked: null,

    last_event_id: event.id,
    last_activity_at: event.timestamp,
    created_at: new Date().toISOString(),

    conversation_summary: "",

    claude_session_id: null,
    agent_session_id: event.agent_session_id ?? null,
    checkpoint_count: 0,
    last_checkpoint_summary: null,

    ticket_notes: [],

    test_results_posted: false,
    ci_status: "unknown",

    worktree_path: resolve(
      REPOS_DIR,
      `wt-${ticketId.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`,
    ),

    retry_count: 0,
    max_retries: 3,
  };
}

function updatePhaseOnUnblock(session: Session, event: TaskEvent): void {
  const author = event.comment_author?.toLowerCase() ?? "";

  if (session.phase === "spec_review") {
    // Track go-aheads
    if (author === "brandonsc") session.go_ahead.brandon = true;
    if (author === "vladaionescu") session.go_ahead.vlad = true;

    // Check if we have enough go-aheads
    const hasGoAhead =
      (session.go_ahead.brandon && session.go_ahead.vlad) ||
      session.go_ahead.override !== null;

    if (hasGoAhead) {
      session.phase = "implementing";
    }
  } else if (session.phase === "impl_review") {
    // Track approvals via review_state
    if (event.review_state === "approved") {
      if (author === "brandonsc") session.approvals.brandon = true;
      if (author === "vladaionescu") session.approvals.vlad = true;
    }

    const hasApproval =
      (session.approvals.brandon && session.approvals.vlad) ||
      session.approvals.override !== null;

    if (hasApproval) {
      session.phase = "merging";
    }
  }
}

function updateApprovalsOnReview(session: Session, event: TaskEvent): void {
  const author = event.comment_author?.toLowerCase() ?? "";
  if (author === "brandonsc") session.approvals.brandon = true;
  if (author === "vladaionescu") session.approvals.vlad = true;
}
