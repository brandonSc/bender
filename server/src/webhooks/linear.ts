import { createHmac, timingSafeEqual } from "node:crypto";
import type { TaskEvent } from "../types.js";

/**
 * Verify Linear webhook signature (HMAC-SHA256).
 */
export function verifyLinearSignature(
  payload: string,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!signature || !secret) return false;
  const expected = createHmac("sha256", secret).update(payload).digest("hex");
  if (expected.length !== signature.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

/**
 * Parse a Linear webhook event into a TaskEvent (or null if we don't care).
 *
 * Linear sends two kinds of webhooks relevant to Bender:
 * 1. AgentSessionEvent (type="AgentSessionEvent") — when Bender is assigned/mentioned/prompted
 * 2. Issue/Comment (type="Issue"|"Comment") — legacy fallback for non-agent events
 */
export function parseLinearEvent(
  payload: Record<string, unknown>,
  botUserId: string,
): TaskEvent | null {
  const type = payload.type as string;
  const action = payload.action as string;

  // Ignore events triggered by Bender itself (prevents feedback loops)
  const actorId = (payload.data as Record<string, unknown>)?.userId as string
    ?? (payload.data as Record<string, unknown>)?.actorId as string
    ?? payload.appUserId as string
    ?? "";
  if (type !== "AgentSessionEvent" && actorId === botUserId) {
    return null;
  }

  switch (type) {
    case "AgentSessionEvent":
      return parseAgentSessionEvent(payload, action);
    case "Issue":
      return parseIssueEvent(
        payload.data as Record<string, unknown>,
        action,
        botUserId,
      );
    case "Comment":
      return parseCommentEvent(
        payload.data as Record<string, unknown>,
        action,
        payload,
        botUserId,
      );
    default:
      return null;
  }
}

function parseAgentSessionEvent(
  payload: Record<string, unknown>,
  action: string,
): TaskEvent | null {
  // AgentSessionEvent has agentSession, promptContext, etc. at top level (not under data)
  const agentSession = payload.agentSession as Record<string, unknown> | undefined;
  if (!agentSession) return null;

  const agentSessionId = agentSession.id as string;
  const issue = agentSession.issue as Record<string, unknown> | undefined;
  if (!issue) return null;

  const ticketId = (issue.identifier as string) ?? "";
  const title = (issue.title as string) ?? "";
  const url = (issue.url as string) ?? "";
  const promptContext = (payload.promptContext as string) ?? "";

  if (action === "created") {
    return {
      id: `agent_session:${agentSessionId}`,
      type: "new_ticket",
      priority: 4,
      timestamp: new Date().toISOString(),
      source: "linear",
      ticket_id: ticketId,
      ticket_title: title,
      ticket_url: url,
      agent_session_id: agentSessionId,
      prompt_context: promptContext,
      raw: payload,
    };
  }

  if (action === "prompted") {
    const agentActivity = payload.agentActivity as Record<string, unknown> | undefined;
    const promptBody = (agentActivity?.body as string)
      ?? (agentSession.comment as Record<string, unknown>)?.body as string
      ?? "";

    return {
      id: `agent_prompt:${agentSessionId}:${Date.now()}`,
      type: "agent_prompt",
      priority: 3,
      timestamp: new Date().toISOString(),
      source: "linear",
      ticket_id: ticketId,
      ticket_title: title,
      ticket_url: url,
      agent_session_id: agentSessionId,
      comment_body: promptBody,
      prompt_context: promptContext,
      raw: payload,
    };
  }

  return null;
}

function parseIssueEvent(
  data: Record<string, unknown> | undefined,
  action: string,
  botUserId: string,
): TaskEvent | null {
  if (!data) return null;

  const assigneeId = (data.assignee as Record<string, unknown>)?.id as
    | string
    | undefined;
  const ticketId = data.identifier as string;
  const title = data.title as string;
  const url = data.url as string;

  if (action === "update" && assigneeId === botUserId) {
    return {
      id: `linear_assigned:${ticketId}`,
      type: "new_ticket",
      priority: 4,
      timestamp: new Date().toISOString(),
      source: "linear",
      ticket_id: ticketId,
      ticket_title: title,
      ticket_url: url,
      raw: data,
    };
  }

  if (action === "update" && assigneeId !== botUserId) {
    const updatedFrom = data.updatedFrom as Record<string, unknown> | undefined;
    if (updatedFrom?.assigneeId === botUserId) {
      return {
        id: `linear_unassigned:${ticketId}`,
        type: "informational",
        priority: 5,
        timestamp: new Date().toISOString(),
        source: "linear",
        ticket_id: ticketId,
        ticket_title: title,
        ticket_url: url,
        raw: data,
      };
    }
  }

  return null;
}

function parseCommentEvent(
  data: Record<string, unknown> | undefined,
  action: string,
  payload: Record<string, unknown>,
  botUserId: string,
): TaskEvent | null {
  if (!data || action !== "create") return null;

  const issue = data.issue as Record<string, unknown>;
  if (!issue) return null;

  const ticketId = issue.identifier as string;
  const body = data.body as string;
  const userId = (data.user as Record<string, unknown>)?.id as string
    ?? (data.userId as string)
    ?? "";

  // Ignore comments from Bender itself
  if (userId === botUserId) return null;

  return {
    id: `linear_comment:${(data.id as string) ?? Date.now()}`,
    type: "reviewer_comment",
    priority: 3,
    timestamp: new Date().toISOString(),
    source: "linear",
    ticket_id: ticketId,
    comment_body: body,
    comment_author: userId,
    raw: payload,
  };
}
