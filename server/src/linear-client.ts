import { getLinearToken, refreshLinearToken } from "./linear-auth.js";

const LINEAR_API = "https://api.linear.app/graphql";

async function query(gql: string, variables?: Record<string, unknown>): Promise<unknown> {
  let token = getLinearToken();
  if (!token) throw new Error("Linear not authorized — visit /auth/linear to connect");

  let response = await fetch(LINEAR_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: token,
    },
    body: JSON.stringify({ query: gql, variables }),
  });

  // Auto-refresh on 401
  if (response.status === 401) {
    const clientId = process.env.LINEAR_CLIENT_ID ?? "";
    const clientSecret = process.env.LINEAR_CLIENT_SECRET ?? "";
    const newToken = await refreshLinearToken(clientId, clientSecret);
    if (newToken) {
      token = newToken;
      response = await fetch(LINEAR_API, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: token,
        },
        body: JSON.stringify({ query: gql, variables }),
      });
    }
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Linear API error: ${response.status} ${text}`);
  }

  const result = await response.json() as { data?: unknown; errors?: Array<{ message: string }> };
  if (result.errors?.length) {
    throw new Error(`Linear GraphQL error: ${result.errors[0].message}`);
  }

  return result.data;
}

/**
 * Update a Linear issue's state (status).
 */
export async function updateIssueState(
  issueId: string,
  stateId: string,
): Promise<void> {
  await query(
    `mutation($issueId: String!, $stateId: String!) {
      issueUpdate(id: $issueId, input: { stateId: $stateId }) {
        success
      }
    }`,
    { issueId, stateId },
  );
}

/**
 * Post a comment on a Linear issue.
 */
export async function postComment(
  issueId: string,
  body: string,
): Promise<void> {
  await query(
    `mutation($issueId: String!, $body: String!) {
      commentCreate(input: { issueId: $issueId, body: $body }) {
        success
      }
    }`,
    { issueId, body },
  );
}

/**
 * Get issue details by identifier (e.g. "ENG-500").
 */
export async function getIssue(identifier: string): Promise<{
  id: string;
  title: string;
  description: string | null;
  url: string;
  state: { name: string };
  assignee: { id: string; name: string } | null;
}> {
  const data = await query(
    `query($identifier: String!) {
      issue(id: $identifier) {
        id
        title
        description
        url
        state { name }
        assignee { id name }
      }
    }`,
    { identifier },
  ) as { issue: ReturnType<typeof getIssue> extends Promise<infer T> ? T : never };

  return data.issue;
}

/**
 * Get workflow states for a team (to map phase → Linear status).
 */
export async function getTeamStates(teamKey: string): Promise<
  Array<{ id: string; name: string; type: string }>
> {
  const data = await query(
    `query($teamKey: String!) {
      team(id: $teamKey) {
        states { nodes { id name type } }
      }
    }`,
    { teamKey },
  ) as { team: { states: { nodes: Array<{ id: string; name: string; type: string }> } } };

  return data.team.states.nodes;
}

/**
 * Close a ticket by moving it to "Done" state.
 * Finds the Done state for the ticket's team and transitions it.
 */
export async function closeTicket(ticketIdentifier: string): Promise<boolean> {
  try {
    const issue = await getIssue(ticketIdentifier);
    if (!issue) return false;
    if (issue.state.name === "Done" || issue.state.name === "Canceled") return true;

    // Get the team's states to find "Done"
    const issueData = await query(
      `query($id: String!) {
        issue(id: $id) { team { states { nodes { id name type } } } }
      }`,
      { id: ticketIdentifier },
    ) as { issue: { team: { states: { nodes: Array<{ id: string; name: string; type: string }> } } } };

    const doneState = issueData.issue.team.states.nodes.find(
      (s) => s.type === "completed" || s.name === "Done",
    );
    if (!doneState) return false;

    await updateIssueState(issue.id, doneState.id);
    console.log(`[linear] Closed ticket ${ticketIdentifier} → ${doneState.name}`);
    return true;
  } catch (err) {
    console.error(`[linear] Failed to close ticket ${ticketIdentifier}:`, err);
    return false;
  }
}

/**
 * Get the authenticated application/user info (to verify token works).
 */
export async function getViewer(): Promise<{ id: string; name: string; email?: string }> {
  const data = await query(`query { viewer { id name email } }`) as {
    viewer: { id: string; name: string; email?: string };
  };
  return data.viewer;
}
