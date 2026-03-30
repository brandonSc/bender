import type { Config, TaskEvent, Worker } from "./types.js";
import { routeEvent, type RouteResult } from "./router.js";
import { saveSession, findSessionForEvent } from "./session-store.js";
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
import { getAppOctokit, getInstallationToken } from "./github-auth.js";

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
        model: "claude-haiku-4-20250514",
        max_tokens: 150,
        messages: [{
          role: "user",
          content: `You are Bender from Futurama, a coding agent. Write a 1-sentence status update. Be confident and slightly sassy but concise — no essays, no action narration. Only use a Futurama reference if it genuinely fits the moment. End with 🤖.\n\nSituation: ${situation}`,
        }],
      }),
    });
    if (!resp.ok) throw new Error(`${resp.status}`);
    const data = await resp.json() as { content: Array<{ text: string }> };
    return data.content[0].text;
  } catch {
    return situation;
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
      this.processNext();
    }
  }

  private async executeTask(
    worker: Worker,
    result: RouteResult,
  ): Promise<void> {
    const { session, event, isNewSession, needsCheckpoint } = result;

    // Get a GitHub installation token for Claude to use
    let githubToken: string | undefined;
    try {
      const octokit = getAppOctokit();
      const { data: installations } = await octokit.rest.apps.listInstallations();
      if (installations.length > 0) {
        githubToken = await getInstallationToken(installations[0].id);
      }
    } catch (err) {
      console.warn(`[W${worker.id}] Failed to get GitHub token:`, err);
    }

    // Only post a thought for new tickets, not every resumed message
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

    // Invoke Claude
    const claudeResult = await invokeClaude(session, prompt, this.config, githubToken);

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
