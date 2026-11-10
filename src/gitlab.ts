/**
 * Talking to GitLab's GraphQL API the same way `kiosko-plugin-gitlab` does:
 * with a personal access token straight over HTTPS, or, without one, through
 * the `glab` CLI and its login. Everything else in this plugin only sees a
 * `GraphQL` function, so it is tested without the network.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Runs one GraphQL query and returns the raw JSON text. */
export type GraphQL = (query: string) => Promise<string>;

export interface Connection {
  /** The `glab` command, used when there is no token. */
  bin: string;
  /** GitLab host; empty = glab's default, or gitlab.com with a token. */
  host: string;
  /** Personal access token (read_api). Empty = use glab. */
  token: string;
}

/** `gitlab.example.com` → `https://gitlab.example.com/api/graphql`. */
export function graphqlUrl(host: string): string {
  const h = (host.trim() || 'gitlab.com').replace(/\/+$/, '');
  return `${/^https?:\/\//.test(h) ? h : `https://${h}`}/api/graphql`;
}

/** Queries GitLab until `signal` aborts (Kiosko aborts it after the source's `timeoutMs`). */
export function connect(c: Connection, signal: AbortSignal): GraphQL {
  if (c.token.trim()) {
    return async (query) => {
      const res = await fetch(graphqlUrl(c.host), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.token.trim()}` },
        body: JSON.stringify({ query }),
        signal,
      });
      if (!res.ok) throw new Error(`GitLab HTTP ${res.status}`);
      return res.text();
    };
  }
  const host = c.host.trim() ? ['--hostname', c.host.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '')] : [];
  return async (query) => (await execFileAsync(c.bin || 'glab', ['api', 'graphql', '-f', `query=${query}`, ...host], { maxBuffer: 8_000_000, signal })).stdout;
}

/** Throws the first GraphQL error, if any; returns `data`. */
export function dataOf<T>(text: string): T | undefined {
  const json = JSON.parse(text) as { errors?: { message?: string }[]; data?: T };
  if (json.errors?.length) throw new Error(json.errors.map((e) => e.message ?? 'GraphQL error').join('; '));
  return json.data;
}

/** Your GitLab username. */
export async function whoAmI(gql: GraphQL): Promise<string> {
  const u = dataOf<{ currentUser?: { username?: string } | null }>(await gql('{ currentUser { username } }'))?.currentUser?.username;
  if (!u) throw new Error('not logged in to GitLab (no current user)');
  return u;
}
