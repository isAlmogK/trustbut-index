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

const isObj = (x: unknown): x is Record<string, any> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isStr = (x: unknown): x is string => typeof x === 'string';
const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const exitCode = (x: unknown) => x === null || finite(x);

function isRecipe(x: unknown): x is Recipe | null {
  if (x === null) return true;
  if (!isObj(x) || !('node' in x) || !('python' in x)) return false;
  const { node, python } = x;
  const nodeOk = node === null || (isObj(node) && isStr(node.version) && isStr(node.pm) && isStr(node.install));
  const pyOk = python === null || (isObj(python) && isStr(python.version) && Array.isArray(python.install) && python.install.every(isStr));
  return nodeOk && pyOk;
}

export function isRunRecord(x: unknown): x is RunRecord {
  if (!isObj(x)) return false;
  const r = x;
  return (
    isStr(r.id) &&
    STATUSES.includes(r.status) &&
    STAGES.includes(r.stage) &&
    isRecipe(r.recipe) &&
    isObj(r.durations) && finite(r.durations.installMs) && finite(r.durations.verifyMs) &&
    isObj(r.exitCodes) && exitCode(r.exitCodes.install) && exitCode(r.exitCodes.verify) &&
    (r.installRetries === undefined || (Number.isInteger(r.installRetries) && (r.installRetries as number) >= 0)) &&
    (r.installTail === undefined || isStr(r.installTail)) &&
    isStr(r.runnerImage) &&
    isStr(r.trustbutVersion)
  );
}

export function looksLikeReceipt(x: unknown): x is Receipt {
  if (!x || typeof x !== 'object') return false;
  const r = x as Record<string, any>;
  return typeof r.specVersion === 'string' && Array.isArray(r.findings) && typeof r.verdict === 'string';
}
