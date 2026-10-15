import type { GitHubApi } from '../github/client.js';
import { PY_TEST_FILES, ciRunsTests, detectJsTests, detectPyTests, type RepoFacts, type RepoMeta } from './qualify.js';

const DAY = 86_400_000;
const MAX_COMMITS = 300;
/** The contributor rule is "at least 10"; counting further never changes the result. */
const ENOUGH_AUTHORS = 10;
const MAX_WORKFLOWS = 10;

const HISTORY = 'pageInfo { hasNextPage endCursor } nodes { author { email user { login } } }';
const blob = (alias: string, path: string) => `${alias}: object(expression: "HEAD:${path}") { ... on Blob { text } }`;

const FACTS = `query($owner: String!, $name: String!, $since: GitTimestamp!) {
  repository(owner: $owner, name: $name) {
    workflows: object(expression: "HEAD:.github/workflows") { ... on Tree { entries { path type object { ... on Blob { text } } } } }
    ${blob('packageJson', 'package.json')}
    ${PY_TEST_FILES.map((f, i) => blob(`py${i}`, f)).join('\n    ')}
    defaultBranchRef { target { ... on Commit { history(first: 100, since: $since) { ${HISTORY} } } } }
  }
}`;

const MORE_HISTORY = `query($owner: String!, $name: String!, $since: GitTimestamp!, $after: String!) {
  repository(owner: $owner, name: $name) {
    defaultBranchRef { target { ... on Commit { history(first: 100, since: $since, after: $after) { ${HISTORY} } } } }
  }
}`;

type Blob = { text?: string | null } | null | undefined;
interface History {
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: { author: { email: string | null; user: { login: string } | null } | null }[];
}
interface Branch {
  defaultBranchRef: { target: { history?: History } | null } | null;
}
type FactsRepo = Branch & {
  workflows: { entries?: { path: string; type: string; object: Blob }[] } | null;
  packageJson: Blob;
  [alias: `py${number}`]: Blob;
};

const textOf = (b: Blob): string | null => (typeof b?.text === 'string' ? b.text : null);

/** Repo facts for the repo rules, from one GraphQL query (plus history pages when fewer than 10 authors are seen). */
export async function loadFacts(gh: GitHubApi, meta: RepoMeta, now: Date): Promise<RepoFacts | null> {
  const [owner, name] = meta.fullName.split('/') as [string, string];
  // Whole UTC days, so a rerun on the same day builds identical queries and hits the cache.
  const since = `${new Date(now.getTime() - 365 * DAY).toISOString().slice(0, 10)}T00:00:00Z`;
  const r = (await gh.graphql<{ repository: FactsRepo | null }>(FACTS, { owner, name, since })).repository;
  if (!r) return null;

  const workflowTexts = (r.workflows?.entries ?? [])
    .filter((e) => e.type === 'blob' && /\.ya?ml$/.test(e.path))
    .slice(0, MAX_WORKFLOWS)
    .map((e) => textOf(e.object))
    .filter((t): t is string => t !== null);

  let hasJsTests = false;
  const pkg = textOf(r.packageJson);
  if (pkg) {
    try {
      hasJsTests = detectJsTests(JSON.parse(pkg));
    } catch {
      hasJsTests = false;
    }
  }
  const hasPyTests = !hasJsTests && detectPyTests(Object.fromEntries(PY_TEST_FILES.map((f, i) => [f, textOf(r[`py${i}`])])));

  const authors = new Set<string>();
  let history = r.defaultBranchRef?.target?.history;
  let seen = 0;
  while (history) {
    for (const n of history.nodes) {
      const id = n.author?.user?.login ?? n.author?.email ?? '';
      if (id) authors.add(id);
    }
    seen += history.nodes.length;
    if (authors.size >= ENOUGH_AUTHORS || seen >= MAX_COMMITS || !history.pageInfo.hasNextPage) break;
    const more = await gh.graphql<{ repository: Branch | null }>(MORE_HISTORY, { owner, name, since, after: history.pageInfo.endCursor });
    history = more.repository?.defaultBranchRef?.target?.history;
  }

  return { ...meta, contributorsLastYear: authors.size, ciRunsTests: ciRunsTests(workflowTexts), hasJsTests, hasPyTests };
}
