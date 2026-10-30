import type { BudgetPolicy, CallRecord, GenerationMode, ModelStage } from './types.ts';

export function estimateBudget(mode: GenerationMode, pages: number, units: number, batched=false): BudgetPolicy {
  if (!['dictation','exercise'].includes(mode) || ![pages,units].every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error('workflow_invalid_budget');
  const planned = 3 * pages + 4 * (batched?Math.ceil(units/6):units) + 4 * (3 * units) + 2 + 8;
  if (planned > 200) throw new Error('workflow_budget_estimate_exceeded');
  // Batched tasks retain a 200-call authorization ceiling, with staged checks
  // for text-length splits and actual selected facts. Never truncate targets.
  return { maxCalls:batched?200:planned, maxTokens: 2_000_000, maxOutputTokens: 16384, maxInputBytes: 32000,
    maxRunMs: 45 * 60_000, requestTimeoutMs: 120_000, maxNetworkRetries: 8 };
}
export function reserveCall(policy: BudgetPolicy, calls: CallRecord[], stage: ModelStage, requestHash: string,
  requestBytes: number, now: number, startedAt: number, attempt: number, scopeId = 'batch',imageCount=stage==='recognize'?1:0): CallRecord {
  if (now - startedAt >= policy.maxRunMs) throw new Error('workflow_deadline');
  if (calls.length >= policy.maxCalls || requestBytes > policy.maxInputBytes) throw new Error('workflow_budget_exceeded');
  if (attempt === 1 && calls.filter(c => c.stage === stage && c.scopeId === scopeId && c.attempt === 1).length >= (stage==='recognize'?3:2))
    throw new Error('workflow_stage_budget_exceeded');
  // UTF-8 bytes provide a conservative input reservation without a provider tokenizer.
  const reservedTokens = requestBytes + policy.maxOutputTokens + imageCount*32768;
  const spent = calls.reduce((n,c) => n + (c.usage ?? c.reservedTokens), 0);
  if (spent + reservedTokens > policy.maxTokens) throw new Error('workflow_budget_exceeded');
  return { callId: crypto.randomUUID(), stage, scopeId, requestHash, attempt, status: 'pending', reservedTokens, usage: null, startedAt: now };
}
export function recordUsage(call: CallRecord, totalTokens: unknown, now: number): void {
  if (totalTokens !== undefined && (!Number.isSafeInteger(totalTokens) || Number(totalTokens) < 0)) throw new Error('workflow_invalid_usage');
  call.status = 'completed'; call.usage = totalTokens === undefined ? null : Number(totalTokens); call.finishedAt = now;
}
