import { readFileSync, unlinkSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import express from "express";
import { loadConfig, loadSecrets } from "./config.js";
import { initGitHubAuth, getAppOctokit, getInstallationToken } from "./github-auth.js";
import {
  verifyGitHubSignature,
  parseGitHubEvent,
} from "./webhooks/github.js";
import {
  verifyLinearSignature,
  parseLinearEvent,
} from "./webhooks/linear.js";
import {
  verifySlackSignature,
  parseSlackEvent,
} from "./webhooks/slack.js";
import { TaskManager } from "./task-manager.js";
import { listActiveSessions } from "./session-store.js";
import {
  getLinearToken,
  getAuthorizationUrl,
  exchangeCode,
} from "./linear-auth.js";
import { getViewer } from "./linear-client.js";
import { postMessage, addReaction } from "./slack-client.js";
import { evaluateLurk, canReactInChannel, recordReaction } from "./slack-evaluator.js";
import { trackThread, isActiveThread } from "./slack-threads.js";

// --- Bootstrap ---

console.log("Starting Bender...");

const config = loadConfig();
const secrets = loadSecrets();

initGitHubAuth(secrets);

const taskManager = new TaskManager(config);
const app = express();

// Resolve Bender's Linear user ID from OAuth token (if connected)
let linearBotUserId = "";
(async () => {
  try {
    const token = getLinearToken();
    if (token) {
      const viewer = await getViewer();
      linearBotUserId = viewer.id;
      console.log(`[linear] Connected as: ${viewer.name} (${viewer.id})`);
    } else {
      console.log("[linear] Not connected — visit /auth/linear to authorize");
    }
  } catch (err) {
    console.warn("[linear] Failed to resolve bot identity:", err);
  }
})();

// Raw body for signature verification
app.use(
  express.json({
    verify: (req, _res, buf) => {
      (req as unknown as Record<string, unknown>).rawBody = buf.toString();
    },
  }),
);

// --- Health check ---

app.get("/health", (_req, res) => {
  res.json({ status: "ok", name: "bender" });
});

// --- Status endpoint ---

app.get("/status", (_req, res) => {
  const sessions = listActiveSessions();
  const managerStatus = taskManager.getStatus();

  res.json({
    timestamp: new Date().toISOString(),
    workers: managerStatus.workers,
    queue: {
      length: managerStatus.queue_length,
      items: managerStatus.queue_items,
    },
    sessions: sessions.map((s) => ({
      ticket_id: s.ticket_id,
      ticket_title: s.ticket_title,
      phase: s.phase,
      status: s.status,
      pr_number: s.pr_number,
      ci_status: s.ci_status,
      last_activity_at: s.last_activity_at,
    })),
  });
});

// --- Internal: GitHub token for any org (localhost only) ---

app.get("/internal/github-token", async (req, res) => {
  const ip = req.ip ?? req.socket.remoteAddress ?? "";
  if (!ip.includes("127.0.0.1") && !ip.includes("::1") && !ip.includes("::ffff:127.0.0.1")) {
    res.status(403).json({ error: "localhost only" });
    return;
  }

  const org = req.query.org as string;
  if (!org) {
    res.status(400).json({ error: "Missing ?org= parameter", available: ["earthly", "pantalasa", "pantalasa-cronos", "brandonSc"] });
    return;
  }

  try {
    const octokit = getAppOctokit();
    const { data: installations } = await octokit.rest.apps.listInstallations();
    const match = installations.find((i) => i.account?.login === org);
    if (!match) {
      const available = installations.map((i) => i.account?.login).filter(Boolean);
      res.status(404).json({ error: `No installation for org "${org}"`, available });
      return;
    }

    const token = await getInstallationToken(match.id);
    res.json({ token, org, installation_id: match.id });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// --- Linear OAuth ---

app.get("/auth/linear", (_req, res) => {
  if (!secrets.LINEAR_CLIENT_ID) {
    res.status(500).json({ error: "LINEAR_CLIENT_ID not configured in secrets.env" });
    return;
  }
  const redirectUri = `https://${_req.headers.host}/auth/linear/callback`;
  const url = getAuthorizationUrl(secrets.LINEAR_CLIENT_ID, redirectUri);
  res.redirect(url);
});

app.get("/auth/linear/callback", async (req, res) => {
  const code = req.query.code as string;
  if (!code) {
    res.status(400).json({ error: "Missing authorization code" });
    return;
  }

  try {
    const redirectUri = `https://${req.headers.host}/auth/linear/callback`;
    await exchangeCode(
      code,
      secrets.LINEAR_CLIENT_ID,
      secrets.LINEAR_CLIENT_SECRET,
      redirectUri,
    );

    // Verify the token works
    const viewer = await getViewer();
    console.log(`[linear] Authorized as: ${viewer.name} (${viewer.id})`);

    res.json({
      status: "ok",
      message: `Bender is now connected to Linear as "${viewer.name}"`,
      viewer,
    });
  } catch (err) {
    console.error("[linear] OAuth error:", err);
    res.status(500).json({ error: String(err) });
  }
});

app.get("/auth/linear/status", async (_req, res) => {
  const token = getLinearToken();
  if (!token) {
    res.json({ connected: false, message: "Visit /auth/linear to connect" });
    return;
  }
  try {
    const viewer = await getViewer();
    res.json({ connected: true, viewer });
  } catch {
    res.json({ connected: false, message: "Token exists but is invalid — re-authorize at /auth/linear" });
  }
});

// --- GitHub webhook ---

// Deduplicate GitHub webhook deliveries — GitHub has at-least-once delivery
// and may retry if our response is slow. Track by event.id (entity-based).
const recentGitHubEvents = new Set<string>();

app.post("/webhooks/github", (req, res) => {
  const rawBody = (req as unknown as Record<string, unknown>)
    .rawBody as string;
  const signature = req.headers["x-hub-signature-256"] as string | undefined;
  const eventType = req.headers["x-github-event"] as string;

  if (!verifyGitHubSignature(rawBody, signature, secrets.GITHUB_WEBHOOK_SECRET)) {
    console.warn("[github] Invalid signature — rejecting");
    res.status(401).json({ error: "Invalid signature" });
    return;
  }

  const event = parseGitHubEvent(eventType, req.body);
  if (!event) {
    res.json({ status: "ignored" });
    return;
  }

  // Dedup: skip if we've already processed this exact event recently
  if (recentGitHubEvents.has(event.id)) {
    console.log(`[github] Dedup: already seen ${event.id} — skipping`);
    res.json({ status: "duplicate", event_id: event.id });
    return;
  }
  recentGitHubEvents.add(event.id);
  setTimeout(() => recentGitHubEvents.delete(event.id), 60000);

  console.log(
    `[github] ${eventType}/${req.body.action ?? ""} → ${event.type}` +
      (event.pr_number ? ` PR#${event.pr_number}` : "") +
      (event.comment_author ? ` by ${event.comment_author}` : ""),
  );

  taskManager.enqueue(event);
  res.json({ status: "queued", event_id: event.id });
});

// --- Linear webhook ---

app.post("/webhooks/linear", (req, res) => {
  const rawBody = (req as unknown as Record<string, unknown>)
    .rawBody as string;
  const signature = req.headers["linear-signature"] as string | undefined;
  const webhookType = req.body.type as string;
  const webhookAction = req.body.action as string;

  console.log(`[linear] Received: ${webhookType}/${webhookAction}`);
  if (webhookType === "AgentSessionEvent" && webhookAction === "prompted") {
    const { agentSession, promptContext, ...rest } = req.body;
    console.log(`[linear] Prompted payload (excluding agentSession/promptContext): ${JSON.stringify(rest, null, 2)}`);
  }

  // AgentSessionEvent webhooks are signed with the OAuth app's webhook secret.
  // Workspace webhooks (Issue, Comment) use the workspace webhook secret.
  const isAgentEvent = webhookType === "AgentSessionEvent";
  const signingSecret = isAgentEvent
    ? secrets.LINEAR_APP_WEBHOOK_SECRET
    : secrets.LINEAR_WEBHOOK_SECRET;

  if (
    signingSecret &&
    !verifyLinearSignature(rawBody, signature, signingSecret)
  ) {
    console.warn(`[linear] Invalid signature for ${webhookType} — rejecting`);
    res.status(401).json({ error: "Invalid signature" });
    return;
  }

  const event = parseLinearEvent(req.body, linearBotUserId);
  if (!event) {
    console.log(`[linear] ${webhookType}/${webhookAction} → ignored`);
    res.json({ status: "ignored" });
    return;
  }

  console.log(
    `[linear] ${webhookType}/${webhookAction} → ${event.type}` +
      (event.ticket_id ? ` ${event.ticket_id}` : "") +
      (event.agent_session_id ? ` session=${event.agent_session_id}` : ""),
  );

  taskManager.enqueue(event);
  res.json({ status: "queued", event_id: event.id });
});

// --- Slack webhook ---

let slackBotUserId = "";
const recentSlackEvents = new Set<string>();

app.post("/webhooks/slack", async (req, res) => {
  const rawBody = (req as unknown as Record<string, unknown>).rawBody as string;
  const timestamp = req.headers["x-slack-request-timestamp"] as string | undefined;
  const signature = req.headers["x-slack-signature"] as string | undefined;

  console.log(`[slack] Received: ts=${timestamp} sig=${signature?.slice(0, 20)}... body_len=${rawBody?.length}`);

  if (
    secrets.SLACK_SIGNING_SECRET &&
    !verifySlackSignature(rawBody, timestamp, signature, secrets.SLACK_SIGNING_SECRET)
  ) {
    console.warn(`[slack] Invalid signature — rejecting (rawBody type: ${typeof rawBody}, has content: ${!!rawBody})`);
    res.status(401).json({ error: "Invalid signature" });
    return;
  }

  // Handle Slack URL verification challenge
  if (req.body.type === "url_verification") {
    res.json({ challenge: req.body.challenge });
    return;
  }

  // Must respond within 3 seconds — process async
  res.json({ ok: true });

  const event = parseSlackEvent(req.body, slackBotUserId);
  if (!event) {
    const slackEvt = req.body.event as Record<string, unknown> | undefined;
    if (slackEvt?.type === "message" && slackEvt?.user) {
      console.log(`[slack] Dropped message: subtype=${slackEvt.subtype ?? "none"} channel_type=${slackEvt.channel_type ?? "?"} user=${slackEvt.user} bot_id=${slackEvt.bot_id ?? "none"}`);
    }
    return;
  }

  // Deduplicate: Slack sends both app_mention AND message for @mentions
  const slackEvent = req.body.event as Record<string, unknown>;
  const eventTs = slackEvent?.ts as string ?? "";
  if (recentSlackEvents.has(eventTs)) return;
  recentSlackEvents.add(eventTs);
  setTimeout(() => recentSlackEvents.delete(eventTs), 30000);
  const isDirectMention = slackEvent?.type === "app_mention";
  const isDM = (slackEvent?.channel_type as string) === "im";
  const threadTs = (slackEvent?.thread_ts as string) ?? (slackEvent?.ts as string);
  const channel = slackEvent?.channel as string;
  const inTrackedThread = isActiveThread(channel, slackEvent?.thread_ts as string);

  // Also detect @mentions in message events (Slack sends both app_mention and message;
  // if message arrives first and wins the dedup, we'd miss the mention)
  const textMentionsBender = !isDirectMention && slackBotUserId
    && (event.comment_body ?? "").includes(`<@${slackBotUserId}>`);

  if (isDirectMention || textMentionsBender) {
    trackThread(`${channel}:${threadTs}`);
  }

  if (isDirectMention || textMentionsBender || isDM || inTrackedThread) {
    const reason = isDirectMention ? "@mention" : textMentionsBender ? "@mention (text)" : isDM ? "DM" : "active thread";
    console.log(
      `[slack] ${reason} from ${event.slack_user}: "${event.comment_body?.slice(0, 80)}"`,
    );
    taskManager.enqueue(event);
  } else {
    // Lurk mode — evaluate whether to chime in (conservative, high threshold)
    if (!secrets.SLACK_BOT_TOKEN) return;

    try {
      const decision = await evaluateLurk(
        event.slack_channel!,
        event.comment_body ?? "",
        (slackEvent.ts as string) ?? "",
        event.slack_thread_ts,
      );

      if (decision.action === "emoji_react" && decision.emoji) {
        if (!canReactInChannel(event.slack_channel!)) {
          console.log(`[slack] Lurk → react COOLDOWN (skipped :${decision.emoji}: in ${event.slack_channel})`);
        } else {
          console.log(`[slack] Lurk → react :${decision.emoji}: (confidence=${decision.confidence})`);
          await addReaction(event.slack_channel!, (slackEvent.ts as string) ?? "", decision.emoji);
          recordReaction(event.slack_channel!);
        }
      } else if (decision.action === "reply" && decision.suggested_reply) {
        console.log(`[slack] Lurk → reply (confidence=${decision.confidence})`);
        await postMessage(
          event.slack_channel!,
          decision.suggested_reply,
          decision.reply_in_thread ? (event.slack_thread_ts ?? (slackEvent.ts as string)) : undefined,
        );
      } else {
        console.log(`[slack] Lurk → ${decision.action} (confidence=${decision.confidence}) ch=${event.slack_channel}`);
      }
    } catch (err) {
      console.error(`[slack] Lurk error:`, err);
    }
  }
});

// Resolve Slack bot user ID on startup
if (secrets.SLACK_BOT_TOKEN) {
  fetch("https://slack.com/api/auth.test", {
    method: "POST",
    headers: { Authorization: `Bearer ${secrets.SLACK_BOT_TOKEN}` },
  })
    .then((r) => r.json() as Promise<Record<string, unknown>>)
    .then((data) => {
      if (data.ok) {
        slackBotUserId = data.user_id as string;
        console.log(`[slack] Connected as: ${data.user} (${slackBotUserId})`);
      } else {
        console.warn("[slack] Not connected:", data.error);
      }
    })
    .catch((err) => console.warn("[slack] Failed to resolve bot identity:", err));
}

// --- Restart notification ---

async function checkRestartNotification(): Promise<void> {
  const notifPath = resolve(
    process.env.HOME ?? "/home/ubuntu",
    ".bender",
    "restart-notification.json",
  );

  if (!existsSync(notifPath)) return;

  try {
    const raw = readFileSync(notifPath, "utf-8");
    const notif = JSON.parse(raw) as {
      channel?: string;
      thread_ts?: string;
      reason?: string;
      requested_at?: number;
    };

    if (notif.channel) {
      const msg = `I'm back, baby! Restart complete.${notif.reason ? ` (${notif.reason})` : ""}`;
      await postMessage(notif.channel, msg, notif.thread_ts || undefined);
      console.log(`[restart] Sent notification to ${notif.channel}`);
    } else {
      console.log("[restart] Notification file found but no channel — skipping Slack post");
    }

    unlinkSync(notifPath);
    console.log("[restart] Cleaned up notification file");
  } catch (err) {
    console.error("[restart] Failed to process notification:", err);
    // Clean up even on error to avoid infinite loops
    try { unlinkSync(notifPath); } catch { /* already gone */ }
  }
}

// --- Start ---

const PORT = parseInt(process.env.PORT ?? "3000", 10);

app.listen(PORT, () => {
  console.log(`Bender listening on port ${PORT}`);
  console.log(`Model: ${config.claude.model}`);
  console.log(`Workers: ${config.workers.max_concurrent}`);
  console.log(`Circuit breaker: ${config.circuit_breaker.max_duration_minutes}min / ${config.circuit_breaker.max_tokens} tokens`);
  console.log("");
  console.log("Endpoints:");
  console.log(`  POST /webhooks/github`);
  console.log(`  POST /webhooks/linear`);
  console.log(`  POST /webhooks/slack`);
  console.log(`  GET  /auth/linear          (connect to Linear)`);
  console.log(`  GET  /auth/linear/status   (check connection)`);
  console.log(`  GET  /status`);
  console.log(`  GET  /health`);
  console.log("");
  console.log("Bite my shiny metal AST. 🤖");

  // Check for restart notification after boot (slight delay so Slack auth resolves first)
  setTimeout(() => checkRestartNotification(), 3000);
});
