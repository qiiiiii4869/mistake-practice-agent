import { analyze } from '../../../core/src/index.ts';
import { MemoryWorkflowStore } from './store.ts';
import {workflowAudit} from './diagnostics.ts';
import {recognizeWorkflowUnits} from './recognition.ts';
import {biologyEvidence} from '../../../knowledge/src/biology.ts';
import {KNOWLEDGE_RETRIEVAL_VERSION} from '../../../knowledge/src/index.ts';
export {recognizeWorkflowUnits} from './recognition.ts';
import type { ModelResponse, WorkflowPorts, WorkflowState,WorkflowStore,WorkflowCloudBinding } from './types.ts';

export interface CloudModelStatus { configured:boolean;model:string;modelConfigVersion:string|null;deliveryEnabled:boolean }
export type NativeInvoke = <T>(command:string,args?:Record<string,unknown>)=>Promise<T>;

export function cloudWorkflowPorts(options:{invoke:NativeInvoke;requestKey:string;revision:number;modelConfigVersion:string;subject?:string;
  keepFirstNumbers?:string[];store?:WorkflowStore;resumeCloud?:WorkflowCloudBinding;exportLayout?:'individual'|'combined';onProgress?:(state:WorkflowState)=>void}):WorkflowPorts{
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
      const run=await native<{jobId:string;leaseUntil?:number;expiresAt?:number}>('workflow_begin',{expectedRevision:options.revision,pages:input.workspace.paper?.pages??[],questionNumbers:numbers,
        request:{requestKey:options.requestKey,contentHash:input.contentHash,mode:input.mode,exportLayout:options.exportLayout??'individual',workflowVersion:input.workflowVersion,promptVersion:input.promptVersion,
          counts:{pages:input.workspace.paper?.pages.length??0,units:numbers.length,students:input.workspace.students.length},
          requestedBudget:{maxCalls:policy.maxCalls,maxTokens:policy.maxTokens,maxRunSeconds:Math.floor(policy.maxRunMs/1000)}}});
      jobId=run.jobId;
      if(options.resumeCloud&&jobId!==options.resumeCloud.jobId){abortLocal();throw new Error('workflow_stale_cloud_job');}
      if(signal.aborted){abortLocal();throw new Error('workflow_cancelled');}
      heartbeat=setInterval(()=>{if(beating||!jobId)return;beating=true;
        void native('workflow_heartbeat',{jobId,stage}).catch(error=>{if(String(error)!=='account_network_failed')abortLocal();}).finally(()=>{beating=false;});},20000);
      if(run.leaseUntil&&run.expiresAt)return {jobId:run.jobId,requestKey:options.requestKey,leaseUntil:run.leaseUntil,expiresAt:run.expiresAt,status:'active' as const};
    },
    async release(outcome,run){
      if(heartbeat)clearInterval(heartbeat);
      const id=jobId??(options.resumeCloud?.status!=='ended'?options.resumeCloud?.jobId:null);jobId=null;
      if(id){if(options.store?.durable&&run&&['cancelled','recoverable'].includes(run.state)){await native('workflow_abort',{jobId:id});return 'suspended' as const;}
        await native('workflow_end',{jobId:id,outcome});return 'ended' as const;}
    },
    async persistDiagnostics(run){await native('workflow_save_diagnostic',{report:workflowAudit(run)});},
    async prepareUnits(input,_signal,invoke,report){if(!invoke)throw new Error('workflow_authorization_required');return recognizeWorkflowUnits(input,invoke,input.recognitionPolicy?.keepFirstNumbers??options.keepFirstNumbers,report);},
    ...( /生物|biology/i.test(options.subject??'')?{async retrieveForOriginal(unit:import('./types.ts').SourceUnit,signal:AbortSignal,input?:import('./types.ts').FrozenInput){
      if(signal.aborted)throw new Error('workflow_cancelled');
      const query=[unit.stem,unit.material,...unit.options].join('\n').slice(0,19000),builtIn=biologyEvidence(query,3);
      // Legacy frozen requests keep their old pre-extraction evidence boundary.
      if(input&&input.retrievalVersion!==KNOWLEDGE_RETRIEVAL_VERSION)return builtIn;
      const cached=await native<import('../../../knowledge/src/index.ts').KnowledgeHit[]>('search_knowledge_for_question',{query});
      if(signal.aborted)throw new Error('workflow_cancelled');
      // Interleave sources and budget their real UTF-8 bytes before extraction.
      // Large banks must not push a single analysis unit over the native limit.
      const ordered=[cached[0],builtIn[0],cached[1],builtIn[1],cached[2],builtIn[2]],evidence:{documentId:string;page:number;text:string}[]=[];
      const encoder=new TextEncoder(),limit=Math.max(0,18000-encoder.encode(query).length);let used=0;
      for(const value of ordered){if(!value)continue;const {documentId,page,text}=value,ref={documentId,page,text},bytes=encoder.encode(JSON.stringify(ref)).length;if(used+bytes>limit)continue;used+=bytes;evidence.push(ref);}
      return evidence;
    }}:{}),
    async retrieve(query,signal){
      if(signal.aborted)throw new Error('workflow_cancelled');
      const builtIn=/生物|biology/i.test(options.subject??'')?biologyEvidence(query,4):[];
      // Knowledge names are separate search concepts, not one exact long phrase.
      const terms=[...new Set(query.split(/\s+/).map(t=>t.trim()).filter(t=>t&&[...t].length<=100&&!t.includes('\0')))].slice(0,3);
      const hits:{documentId:string;page:number;text:string}[]=[];
      for(const term of terms){if(signal.aborted)throw new Error('workflow_cancelled');hits.push(...await native<typeof hits>('search_knowledge',{query:term}));}
      const seen=new Set<string>();return [...builtIn,...hits].filter(h=>{const key=`${h.documentId}:${h.page}:${h.text}`;if(seen.has(key))return false;seen.add(key);return true;}).slice(0,6).map(({documentId,page,text})=>({documentId,page,text}));
    },
    onProgress(value){stage=value;options.onProgress?.(value);},
  };
}
