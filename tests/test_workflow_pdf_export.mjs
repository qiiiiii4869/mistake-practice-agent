import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve,join} from 'node:path';
import {readFile,writeFile,mkdir,readdir,unlink} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {workflowPdfFixture} from './workflow_pdf_fixture.mjs';
import {exportProfile} from '../app/packages/agent/src/workflow/index.ts';
import {exportWorkflowPdf,retryWorkflowPdf} from '../tools/workflow-pdf-engine.mjs';
import {freezeInput} from '../app/packages/agent/src/workflow/index.ts';
import {selectTargets,assignStudents} from '../app/packages/agent/src/workflow/assignment.ts';
import {teachingEvidence} from '../app/packages/agent/src/workflow/teachingEvidence.ts';
import {templateClassTeachingReport} from '../app/packages/agent/src/workflow/teachingAdvice.ts';
const compiler=resolve('app/apps/desktop/src-tauri/resources/typst/typst.exe');
const root=resolve('tmp/workflow-pdf-tests/'+randomUUID());await mkdir(root,{recursive:true});
const summaries=[];
const options=async(mode,layout,answers=true,stress=false)=>{
  const s=await workflowPdfFixture(mode,{stress}),profile=await exportProfile(s.input,s.run.runId,layout,answers);
  return {...s,profile,compiler,syntheticPreview:true,keepRenders:true,outputDir:join(root,mode+'-'+layout+'-'+randomUUID())};
};
for(const mode of ['dictation','exercise'])for(const layout of ['individual','combined'])test(`real files ${mode}/${layout}: every page renders, hashes and owner boundaries verify`,async()=>{
  const o=await options(mode,layout,true,true),calls=o.model.calls.length,result=await exportWorkflowPdf(o);
  assert.equal(result.manifest.exportStatus,'verified');assert.equal(result.qa.passed,true);assert.equal(o.model.calls.length,calls);
  assert.ok(result.qa.files.every(f=>f.actualFonts.length&&f.pages.every(p=>p.checks.rendered&&p.checks.layoutAndText)));
  assert.ok(result.qa.files.find(f=>f.filename==='teacher-report.pdf').pages.length>1);
  if(layout==='combined')assert.ok(result.qa.files[0].outlineCount>=o.input.workspace.students.length);
  const again=await retryWorkflowPdf(result.staging);assert.equal(again.path,result.path);assert.equal(again.reused,true);
  assert.equal((await readdir(result.path)).some(f=>f.endsWith('.typ')||f==='request.json'),false);
  summaries.push({mode,layout,path:result.path,staging:result.staging,pages:result.qa.files.reduce((n,f)=>n+f.pages.length,0),files:result.manifest.outputs.length});
});
test('no-answer file excludes the answer section and can be re-exported without model work',async()=>{
  const o=await options('dictation','combined',false),before=o.model.calls.length,result=await exportWorkflowPdf(o);
  assert.ok(result.qa.files[0].pages.every(p=>p.role==='practice'));assert.equal(o.model.calls.length,before);
});
test('no targets, not scanned and no original paper retain distinct owned status pages',async()=>{
  const o=await options('dictation','individual'),workspace=structuredClone(o.input.workspace);
  for(const q of workspace.students[0].questions){q.score=q.fullScore;q.result='correct';}
  workspace.students.push({...structuredClone(workspace.students.at(-1)),id:'SYNTHETIC_NO_PAPER',name:'模拟无原卷人员',availability:'no_original_paper',reasonSource:'roster_has_origin_paper'});
  const input=await freezeInput({ownerId:o.input.ownerId,workspace,mode:'dictation'}),run=structuredClone(o.run);
  run.contentHash=input.contentHash;run.targets=selectTargets(input,run.facts);run.assignments=assignStudents(input,run.targets,run.items,run.facts);
  run.evidence=teachingEvidence(input,run.facts);run.teacherReport=templateClassTeachingReport(run.evidence);
  const profile=await exportProfile(input,run.runId,'individual',true),result=await exportWorkflowPdf({...o,input,run,profile});
  assert.equal(result.manifest.outputs.length,5);
  assert.equal(run.evidence.classOverview.scoredCount,2);assert.equal(run.evidence.classOverview.noOriginalPaperCount,1);
  for(const index of [0,2,3])assert.equal(result.qa.files[index].pages.length,1);
  summaries.push({mode:'status-pages',layout:'individual',path:result.path,staging:result.staging,files:5,pages:result.qa.files.reduce((n,f)=>n+f.pages.length,0)});
});
test('literal Typst requests remain printed data in an actually compiled exercise PDF',async()=>{
  const o=await options('exercise','combined');o.run.items[0].stem+=' #read("private.txt")';
  const result=await exportWorkflowPdf(o);assert.equal(result.qa.passed,true);
});
test('teacher IO failure leaves no completed output; retry reuses student PDFs and calls zero models',async()=>{
  const o=await options('exercise','individual'),before=o.model.calls.length;let staging;
  await assert.rejects(exportWorkflowPdf({...o,onProgress(event){staging=event.staging;if(event.stage==='checking'&&event.filename==='teacher-report.pdf')throw new Error('pdf_simulated_io_failure');}}),/pdf_simulated_io_failure/);
  assert.equal((await readdir(o.outputDir)).some(n=>n.startsWith('report-')),false);
  const result=await retryWorkflowPdf(staging);assert.equal(result.state,'verified');
  assert.ok(result.qa.files.filter(f=>f.filename.startsWith('student-')).every(f=>f.reused));assert.equal(o.model.calls.length,before);
});
test('corrupt file stops immediately without publication and can be regenerated on retry',async()=>{
  const o=await options('dictation','combined');let checks=0,staging;
  await assert.rejects(exportWorkflowPdf({...o,async onProgress(e){staging=e.staging;if(e.stage==='checking'&&e.filename==='teacher-report.pdf'){checks++;await writeFile(join(e.staging,e.filename),'not a pdf');}}}),/pdf_open_or_render_failed/);
  assert.equal(checks,1);assert.equal((await readdir(o.outputDir)).some(n=>n.startsWith('report-')),false);
  const result=await retryWorkflowPdf(staging);assert.equal(result.state,'verified');
});
test('continued teacher tables repeat real headers and keep unmapped evidence explicit',async()=>{
  const o=await options('dictation','combined'),workspace=structuredClone(o.input.workspace);
  for(const student of workspace.students.filter(s=>s.availability==='scored'))for(let i=3;i<=48;i++)student.questions.push({number:String(i),label:String(i),score:1,fullScore:1,result:'correct'});
  const input=await freezeInput({ownerId:o.input.ownerId,workspace,mode:'dictation'}),run=structuredClone(o.run);
  run.contentHash=input.contentHash;run.targets=selectTargets(input,run.facts);run.assignments=assignStudents(input,run.targets,run.items,run.facts);
  run.evidence=teachingEvidence(input,run.facts);run.teacherReport=templateClassTeachingReport(run.evidence);
  const profile=await exportProfile(input,run.runId,'combined',true),result=await exportWorkflowPdf({...o,input,run,profile}),teacher=result.qa.files.find(f=>f.filename==='teacher-report.pdf');
  const header=JSON.parse(await readFile(join(result.path,'document-plan.json'),'utf8')).documents.at(-1).blocks.find(b=>b.kind==='tableHeader');
  assert.ok(teacher.bounds.filter(b=>b.blockId===header.id).length>=2);assert.ok(teacher.pages.length>=3);
  summaries.push({mode:'teacher-table',layout:'combined',path:result.path,staging:result.staging,pages:teacher.pages.length,files:2});
});
test('an actual added blank page triggers bounded reflow, then passes only after real recompilation',async()=>{
  const o=await options('dictation','combined');let injected=false;
  const result=await exportWorkflowPdf({...o,async onProgress(e){if(!injected&&e.stage==='checking'&&e.filename==='teacher-report.pdf'){
    injected=true;const file=join(e.staging,e.filename);
    const py=spawnSync('python',['-c','import fitz,sys; d=fitz.open(sys.argv[1]); d.new_page(); d.saveIncr()',file],{windowsHide:true,encoding:'utf8'});assert.equal(py.status,0,py.stderr);
  }}});
  assert.equal(result.qa.reflowCount,1);assert.equal(result.qa.passed,true);
});
test('persistent blank pages exhaust exactly two reflows and never become a verified delivery',async()=>{
  const o=await options('dictation','combined');let injections=0,staging;
  await assert.rejects(exportWorkflowPdf({...o,async onProgress(e){staging=e.staging;if(e.stage==='checking'&&e.filename==='teacher-report.pdf'){
    injections++;const py=spawnSync('python',['-c','import fitz,sys; d=fitz.open(sys.argv[1]); d.new_page(); d.saveIncr()',join(e.staging,e.filename)],{windowsHide:true});assert.equal(py.status,0);
  }}}),/pdf_qa_failed/);
  assert.equal(injections,3);assert.equal(JSON.parse(await readFile(join(staging,'checkpoint.json'),'utf8')).revision,2);
  assert.equal((await readdir(o.outputDir)).some(n=>n.startsWith('report-')),false);
});
test('an interrupted destination copy resumes in the same temporary publication directory',async()=>{
  const o=await options('dictation','combined'),controller=new AbortController();let staging;
  // The source is already validated when publishing begins; cancellation must
  // leave a retryable private checkpoint rather than a completed report folder.
  await assert.rejects(exportWorkflowPdf({...o,signal:controller.signal,onProgress(e){staging=e.staging;if(e.stage==='publishing')controller.abort();}}),/pdf_cancelled/);
  assert.equal((await readdir(o.outputDir)).some(n=>n.startsWith('report-')),false);
  assert.equal((await retryWorkflowPdf(staging)).state,'verified');
});
test('cancellation stops before publication; duplicate starts share one export promise',async()=>{
  const o=await options('dictation','individual'),controller=new AbortController();let staging;
  const p=exportWorkflowPdf({...o,signal:controller.signal,onProgress(e){staging=e.staging;controller.abort();}});
  const q=exportWorkflowPdf({...o,signal:controller.signal});assert.equal(p,q);
  await assert.rejects(p,/pdf_cancelled/);assert.equal((await readdir(o.outputDir)).some(n=>n.startsWith('report-')),false);
  assert.equal((await retryWorkflowPdf(staging)).state,'verified');
});
test.after(async()=>{await writeFile(join(root,'matrix.json'),JSON.stringify({synthetic:true,root,results:summaries},null,2));console.log('PDF_QA_MATRIX='+join(root,'matrix.json'));});
