import { getChannelHistory, type MessageReaction } from "./slack-client.js";
import { listActiveSessions } from "./session-store.js";

// Cooldown: track recent reactions per channel and globally
const recentReactions = new Map<string, number>();
let lastGlobalReaction = 0;
const REACT_COOLDOWN_MS = 45 * 60 * 1000; // 45 minutes between reactions in same channel
const GLOBAL_COOLDOWN_MS = 20 * 60 * 1000; // 20 minutes between reactions globally

// Track recent emojis to encourage variety
const recentEmojis: string[] = [];
const MAX_RECENT_EMOJIS = 10;

export function canReactInChannel(channel: string): boolean {
  const now = Date.now();
  // Global cooldown
  if (now - lastGlobalReaction < GLOBAL_COOLDOWN_MS) return false;
  // Per-channel cooldown
  const last = recentReactions.get(channel);
  if (last && now - last < REACT_COOLDOWN_MS) return false;
  return true;
}

export function recordReaction(channel: string, emoji?: string): void {
  const now = Date.now();
  recentReactions.set(channel, now);
  lastGlobalReaction = now;
  if (emoji) {
    recentEmojis.push(emoji);
    if (recentEmojis.length > MAX_RECENT_EMOJIS) recentEmojis.shift();
  }
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
  existingReactions?: MessageReaction[],
  botUserId?: string,
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

    // Name mention detection: someone said "bender" without @mention → lower reply threshold
    const mentionsBenderByName = /\bbender\b/i.test(message) && !message.includes(`<@${botUserId}>`);

    // Herd mentality: count unique human reactors (exclude bot)
    const humanReactions = (existingReactions ?? []).map((r) => ({
      ...r,
      users: r.users.filter((u) => u !== botUserId),
    })).filter((r) => r.users.length > 0);

    const uniqueReactors = new Set(humanReactions.flatMap((r) => r.users));
    const herdActive = uniqueReactors.size >= 2;

    let herdContext = "";
    if (humanReactions.length > 0) {
      const reactionSummary = humanReactions
        .map((r) => `:${r.name}: (${r.users.length} people)`)
        .join(", ");
      herdContext = `\nExisting reactions on this message: ${reactionSummary}`;
      if (herdActive) {
        herdContext += `\n${uniqueReactors.size} teammates have already reacted — this is a popular message. Piling on with a reaction is natural here. Prefer using one of the existing reaction emojis to join the crowd, but a different fitting emoji is fine too.`;
      }
    }

    // Recent emoji variety context
    let varietyContext = "";
    if (recentEmojis.length > 0) {
      const unique = [...new Set(recentEmojis)];
      varietyContext = `\nBender's recent reactions (AVOID repeating): ${unique.map(e => `:${e}:`).join(", ")}`;
    }

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
          content: `You decide whether Bender (a coding agent on this Slack team) should react to a message. Bender lurks and RARELY reacts — only when the message truly stands out.

IMPORTANT: Bender's Slack user ID is ${botUserId ?? "U0AQ615JKMF"}. Any mention of <@${botUserId ?? "U0AQ615JKMF"}> in messages refers to Bender (you).

Custom emojis: :bender-neat:, :lgtm:, :shipit:, :ship_it_parrot:, :party-parrot:, :this-is-fine-fire:, :chefkiss:, :catjam:, :facepalm:, :notlikethis:, :goodnewseveryone:, :nice:, :same:, :nod:, :lolsob:, :take_my_money:, :whoa:, :cool-doge:, :success:, :done:, :yep:, :thank-you:, :happening:, :excellent-mrburns:, :jobs_done:

Bender's active work:
${sessionSummary}

Recent channel messages:
${context}

New message: ${message}${herdContext}${varietyContext}
Is conversation in a thread: ${isInThread}

Reply with ONLY valid JSON:
{"action":"ignore"|"emoji_react"|"reply", "confidence":0.0-1.0, "emoji":"emoji_name", "reply_in_thread":${isInThread}, "suggested_reply":"..."}

## Confidence scale — use the FULL range honestly:
- 0.0-0.3: Nothing here for Bender. Mundane message, no relevant context.
- 0.3-0.5: Mildly interesting but not reaction-worthy. A human wouldn't react to this.
- 0.5-0.7: Decent message but the emoji fit is only partial. Pass.
- 0.7-0.85: Good message, decent emoji fit, but not a slam dunk. Probably still pass.
- 0.85-0.95: Strong fit — the emoji clearly matches the sentiment and a teammate would naturally react.
- 0.95-1.0: Perfect, can't-miss reaction. The message is begging for exactly this emoji.

Most messages should score 0.2-0.5. A score above 0.85 should be RARE — maybe 1 in 10 messages.

## Emoji selection:
- Read the message. What is the person ACTUALLY expressing?
- Pick the emoji a real human would instinctively use for that EXACT sentiment.
- If no emoji is a natural, obvious fit → ignore. Don't force it.${varietyContext ? "\n- Avoid recently used emojis — pick something fresh." : ""}
${herdActive ? `\n## Herd mentality:
- Others already reacted. Joining in is natural — prefer their emojis.
` : ""}
## Replies (very high bar):
- Someone is clearly talking to/about Bender → reply
- PERFECT opening for a one-sentence Bender quip → reply
- Technical correction on Bender's own work → reply
- Everything else → don't reply
${mentionsBenderByName ? "- Someone mentioned Bender by name — they might be talking to you. Be more willing to reply." : ""}

## Default behavior:
IGNORE. Bender is the quiet, cool teammate who only reacts when it really counts. A well-timed reaction once an hour beats ten mediocre ones.`,
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
    console.log(`[slack-evaluator] Haiku says: ${decision.action} confidence=${decision.confidence} herd=${herdActive} nameMention=${mentionsBenderByName} msg="${message.slice(0, 60)}"`);

    // Thresholds: base 0.85 for emoji (prompt no longer leaks exact number),
    // herd drops to 0.75, name mention drops reply to 0.70
    const emojiThreshold = herdActive ? 0.75 : 0.85;
    const replyThreshold = mentionsBenderByName ? 0.70 : 0.85;
    const threshold = decision.action === "emoji_react" ? emojiThreshold : replyThreshold;
    if (decision.confidence < threshold) {
      console.log(`[slack-evaluator] Suppressed ${decision.action}: confidence=${decision.confidence} < threshold=${threshold}${decision.emoji ? ` emoji=:${decision.emoji}:` : ""}${decision.suggested_reply ? ` reply="${decision.suggested_reply.slice(0, 60)}"` : ""} msg="${message.slice(0, 60)}"`);
      return { action: "ignore", confidence: decision.confidence, reply_in_thread: false };
    }

    return decision;
  } catch (err) {
    console.error("[slack-evaluator] Error:", err);
    return { action: "ignore", confidence: 0, reply_in_thread: false };
  }
}
