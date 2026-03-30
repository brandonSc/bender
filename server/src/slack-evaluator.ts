import { getChannelHistory } from "./slack-client.js";
import { listActiveSessions } from "./session-store.js";

interface LurkDecision {
  action: "ignore" | "emoji_react" | "reply";
  confidence: number;
  emoji?: string;
  reply_in_thread: boolean;
  suggested_reply?: string;
}

export async function evaluateLurk(
  channel: string,
  message: string,
  messageTs: string,
  threadTs?: string,
): Promise<LurkDecision> {
  try {
    const recentMessages = await getChannelHistory(channel, 8);
    const sessions = listActiveSessions();

    const context = recentMessages
      .reverse()
      .map((m) => `<${m.user}>: ${m.text}`)
      .join("\n");

    const sessionSummary = sessions
      .map((s) => `${s.ticket_id}: ${s.ticket_title} (${s.phase}, PR #${s.pr_number ?? "none"})`)
      .join("\n") || "No active work.";

    const isInThread = !!threadTs;

    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY ?? "",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-20250514",
        max_tokens: 200,
        messages: [{
          role: "user",
          content: `You evaluate whether Bender (a coding agent on this team) should respond to a Slack message. Bender lurks in channels and should only chime in when genuinely valuable or funny.

Known custom emoji: bender-neat (Bender's signature), bender, futurama
Bender's active work:
${sessionSummary}

Recent channel messages:
${context}

New message: ${message}
Is conversation in a thread: ${isInThread}

Should Bender respond? Reply with ONLY valid JSON:
{"action":"ignore"|"emoji_react"|"reply", "confidence":0.0-1.0, "emoji":"bender-neat", "reply_in_thread":${isInThread}, "suggested_reply":"..."}

Rules:
- If someone is going wrong technically and Bender has context → reply (confidence > 0.8)
- Architecture/bug discussion where Bender's work is relevant → reply
- Genuinely funny moment → emoji_react with bender-neat or reply with a quip
- General chit-chat → ignore
- If conversation is NOT in a thread, reply_in_thread should be false (match the vibe)
- If ANY doubt → ignore. Better quiet than noisy.
- confidence must be > 0.8 to act`,
        }],
      }),
    });

    if (!resp.ok) return { action: "ignore", confidence: 0, reply_in_thread: false };

    const data = (await resp.json()) as { content: Array<{ text: string }> };
    const text = data.content[0].text.trim();

    // Parse JSON from response (handle markdown code blocks)
    const jsonStr = text.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
    const decision = JSON.parse(jsonStr) as LurkDecision;

    if (decision.confidence < 0.8) {
      return { action: "ignore", confidence: decision.confidence, reply_in_thread: false };
    }

    return decision;
  } catch (err) {
    console.error("[slack-evaluator] Error:", err);
    return { action: "ignore", confidence: 0, reply_in_thread: false };
  }
}
