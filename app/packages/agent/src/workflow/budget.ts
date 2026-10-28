export interface Budget {maxCalls:number;maxTokens:number;deadline:number;calls:number;tokens:number;pending:Record<string,number>}
const integer=(n:number)=>Number.isSafeInteger(n)&&n>=0;
export function estimateCalls(pages:number,analysisGroups:number,candidateGroups:number):number{
  if(![pages,analysisGroups,candidateGroups].every(integer)||pages>30)throw new Error('workflow_invalid_budget');
  const total=3*pages+4*analysisGroups+4*candidateGroups+2+8;
  if(!Number.isSafeInteger(total)||total>200)throw new Error('workflow_call_budget_exceeded');
  return total;
}
export function reserveCall(b:Budget,id:string,maxTokens:number,now:number):Budget{
  if(![b.calls,b.tokens,b.maxCalls,b.maxTokens,b.deadline,now,maxTokens].every(integer)||!id||maxTokens<1||b.maxCalls>200)throw new Error('workflow_invalid_budget');
  if(Object.hasOwn(b.pending,id))throw new Error('workflow_duplicate_call');
  if(now>=b.deadline)throw new Error('workflow_deadline_exceeded');
  if(b.calls>=b.maxCalls||b.tokens+maxTokens>b.maxTokens)throw new Error('workflow_budget_exceeded');
  return {...b,calls:b.calls+1,tokens:b.tokens+maxTokens,pending:{...b.pending,[id]:maxTokens}};
}
export function recordUsage(b:Budget,id:string,actualTokens:number|null):Budget{
  if(!Object.hasOwn(b.pending,id))throw new Error('workflow_unknown_call');
  const reserved=b.pending[id],pending={...b.pending};delete pending[id];
  if(actualTokens!==null&&(!integer(actualTokens)||actualTokens>reserved))throw new Error('workflow_usage_exceeded');
  // Missing usage/timeouts retain the entire reservation; retries consume a new call.
  return {...b,tokens:b.tokens-reserved+(actualTokens??reserved),pending};
}
