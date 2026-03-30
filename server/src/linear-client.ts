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
 * Get the authenticated application/user info (to verify token works).
 */
export async function getViewer(): Promise<{ id: string; name: string; email?: string }> {
  const data = await query(`query { viewer { id name email } }`) as {
    viewer: { id: string; name: string; email?: string };
  };
  return data.viewer;
}
