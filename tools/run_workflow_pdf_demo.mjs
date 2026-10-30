// Phase B synthetic fixtures only. Never uses HTTP, a shared Key or settlement.
import {resolve,join} from 'node:path';
import {mkdir,writeFile} from 'node:fs/promises';
import {setupWorkflow} from '../tests/workflow_fixture.mjs';
import {runWorkflow,exportProfile} from '../app/packages/agent/src/workflow/index.ts';
import {exportWorkflowPdf,retryWorkflowPdf} from './workflow-pdf-engine.mjs';
import {workflowPdfFixture} from '../tests/workflow_pdf_fixture.mjs';

const retryIndex=process.argv.indexOf('--retry');
if(retryIndex>=0){
  if(!process.argv[retryIndex+1])throw new Error('pdf_staging_path_required');
  const r=await retryWorkflowPdf(resolve(process.argv[retryIndex+1]));console.log(JSON.stringify({state:r.state,path:r.path,settled:false}));process.exit(0);
}

const compiler=resolve('app/apps/desktop/src-tauri/resources/typst/typst.exe');
const output=resolve('output/pdf/workflow-phase-b');await mkdir(output,{recursive:true});
const results=[];
for(const mode of process.argv.includes('--quick')?['dictation']:['dictation','exercise']){
  const s=process.argv.includes('--stress')?await workflowPdfFixture(mode,{stress:true}):await setupWorkflow({mode,library:true}),run=s.run??await runWorkflow(s),before=s.model.calls.length;
  for(const layout of process.argv.includes('--quick')?['combined']:['individual','combined']){
    const profile=await exportProfile(s.input,run.runId,layout,true);
    try{
      const result=await exportWorkflowPdf({input:s.input,run,profile,outputDir:join(output,`${mode}-${layout}`),compiler,syntheticPreview:true,keepRenders:true,sourceNames:{'synthetic-book':'合成教材.pdf'}});
      results.push({mode,layout,path:result.path,staging:result.staging,pages:result.qa.files.reduce((n,f)=>n+f.pages.length,0),files:result.manifest.outputs.length,verified:result.state==='verified'});
      console.log(JSON.stringify(results.at(-1)));
    }catch(e){console.error(JSON.stringify({mode,layout,error:e.message,staging:e.staging}));throw e;}
    if(s.model.calls.length!==before)throw new Error('pdf_made_model_call');
  }
}
await writeFile(join(output,'matrix.json'),JSON.stringify({phase:'B',synthetic:true,settled:false,results},null,2));
