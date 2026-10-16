export type Group = 'agent' | 'human';
export type AgentId = 'copilot' | 'codex' | 'claude-code' | 'cursor' | 'devin' | 'jules';
export const AGENT_IDS: readonly AgentId[] = ['copilot', 'codex', 'claude-code', 'cursor', 'devin', 'jules'];

/** One line of manifests/<name>.jsonl. */
export interface ManifestEntry {
  id: string; // "owner/name#123"
  repo: string; // "owner/name"
  pr: number;
  group: Group;
  agent: AgentId | null; // null for human PRs
  model: string; // "unknown" unless a marker names it
  attribution: { evidence: string[] };
  baseRef: string;
  baseSha: string;
  headSha: string;
  mergedAt: string;
  selectedAt: string;
  repoStars: number;
  repoLanguage: string | null;
}

/** A pull request as the collector sees it. */
export interface PrDetail {
  repo: string;
  number: number;
  title: string;
  author: string;
  authorType: string; // "User" | "Bot" | …
  mergedBy: string | null;
  mergedAt: string | null;
  baseRef: string;
  baseSha: string;
  headSha: string;
  branch: string;
  body: string;
  files: string[];
  commitMessages: string[];
}

export interface NodeRecipe {
  version: string;
  pm: 'npm' | 'pnpm' | 'yarn' | 'yarn-berry' | 'bun';
  install: string;
}
export interface PythonRecipe {
  version: string;
  install: string[];
}
export interface Recipe {
  node: NodeRecipe | null;
  python: PythonRecipe | null;
}

export type RunStatus = 'ran' | 'no-runner' | 'setup-failed' | 'timeout' | 'trustbut-error';
export type FailureStage = 'fetch' | 'recipe' | 'install' | 'verify' | 'no-passing-tests' | null;

/** results/<date>/<fileId>.run.json */
export interface RunRecord {
  id: string; // fileId
  status: RunStatus;
  stage: FailureStage;
  recipe: Recipe | null;
  durations: { installMs: number; verifyMs: number };
  exitCodes: { install: number | null; verify: number | null };
  /** How many times a failed install command was run again (absent in runs before 2026-10-16). */
  installRetries?: number;
  /** The end of the failing install command's output (only when install failed). */
  installTail?: string;
  runnerImage: string;
  trustbutVersion: string;
  note?: string;
}

/** The subset of agent receipt v1 this study reads. */
export interface Finding {
  id: string;
  severity: 'fail' | 'warn' | 'info';
  title: string;
  file?: string;
  line?: number;
  detail?: string;
}
export interface Proof {
  file: string;
  name: string;
  before: string;
  after: string;
  verdict: 'proves-change' | 'does-not-constrain' | 'failing' | 'skipped';
}
export interface Receipt {
  specVersion: string;
  producer: { name: string; version: string };
  subject: { base: string; head: string };
  verdict: 'pass' | 'warn' | 'fail';
  findings: Finding[];
  tests?: { passed: number; failed: number; errored: number; skipped: number; scope: 'full' | 'changed' };
  proofs?: Proof[];
}

export type Family = 'proof-gap' | 'test-weakening' | 'escapes' | 'untested-change' | 'red-at-head';
export type Label = 'real' | 'true-but-benign' | 'false' | 'unclear';
export const LABELS: readonly Label[] = ['real', 'true-but-benign', 'false', 'unclear'];

/** A file-name-safe id for a PR: "owner__name__123". */
export function fileId(e: { repo: string; pr: number }): string {
  return `${e.repo.replace('/', '__')}__${e.pr}`;
}
