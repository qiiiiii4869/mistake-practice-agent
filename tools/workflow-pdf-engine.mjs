import {spawn} from 'node:child_process';
import {Worker} from 'node:worker_threads';
import {readFile,writeFile,mkdir,rename,copyFile,access} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {buildDocumentPlan,renderDocument} from '../app/packages/pdf/src/workflow/plan.ts';
const hash=value=>createHash('sha256').update(value).digest('hex');
const active=new Map();
const exists=path=>access(path).then(()=>true,()=>false);
const json=async(path,value)=>{await writeFile(path+'.tmp',JSON.stringify(value,null,2));await rename(path+'.tmp',path);};
function command(exe,args,{signal,timeout=60000}={}){
  return new Promise((resolve,reject)=>{
    const child=spawn(exe,args,{windowsHide:true,stdio:['ignore','pipe','pipe'],signal});let out='',err='';
    const timer=setTimeout(()=>child.kill(),timeout);child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);
    child.on('error',e=>{clearTimeout(timer);reject(new Error(e.name==='AbortError'?'pdf_cancelled':'pdf_compiler_unavailable'));});
    child.on('close',code=>{clearTimeout(timer);code===0?resolve({out,err}):reject(new Error(signal?.aborted?'pdf_cancelled':'pdf_compile_failed'));});
  });
}
export function inspectPdf({filename,document,metadata,renderDir,budget,foreignNames,signal}){
  return new Promise((resolve,reject)=>{
    const worker=new Worker(new URL('./workflow-pdf-worker.mjs',import.meta.url),{execArgv:[],workerData:{filename,document,metadata,renderDir,budget,foreignNames},resourceLimits:{maxOldGenerationSizeMb:512}});
    const stop=()=>{worker.terminate();reject(new Error('pdf_cancelled'));};
    const timer=setTimeout(()=>{worker.terminate();reject(new Error('pdf_check_timeout'));},Math.min(budget.timeoutMs,Math.max(60000,budget.maxPages*3000)));
    const clean=()=>{clearTimeout(timer);signal?.removeEventListener('abort',stop);};signal?.addEventListener('abort',stop,{once:true});
    worker.once('message',message=>{clean();worker.terminate();message.error?reject(new Error(message.error)):resolve(message.result);});
    worker.once('error',()=>{clean();reject(new Error('pdf_check_worker_failed'));});
    worker.once('exit',code=>{if(code&& !signal?.aborted){clean();reject(new Error('pdf_check_worker_failed'));}});
    if(signal?.aborted)stop();
  });
}
export function exportWorkflowPdf(options){
  const frozen={...options,input:structuredClone(options.input),run:structuredClone(options.run),profile:structuredClone(options.profile),sourceNames:structuredClone(options.sourceNames??{})};
  const key=resolve(options.outputDir)+'/'+(options.exportId??options.profile.exportId),signature=hash(JSON.stringify({input:frozen.input,run:frozen.run,profile:frozen.profile,syntheticPreview:options.syntheticPreview,sourceNames:frozen.sourceNames}));
  if(active.has(key)){const item=active.get(key);if(item.signature!==signature)return Promise.reject(new Error('pdf_export_busy'));return item.promise;}
  const promise=performExport(frozen).finally(()=>active.delete(key));active.set(key,{signature,promise});return promise;
}
async function performExport(options){
  const {input,run,profile,signal,onProgress=()=>{},workflowStore}=options;
  if(workflowStore){const saved=await workflowStore.task(run.runId);if(!saved?.run||saved.run.contentHash!==run.contentHash||saved.run.state!=='contentReady')throw new Error('pdf_stored_content_required');
    await workflowStore.listExports(run.runId);}
  const outputDir=resolve(options.outputDir),compiler=resolve(options.compiler),id=options.exportId??profile.exportId;
  if(!/^[a-zA-Z0-9-]{1,100}$/.test(id))throw new Error('pdf_invalid_export_id');
  const staging=options.stagingDir?resolve(options.stagingDir):join(outputDir,'.workflow-work',id);
  if(options.stagingDir&&dirname(staging)!==join(outputDir,'.workflow-work'))throw new Error('pdf_invalid_staging');
  const request={input,run,profile,syntheticPreview:options.syntheticPreview===true,sourceNames:options.sourceNames??{},outputDir,compiler,exportId:id,keepRenders:options.keepRenders===true};
  const requestHash=hash(JSON.stringify(request));
  await buildDocumentPlan(input,run,profile,{syntheticPreview:request.syntheticPreview,sourceNames:request.sourceNames});
  await mkdir(staging,{recursive:true});
  let checkpoint={requestHash,revision:0,files:{},state:'staging'};
  if(await exists(join(staging,'checkpoint.json'))){checkpoint=JSON.parse(await readFile(join(staging,'checkpoint.json'),'utf8'));if(checkpoint.requestHash!==requestHash)throw new Error('pdf_stale_staging');}
  else{await json(join(staging,'request.json'),request);await json(join(staging,'checkpoint.json'),checkpoint);}
  if(workflowStore){const existing=(await workflowStore.listExports(run.runId)).find(e=>e.profile.exportId===profile.exportId);
    if(existing?.state!=='verified')await workflowStore.saveExport(run.runId,{profile,state:'exporting',staging});}
  const started=Date.now();let plan,qa;
  const checked=()=>{if(signal?.aborted)throw new Error('pdf_cancelled');if(plan&&Date.now()-started>plan.budget.timeoutMs)throw new Error('pdf_export_timeout');};
  try{
    const version=await command(compiler,['--version'],{signal}),compilerHash=hash(await readFile(compiler));
    const fontDir=process.env.WINDIR?join(process.env.WINDIR,'Fonts'):null;
    const fontFiles=fontDir?['msyh.ttc','msyhbd.ttc','cambria.ttc'].map(f=>join(fontDir,f)):[];
    const fontEvidence=[];for(const file of fontFiles)fontEvidence.push({file:file.split(/[\\/]/).at(-1),sha256:hash(await readFile(file))});
    for(let revision=checkpoint.revision;revision<=2;revision++){
      plan=await buildDocumentPlan(input,run,profile,{syntheticPreview:request.syntheticPreview,revision,sourceNames:request.sourceNames});checked();
      if(plan.estimatedPages>1200||Buffer.byteLength(JSON.stringify(plan))>40*1024*1024)throw new Error('pdf_export_size_limit');
      checkpoint.revision=revision;qa={schemaVersion:1,templateVersion:plan.templateVersion,exportHash:plan.exportHash,reflowCount:revision,
        fontPolicy:{body:'Microsoft YaHei',math:'Cambria Math / bundled New Computer Modern',minimumBodyPt:10.5},
        compiler:{version:version.out.trim(),sha256:compilerHash},fontEvidence,
        layers:{content:{passed:true,runId:run.runId,contentHash:input.contentHash,selectedTargets:run.assignments.reduce((n,a)=>n+a.selectedTargets.length,0),
          uncoveredTargets:run.assignments.reduce((n,a)=>n+a.uncoveredTargets.length,0),teacherEvidenceRecomputed:true},
          assembly:{passed:true,expectedDocuments:plan.documents.length,studentCount:plan.studentCount,teacherDocuments:1},
          layout:{passed:false},actualPdf:{passed:false},pageRendering:{passed:false}},
        limitations:['逐页规则和光栅检查不证明科学事实或所有视觉细节正确；模板须经开发金样看图验收。'],files:[],passed:false};
      await json(join(staging,'qa-report.json'),qa);await json(join(staging,'document-plan.json'),plan);
      for(const doc of plan.documents){
        checkpoint.currentFile=doc.filename;await json(join(staging,'checkpoint.json'),checkpoint);
        checked();await onProgress({stage:'compiling',filename:doc.filename,revision,staging});
        const source=renderDocument(plan,doc),sourceHash=hash(source),sourceFile=join(staging,doc.id+'.typ'),pdf=join(staging,doc.filename);
        await writeFile(sourceFile,source);
        const old=checkpoint.files[doc.id];let reuse=false;
        if(old?.passed&&old.sourceHash===sourceHash&&await exists(pdf))reuse=hash(await readFile(pdf))===old.pdfHash;
        if(!reuse){const result=await command(compiler,['compile','--root',staging,...(fontDir?['--ignore-system-fonts','--font-path',fontDir]:[]),'--creation-timestamp','0',sourceFile,pdf],{signal,timeout:Math.min(plan.budget.timeoutMs,120000)});
          if(result.err.trim())throw new Error('pdf_font_or_layout_warning');}
        const query=await command(compiler,['eval','query(metadata).map(it => it.value)',...(fontDir?['--ignore-system-fonts','--font-path',fontDir]:[]),'--in',sourceFile],{signal});
        const metadata=JSON.parse(query.out);
        await onProgress({stage:'checking',filename:doc.filename,revision,staging,reused:reuse});
        const foreignNames=doc.role==='teacher'?input.workspace.students.map(s=>s.name):input.workspace.students.filter(s=>!doc.ownerIds.includes(s.id)).map(s=>s.name);
        const report=await inspectPdf({filename:pdf,document:doc,metadata,budget:plan.budget,foreignNames,signal,
          renderDir:request.keepRenders?join(staging,'renders',doc.id):undefined});
        checked();qa.files.push({documentId:doc.id,filename:doc.filename,...report,reused:reuse});
        checkpoint.files[doc.id]={sourceHash,pdfHash:report.sha256,passed:report.passed};await json(join(staging,'checkpoint.json'),checkpoint);
      }
      const totalPages=qa.files.reduce((n,f)=>n+f.pages.length,0),totalBytes=qa.files.reduce((n,f)=>n+f.size,0);
      if(totalPages>plan.budget.maxPages||totalBytes>plan.budget.maxBytes)throw new Error('pdf_export_size_limit');
      qa.passed=qa.files.length===plan.documents.length&&qa.files.every(f=>f.passed);
      qa.layers.layout={passed:qa.passed,checkedBlocks:qa.files.reduce((n,f)=>n+f.bounds.length,0)};
      qa.layers.actualPdf={passed:qa.passed,checkedFiles:qa.files.length,totalPages,totalBytes};
      qa.layers.pageRendering={passed:qa.passed,renderedPages:totalPages,dpi:144,sequential:true};
      await json(join(staging,'qa-report.json'),qa);await json(join(staging,'document-plan.json'),plan);
      await json(join(staging,`qa-attempt-${revision}.json`),qa);
      if(qa.passed)break;
      await onProgress({stage:'reflowing',revision,staging});
    }
    if(!qa.passed)throw new Error('pdf_qa_failed');checked();
    const manifest={schemaVersion:1,exportId:id,runId:run.runId,contentHash:input.contentHash,exportHash:plan.exportHash,profileHash:profile.exportHash,
      mode:run.mode,layout:profile.layout,includeAnswers:profile.includeAnswers,synthetic:plan.synthetic,exportStatus:'verified',settlementStatus:'not_requested',
      templateVersion:plan.templateVersion,qaReport:'qa-report.json',outputs:plan.documents.map(doc=>{
        const f=qa.files.find(f=>f.documentId===doc.id);return {role:doc.role,ownerId:doc.ownerIds.length===1?doc.ownerIds[0]:null,ownerIds:doc.ownerIds,
          relativePath:doc.filename,size:f.size,sha256:f.sha256,pages:f.pages.length};})};
    const target=join(outputDir,'report-'+id),pending=join(outputDir,'.publish-'+id);
    if(await exists(target)){
      const previous=JSON.parse(await readFile(join(target,'manifest.json'),'utf8'));
      if(JSON.stringify(previous)!==JSON.stringify(manifest))throw new Error('pdf_output_conflict');
      for(const f of manifest.outputs)if(hash(await readFile(join(target,f.relativePath)))!==f.sha256)throw new Error('pdf_output_conflict');
      const saved=JSON.parse(await readFile(join(target,'qa-report.json'),'utf8'));
      if(!saved.passed||saved.exportHash!==manifest.exportHash||saved.files.some(f=>!f.passed))throw new Error('pdf_output_conflict');
      if(workflowStore)await workflowStore.saveExport(run.runId,{profile,state:'verified',folder:target,staging,manifest:previous,qa});
      return {state:'verified',path:target,manifest:previous,qa,staging,reused:true};
    }
    const publication={requestHash,exportHash:plan.exportHash};
    if(await exists(pending)){
      if(!await exists(join(pending,'publish-state.json'))||JSON.stringify(JSON.parse(await readFile(join(pending,'publish-state.json'),'utf8')))!==JSON.stringify(publication))throw new Error('pdf_publish_pending');
    }else{await mkdir(pending,{recursive:false});await json(join(pending,'publish-state.json'),publication);}
    await onProgress({stage:'publishing',staging});
    for(const f of manifest.outputs){checked();await copyFile(join(staging,f.relativePath),join(pending,f.relativePath));
      if(hash(await readFile(join(pending,f.relativePath)))!==f.sha256)throw new Error('pdf_copy_hash_mismatch');}
    await json(join(pending,'manifest.json'),manifest);await json(join(pending,'qa-report.json'),qa);await json(join(pending,'document-plan.json'),plan);
    await json(join(pending,'student-boundaries.json'),qa.files.filter(f=>f.filename!=='teacher-report.pdf').map(f=>({filename:f.filename,pages:f.pages.map(p=>({page:p.page,ownerId:p.ownerId,role:p.role}))})));
    checked();await rename(pending,target);checkpoint.state='verified';await json(join(staging,'checkpoint.json'),checkpoint);
    if(workflowStore)await workflowStore.saveExport(run.runId,{profile,state:'verified',folder:target,staging,manifest,qa});
    await onProgress({stage:'verified',path:target});return {state:'verified',path:target,manifest,qa,staging,reused:false};
  }catch(error){checkpoint.state=signal?.aborted?'cancelled':'failed';checkpoint.error=/^[a-z_]+$/.test(error.message)?error.message:'pdf_export_failed';
    if(qa){qa.passed=false;qa.fatal={code:checkpoint.error,file:checkpoint.currentFile??null};await json(join(staging,'qa-report.json'),qa);}
    await json(join(staging,'checkpoint.json'),checkpoint);
    if(workflowStore)try{const old=(await workflowStore.listExports(run.runId)).find(e=>e.profile.exportId===profile.exportId);if(old?.state!=='verified')await workflowStore.saveExport(run.runId,{profile,state:signal?.aborted?'cancelled':'failed',staging});}catch{}
    throw Object.assign(new Error(checkpoint.error),{staging});}
}
export async function retryWorkflowPdf(stagingDir,options={}){
  const request=JSON.parse(await readFile(join(stagingDir,'request.json'),'utf8'));
  return exportWorkflowPdf({...request,stagingDir,signal:options.signal,onProgress:options.onProgress,workflowStore:options.workflowStore});
}
