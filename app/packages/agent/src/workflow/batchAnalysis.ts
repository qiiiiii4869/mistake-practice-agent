import type {FactCandidate,KnowledgeFact,SourceUnit,WorkflowRun,InvokeModel} from './types.ts';
import {factPassed,invalid,list,object,validateFacts,validateFactCheck,validationReason} from './validators.ts';

export const sourceData=(u:SourceUnit)=>({unitId:u.unitId,sourceNumbers:u.sourceNumbers,stem:u.stem,material:u.material,options:u.options});
export function planBatches(units:SourceUnit[],size:(units:SourceUnit[])=>number,limit:number,preferredLimit=limit,maxUnits=6):string[][]{
 if(!Number.isSafeInteger(maxUnits)||maxUnits<1||maxUnits>6)throw new Error('workflow_invalid_batch_plan');
 const result:string[][]=[];let group:SourceUnit[]=[];
 for(const unit of units){
  if(size([unit])>limit)throw new Error('workflow_batch_input_exceeded');
  if(group.length&&(group.length===maxUnits||size([...group,unit])>preferredLimit)){result.push(group.map(u=>u.unitId));group=[];}
  group.push(unit);
 }if(group.length)result.push(group.map(u=>u.unitId));return result;
}
export function remainingFits(run:WorkflowRun,planned:number):void{
 const retries=run.calls.filter(c=>c.attempt>1).length;
 if(run.calls.length+planned+Math.max(0,run.policy.maxNetworkRetries-retries)>run.policy.maxCalls)throw new Error('workflow_budget_estimate_exceeded');
}
function groupValues(raw:unknown,expected:string[]):Map<string,unknown>{
 const result=new Map<string,unknown>();
 for(const value of list(object(raw).groups,6,true)){const group=object(value),id=group.unitId;
  if(typeof id!=='string'||!expected.includes(id)||result.has(id))return invalid();result.set(id,value);
 }return result;
}
function validFailure(error:unknown){return error instanceof Error&&error.message==='workflow_invalid_output';}
export async function extractBatch(run:WorkflowRun,unitIds:string[],invoke:InvokeModel,subject:string):Promise<void>{
 const units=unitIds.map(id=>run.units.find(u=>u.unitId===id)!);
 let returned:Map<string,unknown>;
 try{returned=groupValues(await invoke('extract',{subject,contentId:`extract-batch-${unitIds.join('-')}`,groups:units.map(u=>({unitId:u.unitId,original:sourceData(u)}))}),unitIds);}
 catch(error){if(!validFailure(error))throw error;returned=new Map();}
 for(const u of units){
  try{const facts=validateFacts(returned.get(u.unitId));
   if(facts.length)run.draftFacts[u.unitId]=facts;
   else run.skipped.push({sourceNumbers:[...u.sourceNumbers],reason:'text_evidence_insufficient'});
  }catch(error){if(!validFailure(error))throw error;run.skipped.push({sourceNumbers:[...u.sourceNumbers],reason:'fact_extraction_failed'});}
 }
}
interface Pending {unit:SourceUnit;facts:{fact:FactCandidate;slot:number}[]}
export function verificationData(run:WorkflowRun,ids:string[],pending?:Pending[]){
 return ids.map(id=>{const u=run.units.find(u=>u.unitId===id)!;return {unitId:id,original:sourceData(u),facts:pending?.find(p=>p.unit.unitId===id)?.facts.map(p=>p.fact)??run.draftFacts[id],evidence:run.unitEvidence[id]??[]};});
}
export async function verifyBatch(run:WorkflowRun,unitIds:string[],invoke:InvokeModel,subject:string,save:()=>Promise<void>):Promise<void>{
 let pending:Pending[]=unitIds.map(id=>({unit:run.units.find(u=>u.unitId===id)!,facts:run.draftFacts[id].map((fact,i)=>({fact,slot:i+1}))}));
 const scope=`verify-batch-${unitIds.join('-')}`;
 const report=(p:Pending,slot:number,attempt:number,reason:WorkflowRun['validationAttempts'][number]['reason'])=>run.validationAttempts.push({factId:`${p.unit.unitId}-fact-${slot}`,sourceNumbers:[...p.unit.sourceNumbers],stage:'verifyFact',attempt,reason});
 for(let attempt=1;attempt<=2&&pending.length;attempt++){
  const ids=pending.map(p=>p.unit.unitId);let returned:Map<string,unknown>;
  try{returned=groupValues(await invoke('verifyFact',{subject,contentId:scope,groups:verificationData(run,ids,pending)}),ids);}
  catch(error){if(!validFailure(error))throw error;returned=new Map();}
  const rejected:Pending[]=[],repairGroups=[];
  for(const p of pending){
   let checks:KnowledgeFact['factCheck'][];
   try{checks=list(object(returned.get(p.unit.unitId)).checks,3).map(validateFactCheck);if(checks.length!==p.facts.length)return invalid();}
   catch(error){if(!validFailure(error))throw error;checks=p.facts.map(()=>({accurate:false,supported:false,inScope:false}));p.facts.forEach(f=>report(p,f.slot,attempt,'invalid_structure'));}
   const failed:Pending['facts']=[],failedChecks:KnowledgeFact['factCheck'][]=[];
   for(const [i,entry] of p.facts.entries()){
    const evidence=run.unitEvidence[p.unit.unitId]??[];
    const fact:KnowledgeFact={...entry.fact,factId:`${p.unit.unitId}-fact-${entry.slot}`,sourceNumbers:[...p.unit.sourceNumbers],unitIds:[p.unit.unitId],evidenceRefs:structuredClone(evidence),sourceMode:evidence.length?'library':'paper',factCheck:checks[i]};
    if(factPassed(fact)){if(!run.facts.some(f=>f.factId===fact.factId))run.facts.push(fact);}
    else{failed.push(entry);failedChecks.push(checks[i]);
     if(!checks[i].accurate)report(p,entry.slot,attempt,'fact_inaccurate');if(!checks[i].supported)report(p,entry.slot,attempt,'fact_unsupported');if(!checks[i].inScope)report(p,entry.slot,attempt,'fact_context_incomplete');}
   }
   if(failed.length){rejected.push({unit:p.unit,facts:failed});repairGroups.push({unitId:p.unit.unitId,original:sourceData(p.unit),repair:{facts:failed.map(f=>f.fact),checks:failedChecks}});}
  }
  pending=rejected;await save();if(!pending.length||attempt===2)break;
  let repairs:Map<string,unknown>;
  try{repairs=groupValues(await invoke('extract',{subject,contentId:`repair-${scope}`,groups:repairGroups}),pending.map(p=>p.unit.unitId));}
  catch(error){if(!validFailure(error))throw error;break;}
  const repaired:Pending[]=[];
  for(const p of pending){try{const values=validateFacts(repairs.get(p.unit.unitId));if(values.length!==p.facts.length)return invalid();
    const next={unit:p.unit,facts:p.facts.map((f,i)=>({...f,fact:values[i]}))};for(const f of next.facts)run.draftFacts[p.unit.unitId][f.slot-1]=f.fact;repaired.push(next);
   }catch(error){if(!validFailure(error))throw error;run.skipped.push({sourceNumbers:[...p.unit.sourceNumbers],reason:'fact_check_failed'});p.facts.forEach(f=>report(p,f.slot,2,validationReason(error)));}}
  pending=repaired;
 }
 for(const p of pending)if(p.facts.length)run.skipped.push({sourceNumbers:[...p.unit.sourceNumbers],reason:'fact_check_failed'});
}
