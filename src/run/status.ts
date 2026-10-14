import type { FailureStage, Receipt, Recipe, RunRecord, RunStatus } from '../types.js';

export interface Outcome {
  fetchOk: boolean;
  recipe: Recipe | null;
  installExit: number | null;
  verifyExit: number | null;
  receipt: Receipt | null;
}

export const TIMEOUT_EXIT = 124;

export function classify(o: Outcome): { status: RunStatus; stage: FailureStage } {
  if (!o.fetchOk) return { status: 'setup-failed', stage: 'fetch' };
  if (!o.recipe) return { status: 'no-runner', stage: 'recipe' };
  if (o.installExit === TIMEOUT_EXIT) return { status: 'timeout', stage: 'install' };
  if (o.installExit !== 0) return { status: 'setup-failed', stage: 'install' };
  if (o.verifyExit === TIMEOUT_EXIT) return { status: 'timeout', stage: 'verify' };
  if (!o.receipt) return { status: 'trustbut-error', stage: 'verify' };
  if (o.receipt.findings.some((f) => f.id === 'no-runner')) return { status: 'no-runner', stage: 'verify' };
  if ((o.receipt.tests?.passed ?? 0) >= 1) return { status: 'ran', stage: null };
  return { status: 'setup-failed', stage: 'no-passing-tests' };
}

const STATUSES: RunStatus[] = ['ran', 'no-runner', 'setup-failed', 'timeout', 'trustbut-error'];
const STAGES: FailureStage[] = ['fetch', 'recipe', 'install', 'verify', 'no-passing-tests', null];

export function isRunRecord(x: unknown): x is RunRecord {
  if (!x || typeof x !== 'object') return false;
  const r = x as Record<string, any>;
  return (
    typeof r.id === 'string' &&
    STATUSES.includes(r.status) &&
    STAGES.includes(r.stage) &&
    typeof r.durations?.installMs === 'number' &&
    typeof r.durations?.verifyMs === 'number' &&
    typeof r.runnerImage === 'string' &&
    typeof r.trustbutVersion === 'string'
  );
}

export function looksLikeReceipt(x: unknown): x is Receipt {
  if (!x || typeof x !== 'object') return false;
  const r = x as Record<string, any>;
  return typeof r.specVersion === 'string' && Array.isArray(r.findings) && typeof r.verdict === 'string';
}
