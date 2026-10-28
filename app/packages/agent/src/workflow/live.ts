import { analyze } from '../../../core/src/index.ts';
import { MemoryWorkflowStore } from './store.ts';
import {workflowAudit} from './diagnostics.ts';
import {recognizeWorkflowUnits} from './recognition.ts';
export {recognizeWorkflowUnits} from './recognition.ts';
import type { ModelResponse, WorkflowPorts, WorkflowState } from './types.ts';

export interface CloudModelStatus { configured:boolean;model:string;modelConfigVersion:string|null;deliveryEnabled:boolean }
export type NativeInvoke = <T>(command:string,args?:Record<string,unknown>)=>Promise<T>;

export function cloudWorkflowPorts(options:{invoke:NativeInvoke;requestKey:string;revision:number;modelConfigVersion:string;
  keepFirstNumbers?:string[];store?:MemoryWorkflowStore;onProgress?:(state:WorkflowState)=>void}):WorkflowPorts{
  let jobId:string|null=null,stage:WorkflowState='idle',heartbeat:ReturnType<typeof setInterval>|undefined,beating=false;
  const native=options.invoke;
  const abortLocal=()=>{if(jobId)void native('workflow_abort',{jobId}).catch(()=>{});};
  return {
    store:options.store??new MemoryWorkflowStore(),
    model:{executionMode:'real',cacheKey:`cloud-deepseek-flash-${options.modelConfigVersion}`,
      async call(request,signal){
        if(!jobId)throw new Error('workflow_authorization_required');
        if(signal.aborted)throw new Error('workflow_cancelled');
        signal.addEventListener('abort',abortLocal,{once:true});
        try{const response=await native<ModelResponse>('workflow_call_model',{jobId,request});return {...response,usage:response.usage??undefined};}
        catch(error){throw new Error(typeof error==='string'?error:error instanceof Error?error.message:'model_service_failed');}
        finally{signal.removeEventListener('abort',abortLocal);}
      }},
    async authorize(input,policy,signal){
      const numbers=input.testScope?.questionNumbers??analyze(input.workspace).audit.questionNumbers;
      const run=await native<{jobId:string}>('workflow_begin',{expectedRevision:options.revision,pages:input.workspace.paper?.pages??[],questionNumbers:numbers,
        request:{requestKey:options.requestKey,contentHash:input.contentHash,mode:input.mode,exportLayout:'individual',workflowVersion:input.workflowVersion,promptVersion:input.promptVersion,
          counts:{pages:input.workspace.paper?.pages.length??0,units:numbers.length,students:input.workspace.students.length},
          requestedBudget:{maxCalls:policy.maxCalls,maxTokens:policy.maxTokens,maxRunSeconds:Math.floor(policy.maxRunMs/1000)}}});
      jobId=run.jobId;
      if(signal.aborted){abortLocal();throw new Error('workflow_cancelled');}
      heartbeat=setInterval(()=>{if(beating||!jobId)return;beating=true;
        void native('workflow_heartbeat',{jobId,stage}).catch(error=>{if(String(error)!=='account_network_failed')abortLocal();}).finally(()=>{beating=false;});},20000);
    },
    async release(outcome){
      if(heartbeat)clearInterval(heartbeat);
      if(jobId){const id=jobId;jobId=null;await native('workflow_end',{jobId:id,outcome});}
    },
    async persistDiagnostics(run){await native('workflow_save_diagnostic',{report:workflowAudit(run)});},
    async prepareUnits(input,_signal,invoke,report){if(!invoke)throw new Error('workflow_authorization_required');return recognizeWorkflowUnits(input,invoke,options.keepFirstNumbers,report);},
    async retrieve(query,signal){
      if(signal.aborted)throw new Error('workflow_cancelled');
      const hits=await native<{documentId:string;page:number;text:string}[]>('search_knowledge',{query});
      return hits.slice(0,6).map(({documentId,page,text})=>({documentId,page,text}));
    },
    onProgress(value){stage=value;options.onProgress?.(value);},
  };
}
