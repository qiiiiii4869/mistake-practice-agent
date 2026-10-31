import type {CallRecord,FrozenInput,WorkflowRun} from './types.ts';

export const ITEM_ATTEMPT_LIMIT=3;
export const itemRetryEnabled=(input:FrozenInput|undefined)=>input?.itemFailurePolicy==='retry-three-then-skip-v1';
export const itemStage=(stage:string)=>stage==='cloze'||stage==='exercise';
export const retryableItemOutput=(error:unknown)=>['invalid_model_output','workflow_invalid_output'].includes(typeof error==='string'?error:error instanceof Error?error.message:'');

// The response is definitively unusable, while its billing/usage can remain
// unknown. Such calls are never marked completed or removed from the budget.
export function knownItemOutputFailure(input:FrozenInput|undefined,run:WorkflowRun,call:CallRecord):boolean{
 return itemRetryEnabled(input)&&itemStage(call.stage)&&call.status!=='pending'
  &&['invalid_model_output','workflow_invalid_output'].includes(call.errorCode??'')
  &&run.facts.some(f=>f.factId===call.scopeId)
  &&(run.checkpoints.includes(`item:${call.scopeId}`)||run.frame?.id===`item:${call.scopeId}`);
}
export function unresolvedCalls(input:FrozenInput|undefined,run:WorkflowRun):boolean{
 return run.calls.some((c,i)=>c.status!=='completed'&&!knownItemOutputFailure(input,run,c)
  &&!(c.attempt===1&&run.calls[i+1]?.attempt===2&&(run.calls[i+1].status==='completed'||knownItemOutputFailure(input,run,run.calls[i+1]))&&run.calls[i+1].requestHash===c.requestHash&&run.calls[i+1].scopeId===c.scopeId));
}
