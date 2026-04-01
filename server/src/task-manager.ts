import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import type { Config, TaskEvent, Worker, Session } from "./types.js";
import { routeEvent, type RouteResult } from "./router.js";
import { saveSession, findSessionForEvent, listActiveSessions } from "./session-store.js";
import { invokeClaude } from "./claude-executor.js";
import {
  buildNewSessionPrompt,
  buildResumedPrompt,
  buildCheckpointedPrompt,
} from "./context-builder.js";
import {
  emitThought,
  emitResponse,
  emitError,
} from "./linear-agent.js";
import { postMessage as slackPostMessage, getThreadMessages, getChannelHistory } from "./slack-client.js";
import { recordMessage, getUserContext, getChannelContext } from "./slack-memory.js";
import { getAppOctokit, getInstallationToken } from "./github-auth.js";
import { storePlan, getPendingPlan, consumePlan, isApproval } from "./slack-plans.js";
import { getBenderDir } from "./config.js";

interface WaitingState {
  channel: string;
  thread_ts: string;
  ticket_id: string;
  question: string;
  created_at: number;
}

function waitingFilePath(channel: string, threadTs: string): string {
  const safeKey = `${channel}:${threadTs}`.replace(/[/:]/g, "_");
  return resolve(getBenderDir(), "waiting", `${safeKey}.json`);
}

function readWaitingState(channel: string, threadTs: string): WaitingState | null {
  const fp = waitingFilePath(channel, threadTs);
  if (!existsSync(fp)) return null;
  try {
    const state = JSON.parse(readFileSync(fp, "utf-8")) as WaitingState;
    const ageMs = Date.now() - state.created_at * 1000;
    if (ageMs > 60 * 60 * 1000) {
      unlinkSync(fp);
      return null;
    }
    return state;
  } catch {
    return null;
  }
}

function clearWaitingState(channel: string, threadTs: string): void {
  const fp = waitingFilePath(channel, threadTs);
  try { if (existsSync(fp)) unlinkSync(fp); } catch {}
}

async function getGitHubToken(repoOrg?: string): Promise<string | undefined> {
  try {
    const octokit = getAppOctokit();
    const { data: installations } = await octokit.rest.apps.listInstallations();
    if (installations.length === 0) return undefined;

    // Pick the installation matching the repo's org, or default to 'earthly'
    const org = repoOrg?.split("/")[0] ?? "earthly";
    const match = installations.find((i) => i.account?.login === org)
      ?? installations.find((i) => i.account?.login === "earthly")
      ?? installations[0];

    return await getInstallationToken(match.id);
  } catch {
    return undefined;
  }
}

async function benderChat(
  userMessage: string,
  session: { ticket_id: string; ticket_title: string; phase: string; pr_number: number | null },
): Promise<string | null> {
  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY ?? "",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        system: `You are Bender from Futurama, a coding agent. Confident, a little cocky, concise. Don't write essays — short punchy replies. Use Futurama references only when they genuinely fit the moment, not every message. Drop the attitude for serious technical questions and just be precise. Never narrate actions in character (no *cracks knuckles* stuff).

Working on: ${session.ticket_id} "${session.ticket_title}" (phase: ${session.phase}, PR: ${session.pr_number ? `#${session.pr_number}` : "none"}).`,
        messages: [{ role: "user", content: userMessage }],
      }),
    });
    if (!resp.ok) return null;
    const data = await resp.json() as { content: Array<{ text: string }> };
    return data.content[0].text;
  } catch {
    return null;
  }
}

async function benderSpeak(situation: string): Promise<string> {
  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY ?? "",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 150,
        messages: [{
          role: "user",
          content: `You are Bender from Futurama, a coding agent on a dev team in Slack. Write a short natural reply (1-2 sentences max). Sound like a real teammate who happens to be a cocky robot — not a bot generating a "status update". No emojis unless it really fits. No action narration.\n\nSituation: ${situation}`,
        }],
      }),
    });
    if (!resp.ok) {
      console.error(`[benderSpeak] Haiku API error: ${resp.status} ${await resp.text().catch(() => "")}`);
      return "On it.";
    }
    const data = await resp.json() as { content: Array<{ text: string }> };
    return data.content[0].text;
  } catch (err) {
    console.error("[benderSpeak] Error:", err);
    return "On it.";
  }
}

interface QueueItem {
  event: TaskEvent;
  received_at: number;
}

export class TaskManager {
  private queue: QueueItem[] = [];
  private workers: Worker[] = [];
  private config: Config;
  private processing = false;
  private debounceTimers = new Map<string, { event: TaskEvent; timer: NodeJS.Timeout }>();
  private static DEBOUNCE_MS = 10000;

  constructor(config: Config) {
    this.config = config;
    this.workers = Array.from(
      { length: config.workers.max_concurrent },
      (_, i) => ({
        id: i + 1,
        busy: false,
        current_ticket: null,
        current_description: null,
      }),
    );
  }

