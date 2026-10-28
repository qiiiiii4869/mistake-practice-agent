import {createWorkflowActor,allStages,type Stage} from './machine.ts';
import {reserveCall,recordUsage,type Budget} from './budget.ts';
import {WORKFLOW_VERSION,PROMPT_VERSION,type FrozenInput,type ExportProfile} from './types.ts';
import {assertCheckpointSafe,type Json,type Checkpoint,type CheckpointStore,type StageResult} from './checkpoint.ts';

export interface HandlerContext {
  input:FrozenInput;profile:ExportProfile;signal:AbortSignal;outputs:Readonly<Partial<Record<Stage,StageResult>>>;
  callModel:(callId:string,requestHash:string,maxTokens:number,perform:()=>Promise<{value:Json;usage:number|null}>)=>Promise<Json>;
}
export type StageHandler=(context:HandlerContext)=>Promise<StageResult>;
export interface RecoveryProof {ownerId:string;contentHash:string;exportHash:string;cloudConfirmed:boolean}
const modelStages=new Set<Stage>(['recognizing','aligning','extracting','verifyingFacts','clozing','validatingCloze','generatingExercises','solving','writingGuidance','validatingGuidance']);
const knownError=(e:unknown)=>{
  const code=e instanceof Error?e.message:'';
  return /^(workflow|model|account|session|credits|generation)_[a-z_]{1,80}$/.test(code)?code:'workflow_stage_failed';
};
const replayable=new Set<Stage>(['preflight','rendering','retrieving','merging','selectingTargets','assembling','aggregatingEvidence','validatingPdf']);

