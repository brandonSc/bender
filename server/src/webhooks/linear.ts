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
 */
export function parseLinearEvent(
  payload: Record<string, unknown>,
  botUserId: string,
): TaskEvent | null {
  const type = payload.type as string;
  const action = payload.action as string;
  const data = payload.data as Record<string, unknown>;

  if (!data) return null;

  switch (type) {
    case "Issue":
      return parseIssueEvent(data, action, botUserId);
    case "Comment":
      return parseCommentEvent(data, action, payload);
    default:
      return null;
  }
}

function parseIssueEvent(
  data: Record<string, unknown>,
  action: string,
  botUserId: string,
): TaskEvent | null {
  const assigneeId = (data.assignee as Record<string, unknown>)?.id as
    | string
    | undefined;
  const ticketId = data.identifier as string;
  const title = data.title as string;
  const url = data.url as string;

  // Ticket assigned to bot
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

  // Ticket unassigned from bot
  if (action === "update" && assigneeId !== botUserId) {
    // Check if it WAS assigned to bot (via updatedFrom)
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
  data: Record<string, unknown>,
  action: string,
  payload: Record<string, unknown>,
): TaskEvent | null {
  if (action !== "create") return null;

  const issue = data.issue as Record<string, unknown>;
  if (!issue) return null;

  const ticketId = issue.identifier as string;
  const body = data.body as string;
  const userId = (data.user as Record<string, unknown>)?.id as string;

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
