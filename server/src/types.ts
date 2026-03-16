// --- Session State ---

export interface GoAheadState {
  brandon: boolean;
  vlad: boolean;
  override: string | null; // "brandon" or "vlad" if one waived the other
}

export interface BlockedState {
  reason: string;
  pr_comment_id: number;
  blocked_since: string; // ISO timestamp
}

export type Phase =
  | "starting"
  | "spec_review"
  | "implementing"
  | "impl_review"
  | "merging"
  | "done"
  | "blocked"
  | "error";

export type TaskStatus = "active" | "parked" | "blocked" | "done" | "error";

export interface Session {
  ticket_id: string;
  ticket_title: string;
  ticket_url: string;

  repo: string; // "earthly/lunar-lib"
  pr_number: number | null;
  branch: string;

  phase: Phase;
  status: TaskStatus;

  go_ahead: GoAheadState;
  approvals: GoAheadState;

  blocked: BlockedState | null;

  last_event_id: string;
  last_activity_at: string;
  created_at: string;

  conversation_summary: string;

  claude_session_id: string | null;
  checkpoint_count: number;
  last_checkpoint_summary: string | null;

  ticket_notes: string[];

  test_results_posted: boolean;
  ci_status: "unknown" | "passing" | "failing" | "running";

  worktree_path: string;

  retry_count: number;
  max_retries: number;
}

// --- Events ---

export type EventPriority = 1 | 2 | 3 | 4 | 5;

export type EventType =
  | "ci_failure"
  | "reviewer_unblock"
  | "reviewer_comment"
  | "pr_review"
  | "new_ticket"
  | "informational";

export interface TaskEvent {
  id: string;
  type: EventType;
  priority: EventPriority;
  timestamp: string;
  source: "github" | "linear";

  // GitHub-specific
  repo?: string;
  pr_number?: number;
  comment_body?: string;
  comment_author?: string;
  review_state?: "approved" | "changes_requested" | "commented";

  // Linear-specific
  ticket_id?: string;
  ticket_title?: string;
  ticket_url?: string;

  // Raw payload for the executor
  raw: unknown;
}

// --- Config ---

export interface Config {
  claude: {
    model: string;
    max_turns: number;
  };
  workers: {
    max_concurrent: number;
  };
  circuit_breaker: {
    max_duration_minutes: number;
    max_tokens: number;
  };
  retry: {
    max_retries: number;
  };
}

export interface Secrets {
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY_PATH: string;
  GITHUB_WEBHOOK_SECRET: string;
  LINEAR_CLIENT_ID: string;
  LINEAR_CLIENT_SECRET: string;
  LINEAR_WEBHOOK_SECRET: string;
  LUNAR_HUB_TOKEN: string;
  ANTHROPIC_API_KEY: string;
}

// --- Worker ---

export interface Worker {
  id: number;
  busy: boolean;
  current_ticket: string | null;
}
