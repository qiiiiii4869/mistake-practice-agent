import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir,readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {SqliteWorkflowStore,runWorkflow,freezeInput} from '../app/packages/agent/src/workflow/index.ts';
import {setupWorkflow} from './workflow_fixture.mjs';
import {sqliteProbeTransport} from '../tools/workflow-store-transport.mjs';

const root=resolve('tmp/desktop-export-tests/'+randomUUID()),runtime=resolve(process.env.WORKFLOW_PDF_TEST_RUNTIME??'app/apps/desktop/src-tauri/resources/workflow-runtime'),compiler=resolve(process.env.WORKFLOW_PDF_TEST_COMPILER??'app/apps/desktop/src-tauri/resources/typst/typst.exe');
await mkdir(root,{recursive:true});
function native(config){return new Promise((resolve,reject)=>{
 const child=spawn('tools/storage-check/target/debug/workflow_export_probe.exe',[],{windowsHide:true,stdio:['pipe','pipe','pipe']});let out='',err='';
 child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);child.on('error',reject);
 child.on('close',code=>{try{assert.equal(code,0,err);resolve(JSON.parse(out));}catch(e){reject(e);}});child.stdin.end(JSON.stringify(config)+'\n');
});}
async function saved(mode='dictation',{mock=false,minimum=false}={}){
 const s=await setupWorkflow({mode});
 if(minimum)s.input=await freezeInput({ownerId:s.input.ownerId,workspace:s.input.workspace,mode,validationLevel:'minimum'});
 // Metadata is deliberately real to exercise the production gate with synthetic
 // callbacks only. This is an integration contract test, never content acceptance.
 if(!mock)s.model.executionMode='real';
 const runId=randomUUID(),database=join(root,runId+'.sqlite'),transport=sqliteProbeTransport(database),store=new SqliteWorkflowStore(transport.invoke,s.input.ownerId);
 let run;try{run=await runWorkflow({input:s.input,ports:{...s.ports,store,...(!mock?{authorize:async()=>{},release:async()=>{}}:{})},runId});}finally{await transport.close();}assert.equal(run.state,'contentReady');
 return {database,runId,owner:s.input.ownerId,calls:s.model.calls.length};
}
for(const mode of ['dictation','exercise'])test(`native packaged export ${mode}: all students + separate teacher, layout changes and reopen without generation`,async()=>{
 const s=await saved(mode),request={type:'start',ownerId:s.owner,runId:s.runId,compiler,outputDir:join(root,s.runId),layout:'individual',includeAnswers:true};
 const first=await native({database:s.database,runtime,request});assert.equal(first.error,undefined);assert.equal(first.value.fileCount,4);assert.equal(first.value.settlementStatus,'not_requested');
 const manifest=JSON.parse(await readFile(join(first.value.folder,'manifest.json'),'utf8'));assert.equal(manifest.outputs.filter(o=>o.role==='teacher').length,1);
 const combined=await native({database:s.database,runtime,request:{...request,layout:'combined',includeAnswers:false}});assert.equal(combined.value.fileCount,2);
 const repeated=await native({database:s.database,runtime,request:{type:'start',ownerId:s.owner,runId:s.runId,compiler,exportId:first.value.exportId}});assert.equal(repeated.error,undefined,JSON.stringify(repeated));assert.equal(repeated.value.folder,first.value.folder);
 const transport=sqliteProbeTransport(s.database),store=new SqliteWorkflowStore(transport.invoke,s.owner);
 try{const task=await store.task(s.runId);assert.equal(task.run.calls.length,s.calls);assert.equal((await store.listExports(s.runId)).length,2);}finally{await transport.close();}
});
test('native export refuses synthetic workflow metadata before PDF delivery',async()=>{
 const s=await saved('dictation',{mock:true}),result=await native({database:s.database,runtime,request:{type:'start',ownerId:s.owner,runId:s.runId,compiler,outputDir:join(root,s.runId),layout:'individual',includeAnswers:true}});
 assert.equal(result.error,'pdf_content_incomplete');
});
test('original native PDF export accepts minimum drafts without inventing independent checks',async()=>{
 const s=await saved('dictation',{minimum:true}),result=await native({database:s.database,runtime,request:{type:'start',ownerId:s.owner,runId:s.runId,compiler,outputDir:join(root,s.runId),layout:'individual',includeAnswers:true}});
 assert.equal(result.error,undefined,JSON.stringify(result));assert.equal(result.value.fileCount,4);assert.equal(result.value.settlementStatus,'not_requested');
 const transport=sqliteProbeTransport(s.database);try{const store=new SqliteWorkflowStore(transport.invoke,s.owner),task=await store.task(s.runId);
  assert.equal(task.input.validationLevel,'minimum');assert(task.run.items.every(i=>i.status==='draft'&&!i.checks.independent));assert.equal(task.run.calls.length,s.calls);
 }finally{await transport.close();}
});
test('native cancellation stops the export and leaves generation receipts untouched',async()=>{
 const s=await saved(),result=await native({database:s.database,runtime,cancelAfterMs:300,request:{type:'start',ownerId:s.owner,runId:s.runId,compiler,outputDir:join(root,s.runId),layout:'individual',includeAnswers:true}});
 assert.equal(result.error,'pdf_cancelled');const transport=sqliteProbeTransport(s.database),store=new SqliteWorkflowStore(transport.invoke,s.owner);
 try{assert.equal((await store.task(s.runId)).run.calls.length,s.calls);}finally{await transport.close();}
});
