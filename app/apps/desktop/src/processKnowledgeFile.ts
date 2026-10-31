import type {KnowledgeDocument} from '../../../packages/knowledge/src';
import type {ImportKind} from '../../../packages/knowledge/src/processKnowledge';

export function processKnowledgeFile(document:KnowledgeDocument,kind:ImportKind):Promise<KnowledgeDocument>{
 const worker=new Worker(new URL('./knowledgeProcessWorker.ts',import.meta.url),{type:'module'});
 return new Promise((resolve,reject)=>{
  worker.onmessage=event=>{worker.terminate();if(event.data.error)reject(new Error(event.data.error));else resolve(event.data.value);};
  worker.onerror=()=>{worker.terminate();reject(new Error('knowledge_processing_invalid'));};
  worker.postMessage({document,kind});
 });
}
