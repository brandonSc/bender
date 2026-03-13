import express from "express";
import { loadConfig, loadSecrets } from "./config.js";
import { initGitHubAuth } from "./github-auth.js";
import {
  verifyGitHubSignature,
  parseGitHubEvent,
} from "./webhooks/github.js";
import {
  verifyLinearSignature,
  parseLinearEvent,
} from "./webhooks/linear.js";
import { TaskManager } from "./task-manager.js";
import { listActiveSessions } from "./session-store.js";

// --- Bootstrap ---

console.log("Starting Bender...");

const config = loadConfig();
const secrets = loadSecrets();

initGitHubAuth(secrets);

const taskManager = new TaskManager(config);
const app = express();

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

// --- GitHub webhook ---

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

  if (
    secrets.LINEAR_WEBHOOK_SECRET &&
    !verifyLinearSignature(rawBody, signature, secrets.LINEAR_WEBHOOK_SECRET)
  ) {
    console.warn("[linear] Invalid signature — rejecting");
    res.status(401).json({ error: "Invalid signature" });
    return;
  }

  const event = parseLinearEvent(req.body, secrets.LINEAR_BOT_USER_ID);
  if (!event) {
    res.json({ status: "ignored" });
    return;
  }

  console.log(
    `[linear] ${req.body.type}/${req.body.action} → ${event.type}` +
      (event.ticket_id ? ` ${event.ticket_id}` : ""),
  );

  taskManager.enqueue(event);
  res.json({ status: "queued", event_id: event.id });
});

// --- Start ---

const PORT = parseInt(process.env.PORT ?? "3000", 10);

app.listen(PORT, () => {
  console.log(`Bender listening on port ${PORT}`);
  console.log(`Model: ${config.claude.model}`);
  console.log(`Workers: ${config.workers.max_concurrent}`);
  console.log(`Circuit breaker: ${config.circuit_breaker.max_duration_minutes}min / ${config.circuit_breaker.max_tokens} tokens`);
  console.log("");
  console.log("Webhook endpoints:");
  console.log(`  POST /webhooks/github`);
  console.log(`  POST /webhooks/linear`);
  console.log(`  GET  /status`);
  console.log(`  GET  /health`);
  console.log("");
  console.log("Bite my shiny metal AST. 🤖");
});