// One instance is retained by the desktop scheduler, independent of React pages.
// Concrete handlers, persistent storage, cloud leases and PDF QA are injected later.
export class WorkflowRunner {
  private abort:AbortController|null=null;private executing=false;
  private store:CheckpointStore;private handlers:Partial<Record<Stage,StageHandler>>;
  private authorized:()=>Promise<boolean>;private now:()=>number;
  constructor(store:CheckpointStore,handlers:Partial<Record<Stage,StageHandler>>,authorized:()=>Promise<boolean>,now:()=>number=Date.now){this.store=store;this.handlers=handlers;this.authorized=authorized;this.now=now;}
  create(input:FrozenInput,profile:ExportProfile,budget:Budget){
    if(profile.contentHash!==input.contentHash||input.workflowVersion!==WORKFLOW_VERSION||input.promptVersion!==PROMPT_VERSION)throw new Error('workflow_stale_input');
    if(budget.calls!==0||budget.tokens!==0||Object.keys(budget.pending).length||budget.deadline<=this.now()
      ||!Number.isSafeInteger(budget.maxCalls)||budget.maxCalls<1||budget.maxCalls>200||!Number.isSafeInteger(budget.maxTokens)||budget.maxTokens<1)throw new Error('workflow_invalid_budget');
    const cp:Checkpoint={schemaVersion:2,workflowVersion:WORKFLOW_VERSION,promptVersion:PROMPT_VERSION,runId:profile.runId,
      ownerId:input.ownerId,contentHash:input.contentHash,exportHash:profile.exportHash,mode:input.mode,revision:0,state:'preflight',
      completed:[],outputs:{},inFlight:null,budget:structuredClone(budget),calls:{},errorCode:null};
    return this.store.write(cp,null);
  }
  cancel(){this.abort?.abort();}
  async execute(input:FrozenInput,profile:ExportProfile,proof?:RecoveryProof):Promise<Checkpoint>{
    if(this.executing)throw new Error('workflow_busy');
    const release=this.store.acquire(input.ownerId,profile.runId);this.executing=true;this.abort=new AbortController();
    const signal=this.abort.signal;let cp=this.store.read(input.ownerId,profile.runId);
    try{
      if(!cp)throw new Error('workflow_checkpoint_missing');
      if(cp.schemaVersion!==2||cp.ownerId!==input.ownerId||cp.runId!==profile.runId||cp.contentHash!==input.contentHash||cp.exportHash!==profile.exportHash||profile.contentHash!==input.contentHash||cp.mode!==input.mode
        ||cp.workflowVersion!==WORKFLOW_VERSION||cp.promptVersion!==PROMPT_VERSION)throw new Error('workflow_stale_input');
      if(cp.state==='completed'||cp.state==='cancelled'||cp.state==='failed'||cp.state==='partial')return cp;
      if(cp.state!=='preflight'||cp.completed.length||cp.inFlight){
        if(!proof?.cloudConfirmed||proof.ownerId!==input.ownerId||proof.contentHash!==input.contentHash||proof.exportHash!==profile.exportHash)throw new Error('workflow_recovery_unconfirmed');
        if(cp.inFlight&&cp.inFlight!=='settling'&&!cp.outputs[cp.inFlight]&&!replayable.has(cp.inFlight))throw new Error('workflow_stage_outcome_unknown');
        if(Object.values(cp.calls).some(c=>c.status!=='succeeded'))throw new Error('workflow_call_outcome_unknown');
      }
      const actor=createWorkflowActor({ownerId:input.ownerId,contentHash:input.contentHash,exportHash:profile.exportHash,mode:input.mode}).start();
      actor.send({type:'START'});
      const advance=(stage:Stage,result:StageResult)=>{
        if(stage==='validatingPdf'){
          if(!result.pdf)throw new Error('workflow_pdf_unverified');
          actor.send({type:'PDF_VERIFIED',...result.pdf});
        }else if(stage==='settling'){
          if(!result.settlement?.confirmed)throw new Error('workflow_settlement_unconfirmed');
          actor.send({type:'SETTLED',contentHash:result.settlement.contentHash,exportHash:result.settlement.exportHash});
        }else actor.send({type:'STEP_DONE',stage});
        if(String(actor.getSnapshot().value)===stage)throw new Error('workflow_stage_not_verified');
      };
      try{
        for(const stage of cp.completed){
          if(String(actor.getSnapshot().value)!==stage||!cp.outputs[stage])throw new Error('workflow_checkpoint_invalid');
          advance(stage,cp.outputs[stage]!);
        }
        const save=()=>{cp=this.store.write(cp!,cp!.revision);};
        while(actor.getSnapshot().status!=='done'){
          const stage=actor.getSnapshot().value as Stage;
          if(!allStages.includes(stage))throw new Error('workflow_checkpoint_invalid');
          if(signal.aborted&&stage!=='settling'){actor.send({type:'CANCEL'});cp.state='cancelled';cp.errorCode='workflow_cancelled';save();break;}
          if(this.now()>=cp.budget.deadline){cp.state='recoverable';cp.errorCode='workflow_deadline_exceeded';save();break;}
          if(cp.inFlight===stage&&stage!=='settling'&&cp.outputs[stage]){
            advance(stage,cp.outputs[stage]!);cp.completed.push(stage);cp.inFlight=null;cp.state=String(actor.getSnapshot().value);save();continue;
          }
          const handler=this.handlers[stage];
          if(!handler){cp.state='recoverable';cp.errorCode='workflow_handler_missing';save();break;}
          cp.inFlight=stage;cp.state=stage;cp.errorCode=null;save();let modelActive=false;const pending=new Set<Promise<unknown>>();
          const invokeModel:HandlerContext['callModel']=async(callId,requestHash,maxTokens,perform)=>{
            if(!modelStages.has(stage))throw new Error('workflow_model_stage_forbidden');
            if(modelActive)throw new Error('workflow_model_busy');
            if(signal.aborted)throw new Error('workflow_cancelled');
            if(!/^[a-f0-9]{64}$/.test(requestHash)||!callId||callId.length>100)throw new Error('workflow_invalid_call');
            modelActive=true;
            try{
              const old=cp!.calls[callId];
              if(old){if(old.stage!==stage||old.requestHash!==requestHash)throw new Error('workflow_duplicate_call');if(old.status!=='succeeded')throw new Error('workflow_call_outcome_unknown');return structuredClone(old.value!);}
              if(!await this.authorized())throw new Error('workflow_authorization_required');
              if(signal.aborted)throw new Error('workflow_cancelled');
              cp!.budget=reserveCall(cp!.budget,callId,maxTokens,this.now());
              cp!.calls[callId]={stage,requestHash,status:'sent',usage:null};save();
              try{
                const result=await perform();assertCheckpointSafe(result.value);
                if(result.usage!==null&&Number.isSafeInteger(result.usage)&&result.usage>maxTokens){
                  cp!.budget.tokens+=result.usage-maxTokens;delete cp!.budget.pending[callId];
                  cp!.calls[callId]={stage,requestHash,status:'succeeded',usage:result.usage,value:result.value};save();throw new Error('workflow_usage_exceeded');
                }
                cp!.budget=recordUsage(cp!.budget,callId,result.usage);
                cp!.calls[callId]={stage,requestHash,status:'succeeded',usage:result.usage,value:result.value};save();
                if(signal.aborted)throw new Error('workflow_cancelled');
                if(!await this.authorized())throw new Error('workflow_authorization_required');
                return structuredClone(result.value);
              }catch(error){
                if(cp!.calls[callId].status==='sent'){
                  cp!.budget=recordUsage(cp!.budget,callId,null);cp!.calls[callId].status='unknown';save();
                }throw error;
              }
            }finally{modelActive=false;}
          };
          const callModel:HandlerContext['callModel']=(...args)=>{
            const task=invokeModel(...args);pending.add(task);void task.then(()=>pending.delete(task),()=>pending.delete(task));return task;
          };
          try{
            const result=await handler({input,profile,signal,outputs:structuredClone(cp.outputs),callModel});
            if(pending.size){await Promise.allSettled([...pending]);throw new Error('workflow_unawaited_call');}
            if(signal.aborted&&stage!=='settling')throw new Error('workflow_cancelled');
            assertCheckpointSafe(result);
            // Persist the actual result before progressing. No stage can select its successor.
            cp.outputs[stage]=structuredClone(result);save();advance(stage,result);
            cp.completed.push(stage);cp.inFlight=null;cp.state=String(actor.getSnapshot().value);save();
          }catch(error){
            if(pending.size)await Promise.allSettled([...pending]);
            const code=knownError(error);cp.errorCode=code;
            if(stage==='settling'){cp.state='pendingSettlement';}
            else if(signal.aborted){cp.state='cancelled';}
            else cp.state=/model_(quota_exhausted|auth_failed)|workflow_(checkpoint_secret|usage_exceeded)/.test(code)?'failed':'recoverable';
            save();break;
          }
        }
        return structuredClone(cp);
      }finally{actor.stop();}
    }finally{this.abort=null;this.executing=false;release();}
  }
}
