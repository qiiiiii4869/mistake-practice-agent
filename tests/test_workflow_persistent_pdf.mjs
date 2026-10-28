import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {SqliteWorkflowStore,runWorkflow,exportProfile} from '../app/packages/agent/src/workflow/index.ts';
import {setupWorkflow} from './workflow_fixture.mjs';
import {sqliteProbeTransport} from '../tools/workflow-store-transport.mjs';
import {exportWorkflowPdf,retryWorkflowPdf} from '../tools/workflow-pdf-engine.mjs';
test('PDF failure and export choices survive reopen; retry and layout change make zero new model calls',async()=>{
 const folder=resolve('tmp/persistent-pdf/'+randomUUID());await mkdir(folder,{recursive:true});const database=join(folder,'workflow.sqlite');
 const first=sqliteProbeTransport(database),s=await setupWorkflow(),owner=s.input.ownerId,runId=randomUUID();let staging,run,profile;
 try{
  const store=new SqliteWorkflowStore(first.invoke,owner);run=await runWorkflow({input:s.input,ports:{...s.ports,store},runId});
  profile=await exportProfile(s.input,runId,'combined',true);
  await assert.rejects(exportWorkflowPdf({input:s.input,run,profile,workflowStore:store,syntheticPreview:true,compiler:resolve('app/apps/desktop/src-tauri/resources/typst/typst.exe'),outputDir:join(folder,'reports'),
    onProgress(e){staging=e.staging;if(e.stage==='checking'&&e.filename==='teacher-report.pdf')throw new Error('pdf_simulated_io_failure');}}),/pdf_simulated_io_failure/);
  assert.equal((await store.listExports(runId))[0].state,'failed');
 }finally{await first.close();}
 const second=sqliteProbeTransport(database);
 try{
  const store=new SqliteWorkflowStore(second.invoke,owner),task=await store.task(runId),count=s.model.calls.length;
  assert.equal(task.run.state,'contentReady');assert.equal((await store.listExports(runId))[0].profile.layout,'combined');
  const result=await retryWorkflowPdf(staging,{workflowStore:store});assert.equal(result.state,'verified');
  assert.equal((await store.listExports(runId))[0].state,'verified');
  const again=await retryWorkflowPdf(staging,{workflowStore:store});assert.equal(again.path,result.path);
  const individual=await exportProfile(task.input,runId,'individual',false);
  const next=await exportWorkflowPdf({input:task.input,run:task.run,profile:individual,workflowStore:store,syntheticPreview:true,compiler:resolve('app/apps/desktop/src-tauri/resources/typst/typst.exe'),outputDir:join(folder,'reports')});
  assert.equal(next.state,'verified');assert.equal((await store.listExports(runId)).length,2);assert.equal(s.model.calls.length,count);
  assert.equal(result.qa.files[0].reused,true);assert.equal(JSON.parse(await readFile(join(next.path,'manifest.json'),'utf8')).settlementStatus,'not_requested');
 }finally{await second.close();}
});
