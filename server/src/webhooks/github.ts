import { createHmac, timingSafeEqual } from "node:crypto";
import type { Request } from "express";
import type { TaskEvent, EventPriority, EventType } from "../types.js";

// Reviewer GitHub usernames we track for go-ahead / approval gates
const REVIEWERS = new Set(["brandonSc", "vladaionescu"]);

/**
 * Verify the X-Hub-Signature-256 header against the webhook secret.
 */
export function verifyGitHubSignature(
  payload: string,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!signature) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
  if (expected.length !== signature.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

/**
 * Parse a GitHub webhook event into a TaskEvent (or null if we don't care about it).
 */
export function parseGitHubEvent(
  eventType: string,
  payload: Record<string, unknown>,
): TaskEvent | null {
  const action = payload.action as string | undefined;

  switch (eventType) {
    case "issue_comment":
      return parseIssueComment(payload, action);

    case "pull_request_review":
      return parsePullRequestReview(payload, action);

    case "pull_request_review_comment":
      return parsePRReviewComment(payload, action);

    case "check_suite":
      return parseCheckSuite(payload, action);

    case "pull_request":
      return parsePullRequest(payload, action);

    case "push":
      return parsePush(payload);

    default:
      return null;
  }
}

function parseIssueComment(
  payload: Record<string, unknown>,
  action: string | undefined,
): TaskEvent | null {
  if (action !== "created") return null;

  const issue = payload.issue as Record<string, unknown>;
  // Only care about comments on PRs (issues with pull_request key)
  if (!issue?.pull_request) return null;

  const comment = payload.comment as Record<string, unknown>;
  const author = (comment.user as Record<string, unknown>)?.login as string;
  const body = comment.body as string;
  const repo = (payload.repository as Record<string, unknown>)
    ?.full_name as string;
  const prNumber = issue.number as number;

  // Ignore bot comments (our own, CodeRabbit, etc.)
  if (author.includes("[bot]")) return null;

  // Check if this is a reviewer unblocking a parked task
  const isReviewer = REVIEWERS.has(author);
  const isGoAhead = isReviewer && isGoAheadComment(body);

  const type: EventType = isGoAhead ? "reviewer_unblock" : "reviewer_comment";
  const priority: EventPriority = isGoAhead ? 2 : 3;

  return {
    id: `issue_comment:${(comment.id as number).toString()}`,
    type,
    priority,
    timestamp: comment.created_at as string,
    source: "github",
    repo,
    pr_number: prNumber,
    comment_body: body,
    comment_author: author,
    raw: payload,
  };
}

function parsePullRequestReview(
  payload: Record<string, unknown>,
  action: string | undefined,
): TaskEvent | null {
  if (action !== "submitted") return null;

  const review = payload.review as Record<string, unknown>;
  const state = (review.state as string).toLowerCase();
  const author = (review.user as Record<string, unknown>)?.login as string;
  const body = (review.body as string) ?? "";
  const pr = payload.pull_request as Record<string, unknown>;
  const repo = (payload.repository as Record<string, unknown>)
    ?.full_name as string;
  const prNumber = pr.number as number;

  // Map review state
  let reviewState: "approved" | "changes_requested" | "commented";
  if (state === "approved") {
    reviewState = "approved";
  } else if (state === "changes_requested") {
    reviewState = "changes_requested";
  } else {
    reviewState = "commented";
  }

  // "commented" reviews with no body always come paired with a review_comment event
  // that has the actual text — skip the empty review to avoid stealing the worker slot
  if (reviewState === "commented" && !body) return null;

  const isApproval = reviewState === "approved" && REVIEWERS.has(author);
  const type: EventType = isApproval ? "reviewer_unblock" : "pr_review";
  const priority: EventPriority = isApproval ? 2 : 3;

  return {
    id: `pr_review:${(review.id as number).toString()}`,
    type,
    priority,
    timestamp: review.submitted_at as string,
    source: "github",
    repo,
    pr_number: prNumber,
    comment_body: body,
    comment_author: author,
    review_state: reviewState,
    raw: payload,
  };
}

function parsePRReviewComment(
  payload: Record<string, unknown>,
  action: string | undefined,
): TaskEvent | null {
  if (action !== "created") return null;

  const comment = payload.comment as Record<string, unknown>;
  const author = (comment.user as Record<string, unknown>)?.login as string;
  const body = comment.body as string;
  const pr = payload.pull_request as Record<string, unknown>;
  const repo = (payload.repository as Record<string, unknown>)
    ?.full_name as string;
  const prNumber = pr.number as number;

  if (author.includes("[bot]")) return null;

  return {
    id: `pr_review_comment:${(comment.id as number).toString()}`,
    type: "reviewer_comment",
    priority: 3,
    timestamp: comment.created_at as string,
    source: "github",
    repo,
    pr_number: prNumber,
    comment_body: body,
    comment_author: author,
    raw: payload,
  };
}

function parseCheckSuite(
  payload: Record<string, unknown>,
  action: string | undefined,
): TaskEvent | null {
  if (action !== "completed") return null;

  const suite = payload.check_suite as Record<string, unknown>;
  const conclusion = suite.conclusion as string;
  const repo = (payload.repository as Record<string, unknown>)
    ?.full_name as string;

  // We need to find the PR number from the check suite's pull_requests array
  const prs = suite.pull_requests as Array<Record<string, unknown>>;
  if (!prs || prs.length === 0) return null;
  const prNumber = prs[0].number as number;

  if (conclusion === "failure" || conclusion === "timed_out") {
    return {
      id: `check_suite:${(suite.id as number).toString()}`,
      type: "ci_failure",
      priority: 1,
      timestamp: new Date().toISOString(),
      source: "github",
      repo,
      pr_number: prNumber,
      raw: payload,
    };
  }

  // CI passed — informational
  return {
    id: `check_suite:${(suite.id as number).toString()}`,
    type: "informational",
    priority: 5,
    timestamp: new Date().toISOString(),
    source: "github",
    repo,
    pr_number: prNumber,
    raw: payload,
  };
}

function parsePullRequest(
  payload: Record<string, unknown>,
  action: string | undefined,
): TaskEvent | null {
  const pr = payload.pull_request as Record<string, unknown>;
  const repo = (payload.repository as Record<string, unknown>)
    ?.full_name as string;
  const prNumber = pr.number as number;

  if (action === "closed" && pr.merged) {
    return {
      id: `pr_merged:${prNumber}`,
      type: "informational",
      priority: 5,
      timestamp: new Date().toISOString(),
      source: "github",
      repo,
      pr_number: prNumber,
      raw: payload,
    };
  }

  return null;
}

function parsePush(payload: Record<string, unknown>): TaskEvent | null {
  const repo = (payload.repository as Record<string, unknown>)
    ?.full_name as string;
  const ref = payload.ref as string;

  return {
    id: `push:${payload.after as string}`,
    type: "informational",
    priority: 5,
    timestamp: new Date().toISOString(),
    source: "github",
    repo,
    comment_body: `Push to ${ref}`,
    raw: payload,
  };
}

function isGoAheadComment(body: string): boolean {
  const lower = body.toLowerCase().trim();
  const goAheadPhrases = [
    "go ahead",
    "lgtm",
    "looks good",
    "looks great",
    "ship it",
    "approved",
    "good to go",
    "proceed",
  ];
  return goAheadPhrases.some((phrase) => lower.includes(phrase));
}
