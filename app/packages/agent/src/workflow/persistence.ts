import {assertFrozen,canonical,digest} from './input.ts';
import {validateUnits,validateFacts,validateEvidence,validateFactCheck,validateCloze,validateExercise,factPassed,blindFillPassed,exerciseSolvePassed} from './validators.ts';
import {modelRequest} from './prompts.ts';
import {answerFormat} from './answerAliases.ts';
import {selectTargets,assignStudents} from './assignment.ts';
import {teachingEvidence} from './teachingEvidence.ts';
import {templateClassTeachingReport,validateClassTeachingReport} from './teachingAdvice.ts';
import {createWorkflowActor,actorState} from './machine.ts';
import {sameStatistics} from './statisticsIntegrity.ts';
import {MAX_WORKFLOW_CALLS} from './budget.ts';
import {minimumFacts,minimumCloze,minimumExercise,usableFact,validateMinimumReport} from './minimumChecks.ts';
import type {WorkflowStore,WorkflowRun,FrozenInput,ModelResponse,AnalysisCache,WorkflowTaskContext,ExportProfile} from './types.ts';

type Invoke=<T>(command:string,args?:Record<string,unknown>)=>Promise<T>;
export interface StoredTask {input:FrozenInput;run:WorkflowRun|null;revision:number;context:WorkflowTaskContext;createdAt:number;updatedAt:number}
export interface TaskSummary {runId:string;contentHash:string;mode:'dictation'|'exercise';examName:string;state:string|null;updatedAt:number;callCount:number;unknownCalls:number;workspaceRevision?:number}
export interface SavedExport {profile:ExportProfile;state:'planned'|'exporting'|'failed'|'cancelled'|'verified';folder?:string;staging?:string;manifest?:Record<string,unknown>;qa?:Record<string,unknown>}
function invalid():never{throw new Error('workflow_storage_corrupt');}
const same=async(a:unknown,b:unknown)=>await digest(a)===await digest(b);
export async function validateStoredTask(task:StoredTask,ownerId:string,runId:string):Promise<StoredTask>{
  task=structuredClone(task);
  await assertFrozen(task.input);
  if(task.input.ownerId!==ownerId||!Number.isSafeInteger(task.revision)||task.revision<0)invalid();
  const r=task.run;if(!r)return structuredClone(task);
  const minimum=task.input.validationLevel==='minimum';
  if(r.runId!==runId||r.contentHash!==task.input.contentHash||r.mode!==task.input.mode||r.workflowVersion!==task.input.workflowVersion||r.promptVersion!==task.input.promptVersion
    ||!['mock','real'].includes(r.executionMode)||!Array.isArray(r.calls)||!Number.isSafeInteger(r.policy.maxCalls)||r.policy.maxCalls<1||r.policy.maxCalls>MAX_WORKFLOW_CALLS||r.calls.length>r.policy.maxCalls||r.calls.length>MAX_WORKFLOW_CALLS)invalid();
  if(r.machineSnapshot){const actor=createWorkflowActor(r.mode,r.machineSnapshot);try{actor.start();if(actorState(actor)!==r.state||actor.getSnapshot().context.mode!==r.mode)invalid();}finally{actor.stop();}}
  if(!Array.isArray(r.checkpoints)||new Set(r.checkpoints).size!==r.checkpoints.length||r.checkpoints.length>500)invalid();
  if(r.frame&&(!Number.isSafeInteger(r.frame.callStart)||r.frame.callStart<0||r.frame.callStart>r.calls.length||r.checkpoints.includes(r.frame.id)))invalid();
  if(r.frame){const keys=['units','facts','items','draftFacts','unitEvidence','targets','assignments','evidence','advice','teacherReport','skipped','validationAttempts','recognitionChecks'];
    if(Object.keys(r.frame.data).length!==keys.length||Object.keys(r.frame.data).some(k=>!keys.includes(k)))invalid();
    await validateStoredTask({...task,run:{...r,...r.frame.data,frame:undefined}},ownerId,runId);}
  const ids=new Set();for(const c of r.calls){if(ids.has(c.callId)||!['pending','completed','unknown'].includes(c.status)||!Number.isSafeInteger(c.reservedTokens)||c.reservedTokens<0||(c.usage!==null&&(!Number.isSafeInteger(c.usage)||c.usage<0)))invalid();ids.add(c.callId);}
  validateUnits(r.units,task.input);for(const facts of Object.values(r.draftFacts)){if((minimum?minimumFacts:validateFacts)({facts}).length!==facts.length)invalid();}
  for(const batches of [r.analysisBatches,r.verificationBatches])if(batches!==undefined){
    if(!Array.isArray(batches)||batches.length>80)invalid();const used=new Set<string>();
    for(const group of batches){if(!Array.isArray(group)||!group.length||group.length>6)invalid();
      for(const id of group){if(typeof id!=='string'||used.has(id)||!r.units.some(u=>u.unitId===id&&u.availability==='usable'))invalid();used.add(id);}
    }
  }
  for(const refs of Object.values(r.unitEvidence))validateEvidence(refs);
  const factIds=new Set();for(const f of r.facts){if((minimum?minimumFacts:validateFacts)({facts:[f]}).length!==1)invalid();validateFactCheck(f.factCheck);validateEvidence(f.evidenceRefs);if(factIds.has(f.factId)||!usableFact(f,minimum)||minimum&&(f.reviewStatus!=='unchecked'||Object.values(f.factCheck).some(Boolean)))invalid();factIds.add(f.factId);}
  const itemIds=new Set();for(const i of r.items){const f=r.facts.find(f=>f.factId===i.factId);if(!f||itemIds.has(i.itemId)||i.mode!==r.mode)invalid();itemIds.add(i.itemId);
    if(minimum){if(i.status!=='draft'||i.checks.independent||i.checks.scope)invalid();if(i.mode==='dictation')minimumCloze(i,f,i.itemId,i.attempts);else minimumExercise(i,f,i.itemId,i.attempts);}
    else {if(i.status==='draft')invalid();if(i.mode==='dictation')validateCloze(i,f,i.itemId,i.attempts);else validateExercise(i,f,r.units,i.itemId,i.attempts);}
    if(i.status==='passed'&&!Object.values(i.checks).every(v=>v===true))invalid();}
  if(r.checkpoints.includes('targets')&&!await same(r.targets,selectTargets(task.input,r.facts)))invalid();
  if(r.checkpoints.includes('assignments')&&!await same(r.assignments,assignStudents(task.input,r.targets,r.items,r.facts)))invalid();
  if(r.checkpoints.includes('evidence')){
    const computed=teachingEvidence(task.input,r.facts);
    if(!sameStatistics(r.evidence,computed))invalid();
    // Return the values recomputed from the frozen scores, without editing the database.
    r.evidence=computed;
  }
  if(r.teacherReport&&minimum){validateMinimumReport(r.teacherReport);if(!await same(r.advice,r.teacherReport.priorities))invalid();}
  if(r.teacherReport&&!minimum){const report=r.teacherReport,checked=report.generatedBy==='template'?templateClassTeachingReport(r.evidence):validateClassTeachingReport({overview:report.overview,followUp:report.followUp,groupActions:report.groupActions,
    advice:report.priorities.map(a=>({evidenceIds:a.evidenceIds,focus:a.focus,classroomAction:a.classroomAction,followUp:a.followUp}))},r.evidence);if(!await same(report,checked)||!await same(r.advice,report.priorities))invalid();}
  return structuredClone(task);
}

