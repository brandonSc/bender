import type { Config, TaskEvent, Worker } from "./types.js";
import { routeEvent, type RouteResult } from "./router.js";
import { saveSession } from "./session-store.js";
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

interface QueueItem {
  event: TaskEvent;
  received_at: number;
}

export class TaskManager {
  private queue: QueueItem[] = [];
  private workers: Worker[] = [];
  private config: Config;
  private processing = false;

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
   * Enqueue an event for processing. Events are sorted by priority.
   */
  enqueue(event: TaskEvent): void {
    this.queue.push({ event, received_at: Date.now() });
    // Sort by priority (lower number = higher priority)
    this.queue.sort((a, b) => a.event.priority - b.event.priority);

    console.log(
      `[queue] +${event.type} (pri=${event.priority}) from ${event.source}` +
        (event.pr_number ? ` PR#${event.pr_number}` : "") +
        (event.ticket_id ? ` ${event.ticket_id}` : "") +
        ` | queue=${this.queue.length} workers=${this.busyCount()}/${this.workers.length}`,
    );

    this.processNext();
  }

  /**
   * Try to assign the next queued event to a free worker.
   */
  private processNext(): void {
    if (this.queue.length === 0) return;

    const worker = this.workers.find((w) => !w.busy);
    if (!worker) return; // All workers busy

    const item = this.queue.shift()!;
    this.dispatch(worker, item.event);
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

    // Notify Linear that we're working
    if (session.agent_session_id) {
      const desc = isNewSession
        ? `Picking up ${session.ticket_id}: ${session.ticket_title}`
        : `Resuming work on ${session.ticket_id} (${event.type})`;
      await emitThought(session.agent_session_id, desc);
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
    const claudeResult = await invokeClaude(session, prompt, this.config);

    console.log(
      `[W${worker.id}] ← ${session.ticket_id} exit=${claudeResult.exitCode} ` +
        `duration=${Math.round(claudeResult.durationMs / 1000)}s ` +
        `killed=${claudeResult.killed}`,
    );

    // Update session with results
    if (claudeResult.sessionId && !session.claude_session_id) {
      session.claude_session_id = claudeResult.sessionId;
    }

    if (claudeResult.killed) {
      session.status = "parked";
      console.warn(
        `[W${worker.id}] ${session.ticket_id} killed by circuit breaker`,
      );
      if (session.agent_session_id) {
        await emitError(
          session.agent_session_id,
          `Circuit breaker tripped after ${this.config.circuit_breaker.max_duration_minutes} minutes. I'll pick this up on the next event.`,
        );
      }
    } else if (claudeResult.exitCode === 0) {
      session.status = "parked";
      if (session.agent_session_id) {
        await emitResponse(
          session.agent_session_id,
          `Done with this step. Waiting for reviewer feedback or next event.`,
        );
      }
    } else {
      session.retry_count++;
      if (session.retry_count >= session.max_retries) {
        session.phase = "error";
        session.status = "error";
        if (session.agent_session_id) {
          await emitError(
            session.agent_session_id,
            `Failed after ${session.max_retries} retries. Needs human attention.`,
          );
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