  /**
   * Enqueue an event for processing.
   * Uses debounce for comment-type events to batch rapid-fire messages.
   * High-priority events (CI failures) skip debounce.
   */
  enqueue(event: TaskEvent): void {
    console.log(
      `[queue] +${event.type} (pri=${event.priority}) from ${event.source}` +
        (event.pr_number ? ` PR#${event.pr_number}` : "") +
        (event.ticket_id ? ` ${event.ticket_id}` : "") +
        ` | queue=${this.queue.length} workers=${this.busyCount()}/${this.workers.length}`,
    );

    // High-priority events skip debounce
    if (event.priority <= 2) {
      this.addToQueue(event);
      return;
    }

    // Debounce comment-type events per ticket — accumulate messages, dispatch after silence
    const ticketKey = event.ticket_id ?? (event.pr_number ? `pr:${event.pr_number}` : event.id);
    const existing = this.debounceTimers.get(ticketKey);
    if (existing) {
      clearTimeout(existing.timer);
      // Accumulate: append new comment to the pending event's body
      if (event.comment_body && existing.event.comment_body) {
        const author = event.comment_author ?? "human";
        existing.event.comment_body += `\n\n---\n**${author}:** ${event.comment_body}`;
      } else if (event.comment_body) {
        existing.event.comment_body = event.comment_body;
      }
      // Keep higher priority
      if (event.priority < existing.event.priority) {
        existing.event.priority = event.priority;
      }
      console.log(`[queue] Accumulated message for ${ticketKey} (debounce reset)`);
    }

    const pending = existing?.event ?? event;
    this.debounceTimers.set(ticketKey, {
      event: pending,
      timer: setTimeout(() => {
        this.debounceTimers.delete(ticketKey);
        this.addToQueue(pending);
      }, TaskManager.DEBOUNCE_MS),
    });
  }

  private addToQueue(event: TaskEvent): void {
    this.queue.push({ event, received_at: Date.now() });
    this.queue.sort((a, b) => a.event.priority - b.event.priority);
    this.processNext();
  }

  /**
   * Try to assign the next queued event to a free worker.
   * Skips events for tickets already being worked on — they stay in the queue.
   */
  private processNext(): void {
    if (this.queue.length === 0) return;

    const worker = this.workers.find((w) => !w.busy);
    if (!worker) return;

    // Find the first queued event whose ticket isn't already running
    const busyTickets = new Set(
      this.workers.filter((w) => w.busy && w.current_ticket).map((w) => w.current_ticket),
    );

    const idx = this.queue.findIndex((item) => {
      // For Slack events, serialize by thread (not channel) so chat can proceed
      // on other workers while a long-running work invocation runs in a thread.
      if (item.event.source === "slack" && item.event.slack_channel) {
        const threadKey = item.event.slack_thread_ts
          ? `slack:${item.event.slack_channel}:${item.event.slack_thread_ts}`
          : `slack:${item.event.slack_channel}`;
        return !busyTickets.has(threadKey);
      }
      const ticketId = item.event.ticket_id
        ?? this.resolveTicketForPR(item.event.pr_number);
      return !ticketId || !busyTickets.has(ticketId);
    });

    if (idx === -1) return; // All queued events are for busy tickets — wait

    const item = this.queue.splice(idx, 1)[0];
    this.dispatch(worker, item.event);
  }

  private resolveTicketForPR(prNumber?: number): string | null {
    if (!prNumber) return null;
    const session = findSessionForEvent({ pr_number: prNumber });
    return session?.ticket_id ?? null;
  }

  /**
   * Dispatch an event to a worker — route it and invoke Claude if needed.
   */
  private async dispatch(worker: Worker, event: TaskEvent): Promise<void> {
    // Slack messages — single smart call that decides and acts
    if (event.source === "slack" && event.slack_channel) {
      worker.busy = true;
      const threadKey = event.slack_thread_ts
        ? `slack:${event.slack_channel}:${event.slack_thread_ts}`
        : `slack:${event.slack_channel}`;
      worker.current_ticket = threadKey;
      worker.current_description = event.comment_body?.slice(0, 120) ?? "slack message";
      console.log(`[W${worker.id}] → slack ${event.slack_channel} "${event.comment_body?.slice(0, 50)}"`);
      try {
        await this.handleSlack(worker, event);
      } catch (err) {
        console.error(`[W${worker.id}] slack error:`, err);
      } finally {
        worker.busy = false;
        worker.current_ticket = null;
        worker.current_description = null;
        this.processNext();
      }
      return;
    }

    const result = routeEvent(event);

    if (!result || result.action === "skip") {
      console.log(
        `[W${worker.id}] skip ${event.type} — ${result ? "no action needed" : "no matching session"}`,
      );
      this.processNext();
      return;
    }

    if (result.action === "cancel") {
      console.log(`[W${worker.id}] cancel ${result.session.ticket_id}`);
      this.processNext();
      return;
    }

    // Mark worker busy
    worker.busy = true;
    worker.current_ticket = result.session.ticket_id;
    worker.current_description = `${result.session.ticket_id}: ${result.session.ticket_title}`;

    console.log(
      `[W${worker.id}] → ${result.session.ticket_id} (${result.session.phase}) event=${event.type}`,
    );

    try {
      await this.executeTask(worker, result);
    } catch (err) {
      console.error(
        `[W${worker.id}] error on ${result.session.ticket_id}:`,
        err,
      );
      result.session.retry_count++;
      if (result.session.retry_count >= result.session.max_retries) {
        result.session.phase = "error";
        result.session.status = "error";
        console.error(
          `[W${worker.id}] ${result.session.ticket_id} exceeded retry limit`,
        );
      }
      saveSession(result.session);
    } finally {
      worker.busy = false;
      worker.current_ticket = null;
      worker.current_description = null;
      this.processNext();
    }
  }

