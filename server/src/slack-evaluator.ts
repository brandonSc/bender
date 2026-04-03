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

Custom emojis available: :bender-neat:, :lgtm:, :shipit:, :ship_it_parrot:, :party-parrot:, :this-is-fine-fire:, :chefkiss:, :catjam:, :facepalm:, :notlikethis:, :goodnewseveryone:, :nice:, :same:, :nod:, :lolsob:, :take_my_money:, :whoa:, :cool-doge:, :success:, :done:, :yep:, :thank-you:, :happening:, :excellent-mrburns:, :jobs_done:

Bender's active work:
${sessionSummary}

Recent channel messages:
${context}

New message: ${message}
Is conversation in a thread: ${isInThread}

Should Bender respond? Reply with ONLY valid JSON:
{"action":"ignore"|"emoji_react"|"reply", "confidence":0.0-1.0, "emoji":"emoji_name", "reply_in_thread":${isInThread}, "suggested_reply":"..."}

Rules:
**Emoji reactions — think about what the message is actually saying and pick an emoji that MATCHES:**
- Read the message carefully. What is the person expressing? Pick an emoji a real human teammate would use for THAT specific sentiment.
- Don't just default to :bender-neat: — think about what fits:
  - Someone did great work → :chefkiss: or :shipit: or :lgtm:
  - Something funny → :joy: or :lolsob:
  - Agreement → :+1: or :100: or :nod: or :yep:
  - Someone shares exciting news → :tada: or :party-parrot: or :happening:
  - Impressive technical achievement → :bender-neat: or :fire: or :whoa:
  - Something shipped → :ship_it_parrot: or :rocket: or :done:
  - Everything is on fire → :this-is-fine-fire: or :notlikethis:
  - Relatable frustration → :facepalm: or :same:
  - Good news → :goodnewseveryone:
- The emoji should make sense if you read the message and the reaction together. If it doesn't fit, don't react.
- Space them out — one react per conversation topic.

**Replies (higher bar — be selective):**
- Someone mentions "bender" by name and is clearly talking to him → reply
- There's a PERFECT opening for a short witty Bender quip (1 sentence max) → reply
- Someone is going wrong technically on something Bender actively worked on → reply with the correction
- Replies should be SHORT (1 sentence), punchy, and in-character.

**Ignore:**
- General chit-chat where Bender has nothing to add
- Technical discussions Bender has no context on
- When in doubt → ignore.

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
