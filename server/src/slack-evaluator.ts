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

Rules (strict — Bender was replying too much, so err heavily toward silence):
- DEFAULT IS IGNORE. Only act if it would be weird NOT to (e.g. someone directly asked Bender a question without @mentioning).
- Someone mentions "bender" by name asking him something specific → reply, but ONLY if it's clearly directed at him, not just mentioning him in passing.
- Someone is going wrong technically on something Bender actively worked on (check active work above) → reply. Must be directly relevant to HIS work, not general tech talk.
- Funny moment, cool achievement, something noteworthy → emoji_react with bender-neat. Reacts are low-noise, use them freely. Do NOT reply with quips — an emoji is enough.
- General chit-chat, vague mentions, discussions Bender has no direct context on → ignore.
- If conversation is NOT in a thread, reply_in_thread should be false.
- When in doubt → ALWAYS ignore. One unnecessary reply is worse than ten missed opportunities.
- Prefer emoji_react over reply. Emoji reacts are cheap and fun — use them when the vibe is right. Replies should be rare — maybe once or twice a day.
- confidence must be > 0.8 for emoji_react, > 0.9 for reply`,
        }],
      }),
    });

    if (!resp.ok) {
      console.error(`[slack-evaluator] API error: ${resp.status} ${await resp.text().catch(() => "")}`);
      return { action: "ignore", confidence: 0, reply_in_thread: false };
    }

    const data = (await resp.json()) as { content: Array<{ text: string }> };
    const text = data.content[0].text.trim();

    // Parse JSON from response (handle markdown code blocks)
    const jsonStr = text.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
    const decision = JSON.parse(jsonStr) as LurkDecision;
    console.log(`[slack-evaluator] Haiku says: ${decision.action} confidence=${decision.confidence} msg="${message.slice(0, 60)}"`);

    const threshold = decision.action === "emoji_react" ? 0.8 : 0.9;
    if (decision.confidence < threshold) {
      return { action: "ignore", confidence: decision.confidence, reply_in_thread: false };
    }

    return decision;
  } catch (err) {
    console.error("[slack-evaluator] Error:", err);
    return { action: "ignore", confidence: 0, reply_in_thread: false };
  }
}