  private async executeTask(
    worker: Worker,
    result: RouteResult,
  ): Promise<void> {
    const { session, event, isNewSession, needsCheckpoint } = result;

    // Get a GitHub installation token scoped to the session's repo org
    const githubToken = await getGitHubToken(session.repo);

    // For new tickets, DM the assignee on Slack to create the "agent tab" thread
    if (isNewSession && !session.slack_channel) {
      try {
        const slackThread = await this.initSlackThreadForSession(session, event);
        if (slackThread) {
          session.slack_channel = slackThread.channel;
          session.slack_thread_ts = slackThread.threadTs;
          saveSession(session);
        }
      } catch (err) {
        console.warn(`[W${worker.id}] Failed to init Slack thread:`, err);
      }
    }

    // Post a thought to Linear for new tickets
    if (session.agent_session_id && isNewSession) {
      const msg = await benderSpeak(
        `Starting work on ticket ${session.ticket_id}: "${session.ticket_title}"`,
      );
      await emitThought(session.agent_session_id, msg);
    }

    // Build the prompt
    let prompt: string;
    if (isNewSession) {
      prompt = buildNewSessionPrompt(event, session);
    } else if (needsCheckpoint) {
      prompt = buildCheckpointedPrompt(event, session);
    } else {
      prompt = buildResumedPrompt(event, session);
    }

    // Use Sonnet for chat replies, Opus max for real work
    const isChat = event.type === "agent_prompt"
      || (event.type === "reviewer_comment" && event.source === "linear");

    // For chat, don't resume the session — old context causes stale responses.
    // Temporarily clear session ID so invokeClaude starts fresh.
    const savedSessionId = session.claude_session_id;
    if (isChat) {
      console.log(`[W${worker.id}] Light mode (Sonnet, fresh) for chat reply`);
      session.claude_session_id = null;
    }

    // Pass Slack reply vars if session has an agent tab
    const sessionEnv: Record<string, string> = {};
    if (session.slack_channel) sessionEnv.BENDER_REPLY_CHANNEL = session.slack_channel;
    if (session.slack_thread_ts) sessionEnv.BENDER_REPLY_THREAD = session.slack_thread_ts;

    const claudeResult = await invokeClaude(session, prompt, this.config, githubToken, isChat, Object.keys(sessionEnv).length > 0 ? sessionEnv : undefined);

    // Restore session ID (don't lose it for future code work)
    if (isChat && savedSessionId) {
      session.claude_session_id = savedSessionId;
    }

    const durationSec = Math.round(claudeResult.durationMs / 1000);
    console.log(
      `[W${worker.id}] ← ${session.ticket_id} exit=${claudeResult.exitCode} ` +
        `duration=${durationSec}s killed=${claudeResult.killed}`,
    );

    // Update session with results
    if (claudeResult.sessionId) {
      if (!session.claude_session_id) {
        console.log(`[W${worker.id}] Captured session ID: ${claudeResult.sessionId}`);
      }
      session.claude_session_id = claudeResult.sessionId;
    } else {
      console.warn(`[W${worker.id}] No session ID captured from Claude output`);
    }

    // Extract PRs from Claude's output and update session
    const prMatches = (claudeResult.stdout + claudeResult.stderr)
      .matchAll(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/g);
    for (const match of prMatches) {
      const repo = match[1];
      const prNum = parseInt(match[2], 10);
      const alreadyTracked =
        (session.pr_number === prNum && session.repo === repo) ||
        session.additional_prs?.some((ap) => ap.pr_number === prNum && ap.repo === repo);
      if (!alreadyTracked) {
        if (!session.pr_number) {
          session.pr_number = prNum;
          session.repo = repo;
        } else {
          if (!session.additional_prs) session.additional_prs = [];
          session.additional_prs.push({ repo, pr_number: prNum });
        }
        if (session.phase === "starting") {
          const isSpec = /\bspec\b/i.test(session.ticket_title);
          session.phase = isSpec ? "spec_review" : "impl_review";
        }
        console.log(`[W${worker.id}] Detected PR: ${repo}#${prNum} on ${session.ticket_id} (phase=${session.phase})`);
      }
    }

    // Extract a useful summary from Claude's output (last meaningful lines)
    const summary = extractSummary(claudeResult.stdout || claudeResult.stderr);

    if (claudeResult.killed) {
      session.status = "parked";
      console.warn(
        `[W${worker.id}] ${session.ticket_id} killed by circuit breaker`,
      );
      if (session.agent_session_id) {
        const msg = await benderSpeak(
          `Hit the ${this.config.circuit_breaker.max_duration_minutes}-minute time limit on ${session.ticket_id}. Need to pause and continue later.` +
            (summary ? ` Last thing I was doing: ${summary}` : ""),
        );
        await emitError(session.agent_session_id, msg);
      }
    } else if (claudeResult.exitCode === 0) {
      session.status = "parked";

      // Post response to Slack if this was a Slack-triggered event
      if (event.source === "slack" && event.slack_channel && summary) {
        await slackPostMessage(event.slack_channel, summary, event.slack_thread_ts);
      }

      if (session.agent_session_id) {
        const maxTurnsHit = claudeResult.stderr.includes("max turns");
        if (maxTurnsHit) {
          const msg = await benderSpeak(
            `Ran out of tool turns on ${session.ticket_id} after ${durationSec}s. Work is in progress but couldn't finish. Will continue on next event.`,
          );
          await emitResponse(session.agent_session_id, msg);
        }
        // Normal completion: Claude already communicated via bender-say or
        // PR comments during its run. Don't double-post the summary.
      }
    } else {
      session.retry_count++;
      if (session.retry_count >= session.max_retries) {
        session.phase = "error";
        session.status = "error";
        if (session.agent_session_id) {
          const msg = await benderSpeak(
            `Failed ${session.max_retries} times on ${session.ticket_id} with exit code ${claudeResult.exitCode}. Need a human to help.` +
              (summary ? ` Error: ${summary}` : ""),
          );
          await emitError(session.agent_session_id, msg);
        }
      }
    }

    saveSession(session);
  }

