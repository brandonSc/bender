import { getChannelHistory } from "./slack-client.js";
import { listActiveSessions } from "./session-store.js";

// Cooldown: track recent reactions per channel to avoid spamming
const recentReactions = new Map<string, number>();
const REACT_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes between reactions in same channel

export function canReactInChannel(channel: string): boolean {
  const last = recentReactions.get(channel);
  if (last && Date.now() - last < REACT_COOLDOWN_MS) return false;
  return true;
}

export function recordReaction(channel: string): void {
  recentReactions.set(channel, Date.now());
}

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
        model: "claude-haiku-4-5",
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
{"action":"ignore"|"emoji_react"|"reply", "confidence":0.0-1.0, "emoji":"emoji_name", "reply_in_thread":${isInThread}, "suggested_reply":"..."}

Rules:
**Emoji reactions — pick the RIGHT emoji like a real person would:**
- React like a human teammate would, not a bot. Choose the emoji that fits the SPECIFIC message:
  - Something funny → :joy: or :laughing:
  - Good idea or agreement → :+1: or :100:
  - Someone ships/deploys something → :rocket: or :tada:
  - Impressive or cool → :fire:
  - Something surprising → :eyes: or :open_mouth:
  - Something goes wrong → :grimacing: or :sob:
  - Someone says something relatable → :this: or :point_up:
- :bender-neat: is a great one — use it when something is genuinely cool, interesting, or impressive. Just not for every single react.
- Space them out — one react per conversation topic. If you already reacted recently, skip it.

**Replies (higher bar — be selective):**
- Someone mentions "bender" by name and is clearly talking to him → reply
- There's a PERFECT opening for a short witty Bender quip (1 sentence max) → reply. Examples: someone says "AI is gonna tell me what to do" → "Sure, I love telling meatbags what to do." Someone complains about a tedious task → "Sounds like a job for a robot."
- Someone is going wrong technically on something Bender actively worked on → reply with the correction
- Replies should be SHORT (1 sentence), punchy, and in-character. Not helpful advice — Bender attitude.

**Ignore:**
- General chit-chat where Bender has nothing to add
- Technical discussions Bender has no context on
- When in doubt → ignore. But don't be a wallflower either — if there's a natural opening, take it.

- If conversation is NOT in a thread, reply_in_thread should be false.
- confidence must be > 0.85 for emoji_react, > 0.9 for reply`,
        }],
      }),
    });

    if (!resp.ok) {
      console.error(`[slack-evaluator] API error: ${resp.status} ${await resp.text().catch(() => "")}`);
      return { action: "ignore", confidence: 0, reply_in_thread: false };
    }

    const data = (await resp.json()) as { content: Array<{ text: string }> };
    const text = data.content[0].text.trim();

    // Extract JSON from response — Haiku sometimes wraps it in text or code blocks
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn(`[slack-evaluator] No JSON found in Haiku response: "${text.slice(0, 100)}"`);
      return { action: "ignore", confidence: 0, reply_in_thread: false };
    }
    const decision = JSON.parse(jsonMatch[0]) as LurkDecision;
    console.log(`[slack-evaluator] Haiku says: ${decision.action} confidence=${decision.confidence} msg="${message.slice(0, 60)}"`);

    const threshold = decision.action === "emoji_react" ? 0.85 : 0.9;
    if (decision.confidence < threshold) {
      return { action: "ignore", confidence: decision.confidence, reply_in_thread: false };
    }

    return decision;
  } catch (err) {
    console.error("[slack-evaluator] Error:", err);
    return { action: "ignore", confidence: 0, reply_in_thread: false };
  }
}
