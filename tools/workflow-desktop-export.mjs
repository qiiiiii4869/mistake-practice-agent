// Private desktop IPC bridge. No model or cloud transport is reachable here.
import {createInterface} from 'node:readline';
import {dirname,resolve,join} from 'node:path';
import {exportWorkflowPdf} from './workflow-pdf-engine.mjs';
import {SqliteWorkflowStore,exportProfile} from '../app/packages/agent/src/workflow/index.ts';
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
const abort=new AbortController(),pending=new Map();let sequence=0,started=false;
globalThis.fetch=()=>Promise.reject(new Error('pdf_network_forbidden'));
const lines=createInterface({input:process.stdin});
function invoke(command,args){
 if(command!=='workflow_store')throw new Error('pdf_invalid_command');
 const id=++sequence;return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});send({event:'store',id,args});});
}
lines.on('line',line=>{
 try{const message=JSON.parse(line);
  if(message.type==='cancel'){abort.abort();return;}
  if(message.type==='reply'){const entry=pending.get(message.id);if(!entry)return;pending.delete(message.id);message.error?entry.reject(new Error(message.error)):entry.resolve(message.value);return;}
  if(started||message.type!=='start')throw new Error('pdf_invalid_command');started=true;
  void perform(message).then(result=>{send({event:'result',value:result});lines.close();process.stdin.destroy();},error=>{
   send({event:'error',code:/^[a-z_]+$/.test(error.message)?error.message:'pdf_export_failed'});lines.close();process.stdin.destroy();process.exitCode=1;
  });
 }catch{send({event:'error',code:'pdf_invalid_command'});abort.abort();}
});
lines.on('close',()=>{abort.abort();for(const entry of pending.values())entry.reject(new Error('pdf_bridge_closed'));pending.clear();});
async function perform(request){
 if(typeof request.ownerId!=='string'||typeof request.runId!=='string'||typeof request.compiler!=='string')throw new Error('pdf_invalid_command');
 const store=new SqliteWorkflowStore(invoke,request.ownerId),task=await store.task(request.runId);
 if(!task?.run||task.run.executionMode!=='real'||task.input.testScope||task.run.state!=='contentReady')throw new Error('pdf_content_incomplete');
 let profile,staging,outputDir;
 if(request.exportId){
  const saved=(await store.listExports(request.runId)).find(e=>e.profile.exportId===request.exportId);
  if(!saved?.staging)throw new Error('pdf_export_not_found');
  profile=saved.profile;staging=resolve(saved.staging);outputDir=dirname(dirname(staging));
  if(staging!==join(outputDir,'.workflow-work',profile.exportId))throw new Error('pdf_invalid_staging');
 }else{
  if(!['individual','combined'].includes(request.layout)||typeof request.includeAnswers!=='boolean'||typeof request.outputDir!=='string')throw new Error('pdf_invalid_command');
  profile=await exportProfile(task.input,request.runId,request.layout,request.includeAnswers);outputDir=resolve(request.outputDir);
 }
 const result=await exportWorkflowPdf({input:task.input,run:task.run,profile,outputDir,compiler:request.compiler,stagingDir:staging,workflowStore:store,signal:abort.signal,
  onProgress:e=>send({event:'progress',value:{stage:e.stage,filename:e.filename??null,revision:e.revision??0,exportId:profile.exportId}})});
 return {state:result.state,folder:result.path,exportId:profile.exportId,runId:request.runId,fileCount:result.manifest.outputs.length,settlementStatus:result.manifest.settlementStatus};
}