  private async handleSlack(
    worker: Worker,
    event: TaskEvent,
  ): Promise<void> {
    // Record incoming message
    if (event.slack_user && event.comment_body) {
      recordMessage(event.slack_channel!, event.slack_user, event.comment_body, event.id);
    }

    // Check if this is an approval for a pending plan
    const threadTs = event.slack_thread_ts;
    if (threadTs && event.comment_body) {
      const pending = getPendingPlan(event.slack_channel!, threadTs);
      if (pending && isApproval(event.comment_body)) {
        console.log(`[W${worker.id}] Plan approved — dispatching work`);
        const ack = await benderSpeak(`The human approved a plan. Write a short excited 1-sentence acknowledgment.`);
        await slackPostMessage(event.slack_channel!, ack, threadTs);
        event.slack_thread_ts = threadTs;
        const workEvent = consumePlan(event.slack_channel!, threadTs);
        if (workEvent) {
          workEvent.slack_thread_ts = threadTs;
          await this.handleSlackWork(worker, workEvent);
        }
        return;
      }
    }

    // Check if inner Claude is waiting for a reply (written by bender-await-reply script)
    if (threadTs && event.comment_body && event.slack_channel) {
      const waitingState = readWaitingState(event.slack_channel, threadTs);
      if (waitingState) {
        // "bender: ..." prefix → route to chat classifier, not the worker
        const isBenderDirect = /^bender\s*:/i.test(event.comment_body.trim());
        if (isBenderDirect) {
          // Strip the prefix and let it fall through to the Sonnet classifier
          event.comment_body = event.comment_body.replace(/^bender\s*:\s*/i, "").trim();
          clearWaitingState(event.slack_channel, threadTs);
          console.log(`[W${worker.id}] "bender:" prefix — routing to chat, clearing waiting state`);
        } else {
          // Route reply to the worker
          console.log(`[W${worker.id}] Worker waiting — routing reply to handleSlackWork`);
          clearWaitingState(event.slack_channel, threadTs);
          event.comment_body = `## Worker's Question\n${waitingState.question}\n\n## User's Reply\n${event.comment_body}`;
          event.slack_thread_ts = threadTs;
          await this.handleSlackWork(worker, event);
          return;
        }
      }
    }

    const sessions = listActiveSessions();
    const sessionSummary = sessions
      .map((s) => {
        const threadMatch = (event.slack_thread_ts && s.slack_thread_ts === event.slack_thread_ts) ? " ← THIS THREAD" : "";
        return `${s.ticket_id}: ${s.ticket_title} (${s.phase}, PR #${s.pr_number ?? "none"}, repo: ${s.repo || "unknown"})${threadMatch}`;
      })
      .join("\n") || "No active work.";

    const busyWorkers = this.workers.filter((w) => w.busy && w.id !== worker.id);
    const workerStatus = busyWorkers.length > 0
      ? `IMPORTANT — Work already in progress on other workers:\n${busyWorkers.map((w) => `  Worker ${w.id}: ${w.current_description ?? w.current_ticket ?? "unknown task"}`).join("\n")}\nIf the user asks for status, tell them work IS running.`
      : "All other workers idle — no background work in progress.";

    // Fetch live conversation context from Slack
    let conversationContext = "";
    try {
      if (event.slack_thread_ts && event.slack_channel) {
        const threadMsgs = await getThreadMessages(event.slack_channel, event.slack_thread_ts);
        if (threadMsgs.length > 0) {
          conversationContext = "Thread history (oldest first):\n" + threadMsgs
            .map((m) => `<${m.user}>: ${m.text}`)
            .join("\n");
        }
      } else if (event.slack_channel) {
        const channelMsgs = await getChannelHistory(event.slack_channel, 15);
        if (channelMsgs.length > 0) {
          conversationContext = "Recent channel messages:\n" + channelMsgs
            .reverse()
            .map((m) => `<${m.user}>: ${m.text}`)
            .join("\n");
        }
      }
    } catch (err) {
      console.warn(`[W${worker.id}] Failed to fetch conversation context:`, err);
    }

    // Supplement with persisted cross-channel history for this user
    const userHistory = getUserContext(event.slack_user ?? "", 15);

    // One Sonnet call: classify + respond
    try {
      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.ANTHROPIC_API_KEY ?? "",
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1500,
          system: `You are Bender from Futurama, a coding agent on the Earthly team. Confident, concise, a bit cocky. No Claude-isms. No action narration.

Your active work:
${sessionSummary}

Runtime status: ${workerStatus}

${conversationContext ? `## Conversation Context\n${conversationContext}\n` : ""}
${userHistory ? `## Previous interactions with this user (across channels):\n${userHistory}\n` : ""}
Read the conversation context carefully before responding. Reference previous messages when relevant — don't make the user repeat themselves.

You have three modes:
1. CHAT — answering questions, status updates, banter. Just reply directly.
2. PLAN — someone is asking you to do non-trivial work. Propose a numbered plan for approval before starting.
3. WORK — someone said "yes/go/do it" to a plan, OR the task is dead simple (one-liner, trivial fix). Execute immediately.

Reply in JSON:
{"action": "chat" | "plan" | "work", "reply": "your natural reply", "plan": "numbered steps (only for action=plan)", "context_summary": "..."}

For plan/work actions, write a context_summary that captures ALL relevant decisions, requirements, and constraints from the conversation — both this thread AND prior interactions. The worker will only see this summary, not the raw conversation. Include specific details: file paths, naming decisions, schema choices, things the user corrected or emphasized. If the user mentioned workflow constraints (like "spec only", "don't implement yet", "just docs"), include those prominently.

Guidelines:
- "What's your status?" → chat
- "Go create a .NET repo, add it to the config, test the collector" → plan (multi-step, non-trivial)
- "Fix that typo" → work (dead simple)
- "Can you look into why CI is failing?" → plan (investigation, unclear scope)
- When in doubt between plan and work, choose plan. It's better to confirm than go down a rabbit hole.

IMPORTANT — Thread context: Each thread is tied to a specific PR/task (marked "THIS THREAD" above). If the user mentions a different PR or repo than the one this thread is for, politely point it out: "Hey, this thread is for PR #X on repo Y — did you mean to ask in the other thread?" Don't silently work on the wrong PR.
- Plans should be concise numbered steps, not essays.
- **CRITICAL for plan replies: You MUST end your reply with a question asking for permission to proceed.** Examples: "Want me to start?", "Sound good?", "Should I run with this?", "Ready to roll?" — vary it, but ALWAYS ask. The system waits for user approval before dispatching work.

If runtime status shows work in progress, report it accurately.`,
          messages: [{ role: "user", content: event.comment_body ?? "hey" }],
        }),
      });

      if (!resp.ok) {
        console.error(`[W${worker.id}] Slack Sonnet error: ${resp.status}`);
        return;
      }

      const data = (await resp.json()) as { content: Array<{ text: string }> };
      const rawReply = data.content[0].text;

      let action = "chat";
      let cleanReply = rawReply;
      let planText = "";
      let contextSummary = "";
      try {
        const jsonStr = rawReply.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
        const parsed = JSON.parse(jsonStr) as { action: string; reply: string; plan?: string; context_summary?: string };
        action = parsed.action;
        cleanReply = parsed.reply;
        planText = parsed.plan ?? "";
        contextSummary = parsed.context_summary ?? "";
      } catch {
        action = "chat";
        cleanReply = rawReply;
      }

      if (contextSummary) {
        event.context_summary = contextSummary;
      }

      if (action === "plan") {
        // Post the plan and wait for approval
        let fullReply = planText
          ? `${cleanReply}\n\n${planText}`
          : cleanReply;
        // Ensure the plan always ends with a question — fallback if Sonnet forgot
        if (!fullReply.trimEnd().endsWith("?")) {
          fullReply += "\n\nGo ahead?";
        }
        const ackTs = await slackPostMessage(event.slack_channel!, fullReply, event.slack_thread_ts);
        recordMessage(event.slack_channel!, "bender", fullReply, `reply:${event.id}`);
        const planThreadTs = event.slack_thread_ts ?? ackTs;
        if (planThreadTs) {
          storePlan(event.slack_channel!, planThreadTs, event, planText || cleanReply);
          // Track the thread so follow-ups reach us without @mention
          const { trackThread } = await import("./slack-threads.js");
          trackThread(`${event.slack_channel}:${planThreadTs}`);
        }
        console.log(`[W${worker.id}] ← slack plan posted, waiting for approval`);
      } else if (action === "work") {
        // Post ack — if not already in a thread, this creates one (inner Claude posts updates here)
        const ackTs = await slackPostMessage(event.slack_channel!, cleanReply, event.slack_thread_ts);
        recordMessage(event.slack_channel!, "bender", cleanReply, `reply:${event.id}`);
        // Use existing thread, or start a new thread on the ack message
        const workThreadTs = event.slack_thread_ts ?? ackTs;
        if (workThreadTs) {
          const { trackThread } = await import("./slack-threads.js");
          trackThread(`${event.slack_channel}:${workThreadTs}`);
        }
        console.log(`[W${worker.id}] ← slack ack+work (${cleanReply.length} chars), thread=${workThreadTs}`);
        event.slack_thread_ts = workThreadTs;
        await this.handleSlackWork(worker, event);
      } else {
        // Chat — just post the reply, and track the thread so we respond to follow-ups
        const replyTs = await slackPostMessage(event.slack_channel!, cleanReply, event.slack_thread_ts);
        recordMessage(event.slack_channel!, "bender", cleanReply, `reply:${event.id}`);
        const chatThreadTs = event.slack_thread_ts ?? replyTs;
        if (chatThreadTs) {
          const { trackThread } = await import("./slack-threads.js");
          trackThread(`${event.slack_channel}:${chatThreadTs}`);
        }
        console.log(`[W${worker.id}] ← slack chat (${cleanReply.length} chars)`);
      }
    } catch (err) {
      console.error(`[W${worker.id}] Slack handler error:`, err);
    }
  }

  private async handleSlackWork(
    worker: Worker,
    event: TaskEvent,
  ): Promise<void> {
    // Record incoming message
    if (event.slack_user && event.comment_body) {
      recordMessage(event.slack_channel!, event.slack_user, event.comment_body, event.id);
    }

    // Find the most relevant active session, or create a new one for this work
    const sessions = listActiveSessions();
    // If work is in an existing thread tied to a session, use that session
    let activeSession: Session | null = null;
    if (event.slack_channel && event.slack_thread_ts) {
      activeSession = sessions.find(
        (s) => s.slack_channel === event.slack_channel && s.slack_thread_ts === event.slack_thread_ts,
      ) ?? null;
    }
    // Otherwise don't assume — the work will create its own session if it opens a PR

    const githubToken = await getGitHubToken(activeSession?.repo);

    // Build prompt with work context
    const identity = existsSync(resolve(homedir(), "repos", "BENDER-IDENTITY.md"))
      ? readFileSync(resolve(homedir(), "repos", "BENDER-IDENTITY.md"), "utf-8")
      : "You are Bender, a coding agent.";

    const sessionContext = activeSession
      ? `Active ticket: ${activeSession.ticket_id} "${activeSession.ticket_title}" (PR #${activeSession.pr_number ?? "none"}, branch: ${activeSession.branch})`
      : "No active tickets.";

    // Fetch thread history so Claude has full conversation context
    let threadContext = "";
    try {
      if (event.slack_thread_ts && event.slack_channel) {
        const threadMsgs = await getThreadMessages(event.slack_channel, event.slack_thread_ts);
        if (threadMsgs.length > 0) {
          threadContext = threadMsgs
            .map((m) => `<${m.user}>: ${m.text}`)
            .join("\n");
        }
      }
    } catch (err) {
      console.warn(`[W${worker.id}] Failed to fetch thread context for work:`, err);
    }

    // Fetch PR review comments if we have a linked PR
    let prContext = "";
    if (activeSession?.pr_number && activeSession?.repo) {
      try {
        const prComments = await fetch(
          `https://api.github.com/repos/${activeSession.repo}/pulls/${activeSession.pr_number}/comments`,
          { headers: { Authorization: `Bearer ${githubToken}`, Accept: "application/vnd.github+json" } },
        );
        if (prComments.ok) {
          const comments = (await prComments.json()) as Array<{ user: { login: string }; body: string; path: string }>;
          const unresolved = comments.filter((c) => !c.user.login.includes("bot"));
          if (unresolved.length > 0) {
            prContext = unresolved
              .map((c) => `[${c.path}] ${c.user.login}: ${c.body}`)
              .join("\n\n");
          }
        }
      } catch (err) {
        console.warn(`[W${worker.id}] Failed to fetch PR comments:`, err);
      }
    }

    const prompt = [
      identity,
      "",
      `## IMPORTANT: Read ALL context below before starting work`,
      `The conversation history and PR comments contain requirements, refinements, and decisions.`,
      `Read everything carefully — missing a detail from earlier messages is the #1 source of bugs.`,
      "",
      `## Work Request from Slack`,
      `From: ${event.slack_user}`,
      `Channel: ${event.slack_channel}`,
      `Latest message: ${event.comment_body}`,
      "",
      ...(event.context_summary ? [
        `## Context Summary (from prior conversation — this is the most important section)`,
        `This summary was prepared from the full conversation including messages outside this thread.`,
        `It captures all decisions, requirements, constraints, and corrections discussed so far.`,
        event.context_summary,
        "",
      ] : []),
      ...(threadContext ? [
        `## Full Conversation History (this Slack thread — supplementary detail)`,
        `This thread contains the full discussion leading to this work request.`,
        `Pay attention to refinements, corrections, and specific details mentioned in earlier messages.`,
        threadContext,
        "",
      ] : []),
      ...(prContext ? [
        `## Open PR Review Comments`,
        `These are unresolved review comments on PR #${activeSession!.pr_number}. Address them during this work.`,
        prContext,
        "",
      ] : []),
      `## Session Context`,
      sessionContext,
      ...(activeSession ? [
        `Phase: ${activeSession.phase}`,
        `Branch: ${activeSession.branch}`,
        activeSession.pr_number ? `PR: #${activeSession.pr_number} on ${activeSession.repo}` : "",
      ].filter(Boolean) : []),
      "",
      `## Before You Start (MANDATORY — do these in order)`,
      ``,
      `**Step 1: Read all documentation.**`,
      `- Read AGENTS.md / CLAUDE.md in the repo root if they exist`,
      `- Read \`.ai-implementation/\` directory if it exists (playbooks, workflow rules)`,
      `- Read \`ai-context/\` directory if it exists (conventions, schemas, SDK reference)`,
      `- Look at 2-3 existing examples similar to your task for patterns`,
      ``,
      `**Step 2: Read the full task context.**`,
      `- The Context Summary above captures the conversation so far — read it carefully`,
      `- The Conversation History below has the raw thread messages — scan for any details the summary missed`,
      `- If there's a linked PR, read its description and all review comments`,
      `- If there's a Linear ticket, read the ticket description for requirements`,
      ``,
      `**Step 3: Decide your workflow mode.**`,
      `Based on what you read in the docs and the task at hand, decide:`,
      `- **Spec-first**: The repo's playbook says new plugins need spec review before implementation → only write manifests, READMEs, examples, docs. No implementation code.`,
      `- **Implementation**: A spec was already approved and reviewers said to implement → write the code, following the existing spec as your guide.`,
      `- **Freeform**: No structured workflow applies (doc updates, CI fixes, investigations, non-plugin work) → do whatever the task requires.`,
      `If the context summary mentions constraints (e.g. "spec only", "don't implement yet"), those override everything.`,
      ``,
      `**Step 4: Execute.**`,
      `- A plan was discussed and approved in the conversation. Make progress on it.`,
      `- If something is unclear, use \`bender-await-reply\` to ask — better than guessing wrong.`,
      `- But do NOT just re-propose the same plan. The human said go ahead.`,
      `- Make changes, commit, and push. You have full tool access.`,
      ``,
      `Stay in character as Bender.`,
      ``,
      `## Communication`,
      `Post progress updates to the Slack thread:`,
      `  curl -s -X POST https://slack.com/api/chat.postMessage -H "Authorization: Bearer $SLACK_BOT_TOKEN" -H "Content-Type: application/json" -d '{"channel":"'$BENDER_REPLY_CHANNEL'","thread_ts":"'$BENDER_REPLY_THREAD'","text":"your message"}'`,
      ``,
      `**If you need user input** (clarification, approval, a choice between options):`,
      `  bender-await-reply "Your question here"`,
      `This posts your question to the thread with instructions for the user, then EXIT (exit 0).`,
      `The server will route their reply back to a new worker invocation with full context.`,
      `Do NOT continue working after calling bender-await-reply — just exit and wait.`,
      ``,
      `- Post brief updates when you hit milestones or finish.`,
      `- If asked to message someone in a specific channel, do it directly.`,
      `- If the user's message contains multiple requests, address all of them.`,
      ``,
      `## File Downloads`,
      `If the message references Slack files (url_private_download), download them with:`,
      `  curl -s -H "Authorization: Bearer $SLACK_BOT_TOKEN" "FILE_URL" -o /tmp/filename`,
      `Read the downloaded file and use its contents as context for your work.`,
    ].join("\n");

    // Use a temporary session-like object for the executor
    const tempSession: Session = activeSession ?? {
      ticket_id: "slack-work",
      ticket_title: "Slack work request",
      ticket_url: "",
      repo: "",
      pr_number: null,
      branch: "",
      phase: "starting" as const,
      status: "active" as const,
      go_ahead: { brandon: false, vlad: false, override: null },
      approvals: { brandon: false, vlad: false, override: null },
      blocked: null,
      last_event_id: event.id,
      last_activity_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      conversation_summary: "",
      claude_session_id: null,
      agent_session_id: null,
      checkpoint_count: 0,
      last_checkpoint_summary: null,
      ticket_notes: [],
      test_results_posted: false,
      ci_status: "unknown" as const,
      worktree_path: resolve(homedir(), "repos"),
      retry_count: 0,
      max_retries: 3,
      additional_prs: [],
      slack_channel: event.slack_channel ?? null,
      slack_thread_ts: event.slack_thread_ts ?? null,
    };

    // Fresh invocation — don't resume, stale context causes hallucinated rules
    tempSession.claude_session_id = null;

    // Pass reply channel/thread so Claude CLI can post updates to the right thread
    const extraEnv: Record<string, string> = {};
    if (event.slack_channel) extraEnv.BENDER_REPLY_CHANNEL = event.slack_channel;
    if (event.slack_thread_ts) extraEnv.BENDER_REPLY_THREAD = event.slack_thread_ts;

    const claudeResult = await invokeClaude(tempSession, prompt, this.config, githubToken, false, extraEnv);

    // Save session ID if captured
    if (claudeResult.sessionId && activeSession) {
      activeSession.claude_session_id = claudeResult.sessionId;
      saveSession(activeSession);
    }

    // Extract PRs from Claude's output and persist to session
    const prMatches = (claudeResult.stdout + claudeResult.stderr)
      .matchAll(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/g);
    for (const match of prMatches) {
      const repo = match[1];
      const prNum = parseInt(match[2], 10);
      if (activeSession) {
        if (!activeSession.additional_prs) activeSession.additional_prs = [];
        const alreadyTracked =
          (activeSession.pr_number === prNum && activeSession.repo === repo) ||
          activeSession.additional_prs.some((ap) => ap.pr_number === prNum && ap.repo === repo);
        if (!alreadyTracked) {
          // First PR becomes the primary, rest go to additional_prs
          if (!activeSession.pr_number) {
            activeSession.pr_number = prNum;
            activeSession.repo = repo;
          } else {
            activeSession.additional_prs.push({ repo, pr_number: prNum });
          }
          if (activeSession.phase === "starting") {
            const isSpec = /\bspec\b/i.test(activeSession.ticket_title);
            activeSession.phase = isSpec ? "spec_review" : "impl_review";
          }
          saveSession(activeSession);
          console.log(`[W${worker.id}] Tracked PR: ${repo}#${prNum} on ${activeSession.ticket_id} (phase=${activeSession.phase})`);
        }
      }
    }

    // Store Slack thread on session for future reference
    if (activeSession && event.slack_channel && event.slack_thread_ts) {
      if (!activeSession.slack_channel) {
        activeSession.slack_channel = event.slack_channel;
        activeSession.slack_thread_ts = event.slack_thread_ts;
        saveSession(activeSession);
      }
    }

    const durationSec = Math.round(claudeResult.durationMs / 1000);

    // Waiting state is now handled by bender-await-reply script (writes file to ~/.bender/waiting/).
    // No regex detection needed — inner Claude explicitly declares when it's waiting.

    // Only post server-side for errors/timeouts
    if (claudeResult.killed && event.slack_channel) {
      const msg = await benderSpeak(`Hit the time limit after ${durationSec}s. Work is partially done.`);
      await slackPostMessage(event.slack_channel, msg, event.slack_thread_ts);
    } else if (claudeResult.exitCode !== 0 && event.slack_channel) {
      const msg = await benderSpeak(`Hit an error (exit ${claudeResult.exitCode}) after ${durationSec}s.`);
      await slackPostMessage(event.slack_channel, msg, event.slack_thread_ts);
    }

    console.log(
      `[W${worker.id}] ← slack work done exit=${claudeResult.exitCode} duration=${durationSec}s`,
    );
  }

  /**
   * Initialize a Slack DM thread for a session — the "agent tab."
   * Looks up the ticket assignee in PEOPLE.json, opens a DM, posts an init message.
   */
  private async initSlackThreadForSession(
    session: Session,
    event: TaskEvent,
  ): Promise<{ channel: string; threadTs: string } | null> {
    if (!process.env.SLACK_BOT_TOKEN) return null;

    // Load PEOPLE.json
    const peoplePath = resolve(homedir(), "repos", "PEOPLE.json");
    if (!existsSync(peoplePath)) {
      const altPath = resolve(homedir(), "bender", "PEOPLE.json");
      if (!existsSync(altPath)) return null;
    }

    let people: Record<string, { github: string; slack: string; linear: string }>;
    try {
      const p = existsSync(resolve(homedir(), "repos", "PEOPLE.json"))
        ? resolve(homedir(), "repos", "PEOPLE.json")
        : resolve(homedir(), "bender", "PEOPLE.json");
      people = JSON.parse(readFileSync(p, "utf-8"));
    } catch {
      return null;
    }

    // Find the assignee from the event's raw payload
    const raw = event.raw as Record<string, unknown> | undefined;
    const agentSession = raw?.agentSession as Record<string, unknown> | undefined;
    const creator = agentSession?.creator as Record<string, unknown> | undefined;
    const assigneeName = creator?.name as string | undefined;

    if (!assigneeName) return null;

    const person = people[assigneeName];
    if (!person?.slack) {
      console.log(`[slack] No Slack ID for ${assigneeName} in PEOPLE.json`);
      return null;
    }

    // Open a DM channel
    const openResp = await fetch("https://slack.com/api/conversations.open", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
      },
      body: JSON.stringify({ users: person.slack }),
    });
    const openData = (await openResp.json()) as Record<string, unknown>;
    if (!openData.ok) return null;

    const dmChannel = (openData.channel as Record<string, unknown>)?.id as string;
    if (!dmChannel) return null;

    // Post the init message
    const initMsg = await benderSpeak(
      `Picked up ticket ${session.ticket_id}: "${session.ticket_title}". Going to work on it and will post updates in this thread.`,
    );
    const ticketLink = session.ticket_url ? ` <${session.ticket_url}|${session.ticket_id}>` : ` ${session.ticket_id}`;
    const fullMsg = `${initMsg}\n\nTicket:${ticketLink}`;

    const msgTs = await slackPostMessage(dmChannel, fullMsg);
    if (!msgTs) return null;

    console.log(`[slack] Initialized agent tab for ${session.ticket_id} → DM with ${assigneeName}`);
    return { channel: dmChannel, threadTs: msgTs };
  }

  /**
   * Get status summary for the status endpoint.
   */
  getStatus(): {
    workers: Worker[];
    queue_length: number;
    queue_items: Array<{ type: string; priority: number; source: string }>;
  } {
    return {
      workers: this.workers,
      queue_length: this.queue.length,
      queue_items: this.queue.map((q) => ({
        type: q.event.type,
        priority: q.event.priority,
        source: q.event.source,
      })),
    };
  }

  private busyCount(): number {
    return this.workers.filter((w) => w.busy).length;
  }
}

function extractSummary(output: string): string {
  if (!output) return "";
  // Strip the prompt echo (everything before first blank line after "Begin." or "Bender.")
  const promptEnd = output.lastIndexOf("Stay in character as Bender.");
  const cleaned = promptEnd >= 0
    ? output.slice(promptEnd + "Stay in character as Bender.".length).trim()
    : output.trim();

  const lines = cleaned.split("\n").filter((l) => {
    const t = l.trim();
    return t.length > 0 && !t.startsWith("---") && !t.startsWith("===") && !t.startsWith("Exit code:");
  });
  return lines.join("\n").slice(0, 4000);
}
