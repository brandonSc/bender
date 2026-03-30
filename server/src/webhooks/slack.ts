import { createHmac, timingSafeEqual } from "node:crypto";
import type { TaskEvent } from "../types.js";

export function verifySlackSignature(
  body: string,
  timestamp: string | undefined,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!timestamp || !signature || !secret) return false;

  // Reject requests older than 5 minutes
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp, 10)) > 300) return false;

  const baseString = `v0:${timestamp}:${body}`;
  const expected = `v0=${createHmac("sha256", secret).update(baseString).digest("hex")}`;
  if (expected.length !== signature.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

export function parseSlackEvent(
  payload: Record<string, unknown>,
  botUserId: string,
): TaskEvent | null {
  const event = payload.event as Record<string, unknown> | undefined;
  if (!event) return null;

  const eventType = event.type as string;
  const user = event.user as string | undefined;
  const text = event.text as string | undefined;
  const channel = event.channel as string | undefined;
  const threadTs = event.thread_ts as string | undefined;
  const ts = event.ts as string | undefined;

  // Ignore bot's own messages
  if (user === botUserId || event.bot_id) return null;

  // Ignore message subtypes (edits, joins, etc.) except regular messages
  if (event.subtype && event.subtype !== "message_changed") return null;

  if (eventType === "app_mention") {
    // Direct @Bender mention — always respond
    const cleanText = (text ?? "").replace(/<@[A-Z0-9]+>/g, "").trim();

    return {
      id: `slack_mention:${ts}`,
      type: "reviewer_comment",
      priority: 3,
      timestamp: new Date().toISOString(),
      source: "slack",
      comment_body: cleanText,
      comment_author: user,
      slack_channel: channel,
      slack_thread_ts: threadTs ?? ts,
      slack_user: user,
      raw: payload,
    };
  }

  if (eventType === "message") {
    // Regular channel message — lurk mode evaluation
    return {
      id: `slack_msg:${ts}`,
      type: "informational",
      priority: 5,
      timestamp: new Date().toISOString(),
      source: "slack",
      comment_body: text,
      comment_author: user,
      slack_channel: channel,
      slack_thread_ts: threadTs,
      slack_user: user,
      raw: payload,
    };
  }

  return null;
}