// The native command derives the database directory from the authenticated
// account. Desktop callers cannot supply a filesystem path.
export class SqliteWorkflowStore implements WorkflowStore {
  readonly durable=true;
  private versions=new Map<string,number>();
  private exports=new Map<string,number>();
  private active:{runId:string;leaseId:string;timer:ReturnType<typeof setInterval>;lost:boolean}|null=null;
  private invoke:Invoke;readonly ownerId:string;
  constructor(invoke:Invoke,ownerId:string){this.invoke=invoke;this.ownerId=ownerId;}
  private owned(owner:string){if(owner!==this.ownerId)throw new Error('workflow_owner_mismatch');}
  private async request<T>(operation:string,payload:Record<string,unknown>):Promise<T>{
    try{return await this.invoke<T>('workflow_store',{ownerId:this.ownerId,operation,payload});}
    catch(e){throw new Error(typeof e==='string'?e:e instanceof Error?e.message:'workflow_storage_failed');}
  }
  async list():Promise<TaskSummary[]>{return this.request('list',{});}
  async task(runId:string):Promise<StoredTask|null>{
    const t=await this.request<StoredTask|null>('load',{runId});if(!t)return null;
    const checked=await validateStoredTask(t,this.ownerId,runId);this.versions.set(runId,t.revision);
    const run=checked.run;
    if(run)for(const item of run.items.filter(i=>i.status==='passed')){
      const fact=run.facts.find(f=>f.factId===item.factId)!;let stage:'blindFill'|'solve',data:Record<string,unknown>;
      if(item.mode==='dictation'){stage='blindFill';data={parts:item.parts.map(p=>p.type==='text'?{type:p.type,text:p.text}:{type:p.type,blankId:p.blankId}),
        sentence:item.parts.map(p=>p.type==='text'?p.text:`【填空${p.blankId}】`).join(''),context:item.context??'',
        answerFormats:item.parts.flatMap(p=>p.type==='blank'?[{blankId:p.blankId,kind:answerFormat(p.answer)}]:[]),contentId:fact.factId};}
      else{stage='solve';data={question:{type:item.type,stem:item.stem,options:item.options,material:item.material},target:{knowledgePoint:fact.knowledgePoint,conditions:fact.conditions},
        originals:run.units.filter(u=>fact.unitIds.includes(u.unitId)).map(u=>({stem:u.stem,material:u.material,options:u.options})),contentId:fact.factId};}
      const requestHash=await digest(modelRequest(stage,{...data,subject:checked.input.workspace.exam.subjectName})),call=run.calls.find(c=>c.stage===stage&&c.requestHash===requestHash&&c.status==='completed');
      if(!call)invalid();const receipt=await this.loadResponse(this.ownerId,runId,call.callId);if(!receipt)invalid();
      if(item.mode==='dictation'?!blindFillPassed(receipt.value,item):!exerciseSolvePassed(receipt.value,item))invalid();
    }
    return checked;
  }
  async load(owner:string,runId:string):Promise<WorkflowRun|null>{this.owned(owner);return (await this.task(runId))?.run??null;}
  async beginRun(input:FrozenInput,runId:string,context:WorkflowTaskContext,onLeaseLost:()=>void):Promise<void>{
    this.owned(input.ownerId);if(this.active)throw new Error('workflow_busy');const leaseId=crypto.randomUUID();
    const {contentHash:_hash,...body}=input;
    const result=await this.request<{revision:number}>('begin',{runId,input,canonicalInput:canonical(body),context,leaseId,expectedRevision:this.versions.get(runId)??0});
    this.versions.set(runId,result.revision);
    let renewing=false;const timer=setInterval(()=>{if(renewing||!this.active)return;renewing=true;
      void this.request('renew',{runId,leaseId}).catch(()=>{if(this.active?.leaseId===leaseId){clearInterval(timer);this.active.lost=true;onLeaseLost();}}).finally(()=>renewing=false);},10000);
    this.active={runId,leaseId,timer,lost:false};
  }
  async endRun(owner:string,runId:string):Promise<void>{this.owned(owner);const active=this.active;if(!active||active.runId!==runId)return;
    clearInterval(active.timer);this.active=null;await this.request('end',{runId,leaseId:active.leaseId});}
  private lease(runId:string):string{if(!this.active||this.active.lost||this.active.runId!==runId)throw new Error('workflow_lease_lost');return this.active.leaseId;}
  private async write(owner:string,run:WorkflowRun,receipt?:{callId:string;response:ModelResponse}){
    this.owned(owner);const value=await this.request<{revision:number}>('save',{runId:run.runId,run,leaseId:this.lease(run.runId),expectedRevision:this.versions.get(run.runId)??0,...(receipt?{receipt}:{})});
    this.versions.set(run.runId,value.revision);
  }
  async save(owner:string,run:WorkflowRun):Promise<void>{await this.write(owner,run);}
  async completeCall(owner:string,run:WorkflowRun,callId:string,response:ModelResponse):Promise<void>{await this.write(owner,run,{callId,response});}
  async loadResponse(owner:string,runId:string,callId:string):Promise<ModelResponse|null>{this.owned(owner);return this.request('load_response',{runId,callId});}
  async loadAnalysis(owner:string,cacheKey:string):Promise<AnalysisCache|null>{this.owned(owner);return this.request('load_analysis',{cacheKey});}
  async saveAnalysis(owner:string,cacheKey:string,value:AnalysisCache):Promise<void>{this.owned(owner);if(!this.active)throw new Error('workflow_lease_lost');await this.request('save_analysis',{runId:this.active.runId,cacheKey,value,leaseId:this.lease(this.active.runId)});}
  async listExports(runId:string):Promise<SavedExport[]>{const rows=await this.request<{data:SavedExport;revision:number}[]>('list_exports',{runId});
    const task=await this.task(runId);if(!task)return [];
    for(const r of rows){const {exportId,exportHash,...body}=r.data.profile;
      if(r.data.profile.runId!==runId||await digest({contentHash:task.input.contentHash,...body})!==exportHash)throw new Error('workflow_stale_export');
      this.exports.set(exportId,r.revision);}
    return rows.map(r=>structuredClone(r.data));}
  async saveExport(runId:string,value:SavedExport):Promise<void>{
    const {exportId:_id,exportHash,...body}=value.profile;const task=await this.task(runId);if(!task?.run)throw new Error('workflow_run_not_found');
    if(await digest({contentHash:task.input.contentHash,...body})!==exportHash)throw new Error('workflow_stale_export');
    const previous=(await this.listExports(runId)).find(e=>e.profile.exportId===value.profile.exportId);
    if(previous?.state==='verified'){
      if(value.state!=='verified'||!await same(previous.profile,value.profile)||!await same(previous.manifest,value.manifest)||previous.folder!==value.folder)throw new Error('workflow_export_conflict');
      return;
    }
    const response=await this.request<{revision:number}>('save_export',{runId,value,expectedRevision:this.exports.get(value.profile.exportId)??0});
    this.exports.set(value.profile.exportId,response.revision);
  }
}
