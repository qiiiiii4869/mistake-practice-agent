import {processKnowledge} from '../../../packages/knowledge/src/processKnowledge.ts';
self.onmessage=event=>{
 try{self.postMessage({value:processKnowledge(event.data.document,event.data.kind)});}
 catch(error){self.postMessage({error:error instanceof Error&&/^knowledge_|^invalid_knowledge_/.test(error.message)?error.message:'knowledge_processing_invalid'});}
};
