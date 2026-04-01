import type { TaskEvent } from "./types.js";

interface PendingPlan {
  event: TaskEvent;
  plan: string;
  createdAt: number;
}

const pendingPlans = new Map<string, PendingPlan>();
const PLAN_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

function planKey(channel: string, threadTs: string): string {
  return `${channel}:${threadTs}`;
}

export function storePlan(
  channel: string,
  threadTs: string,
  event: TaskEvent,
  plan: string,
): void {
  pendingPlans.set(planKey(channel, threadTs), {
    event,
    plan,
    createdAt: Date.now(),
  });
  cleanup();
}

export function getPendingPlan(
  channel: string,
  threadTs: string | undefined,
): PendingPlan | null {
  if (!threadTs) return null;
  const key = planKey(channel, threadTs);
  const plan = pendingPlans.get(key);
  if (!plan) return null;
  if (Date.now() - plan.createdAt > PLAN_TIMEOUT_MS) {
    pendingPlans.delete(key);
    return null;
  }
  return plan;
}

export function consumePlan(
  channel: string,
  threadTs: string,
): TaskEvent | null {
  const key = planKey(channel, threadTs);
  const plan = pendingPlans.get(key);
  if (!plan) return null;
  pendingPlans.delete(key);
  // Append the approved plan to the event body so Claude has it
  if (plan.plan && plan.event.comment_body) {
    plan.event.comment_body += `\n\n## Approved Plan\n${plan.plan}`;
  }
  return plan.event;
}

const APPROVAL_PATTERNS = /^(yes|yeah|yep|go|go ahead|do it|ship it|lgtm|approved|proceed|start|ok|okay|sure|go for it|sounds good|let's do it|lets do it)\b/i;

export function isApproval(text: string): boolean {
  return APPROVAL_PATTERNS.test(text.trim());
}

// --- Work continuations: threads where inner Claude asked a question ---

interface PendingContinuation {
  event: TaskEvent;
  lastOutput: string;
  createdAt: number;
}

const pendingContinuations = new Map<string, PendingContinuation>();
const CONTINUATION_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour

export function storeWorkContinuation(
  channel: string,
  threadTs: string,
  event: TaskEvent,
  lastOutput: string,
): void {
  pendingContinuations.set(planKey(channel, threadTs), {
    event,
    lastOutput,
    createdAt: Date.now(),
  });
}

export function getWorkContinuation(
  channel: string,
  threadTs: string | undefined,
): PendingContinuation | null {
  if (!threadTs) return null;
  const key = planKey(channel, threadTs);
  const cont = pendingContinuations.get(key);
  if (!cont) return null;
  if (Date.now() - cont.createdAt > CONTINUATION_TIMEOUT_MS) {
    pendingContinuations.delete(key);
    return null;
  }
  return cont;
}

export function consumeWorkContinuation(
  channel: string,
  threadTs: string,
): TaskEvent | null {
  const key = planKey(channel, threadTs);
  const cont = pendingContinuations.get(key);
  if (!cont) return null;
  pendingContinuations.delete(key);
  return cont.event;
}

function cleanup(): void {
  const now = Date.now();
  for (const [key, plan] of pendingPlans) {
    if (now - plan.createdAt > PLAN_TIMEOUT_MS) pendingPlans.delete(key);
  }
  for (const [key, cont] of pendingContinuations) {
    if (now - cont.createdAt > CONTINUATION_TIMEOUT_MS) pendingContinuations.delete(key);
  }
}
