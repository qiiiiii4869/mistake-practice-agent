import test from 'node:test';
import assert from 'node:assert/strict';
import {segmentResponse} from '../app/packages/agent/src/workflow/segmentation.ts';
import {recognizeWorkflowUnits,recheckSavedRecognition} from '../app/packages/agent/src/workflow/recognition.ts';
import {freezeInput,digest,assertFrozen} from '../app/packages/agent/src/workflow/input.ts';
import {modelRequest} from '../app/packages/agent/src/workflow/prompts.ts';
import {workflowWorkspace,setupWorkflow} from './workflow_fixture.mjs';
import {runWorkflow} from '../app/packages/agent/src/workflow/runner.ts';

const numbers=['12','13','14','15'];
const question=(number,...paragraphs)=>({number,paragraphs,confidence:'high',warnings:[]});
async function input(){
 const w=workflowWorkspace(),student=w.students[0],q=student.questions[0];
 w.students=[{...student,questions:numbers.map(n=>({...q,number:n,label:n,score:0,result:'incorrect'}))}];
 w.paper.pages=Array.from({length:2},(_,i)=>({...w.paper.pages[0],id:`p${i+1}`}));
 return freezeInput({ownerId:'segmentation-test',workspace:w,mode:'dictation',validationLevel:'minimum'});
}
test('printed main headings split merged questions; subquestions, numeric values and unknown numbers never renumber targets',()=>{
 const r=segmentResponse({questions:[question('13','13. 选择题原文','A. 一项','三、非选择题','１４．（10分）遗传题原文','（1）小问，浓度1.5mg','① 二级小问','（2）另一小问')]},numbers);
 assert.deepEqual(r.questions.map(q=>q.number),['13','14']);assert.equal(r.questions[0].paragraphs.join('\n'),'13. 选择题原文\nA. 一项');
 assert(r.questions[1].paragraphs.join('\n').includes('（2）'));assert(!r.questions[0].paragraphs.join('\n').includes('遗传题'));
 const unknown=segmentResponse({questions:[question('13','13. 正文','99. 卷面额外题','不许并回13')]},numbers);
 assert.equal(unknown.questions.length,1);assert(!unknown.questions[0].paragraphs.join('').includes('额外题'));
});
test('unheaded text after a section title cannot leak from the next item into the previous choice question',()=>{
 const r=segmentResponse({questions:[question('13','选择题原文','D. 最后选项','三、非选择题','（10分）漏掉主编号的下一题正文','（1）下一题小问')]},numbers);
 assert.equal(r.questions.length,1);assert.deepEqual(r.questions[0].paragraphs,['选择题原文','D. 最后选项']);
});
test('missing printed question triggers one page repair with its neighbor; shorter corrected neighbor replaces merged text',async()=>{
 const i=await input(),requests=[];
 const units=await recognizeWorkflowUnits(i,async(stage,d)=>{
  requests.push(d);
  if(d.focusNumbers){assert.equal(d.pageId,'p1');assert.deepEqual(d.focusNumbers,['13','14']);
   return {printedNumbers:['12','13','14'],questions:[question('13','13. 基因工程选择题'),question('14','14. 植物遗传大题','（1）独立小问')]};}
  return d.pageId==='p1'?{printedNumbers:['12','13','14'],questions:[question('12','12. 正文'),question('13','13. 基因工程选择题','（10分）错误并入的遗传题长段落')]}:
   {printedNumbers:['15'],questions:[question('15','15. 下一页正文')]};
 });
 assert.equal(requests.length,3);assert(units.every(u=>u.availability==='usable'));
 assert.equal(units.find(u=>u.unitId==='unit-13').stem,'13. 基因工程选择题');
 assert.equal(units.find(u=>u.unitId==='unit-14').pageIds[0],'p1');assert(!units.find(u=>u.unitId==='unit-13').stem.includes('遗传题'));
});
test('fallback rereads adjacent pages once and leaves genuinely missing numbers absent',async()=>{
 const i=await input(),requests=[];
 const units=await recognizeWorkflowUnits(i,async(stage,d)=>{requests.push(d);return {questions:d.pageId==='p1'?[question('12','12. 正文'),question('13','13. 正文')]:[question('15','15. 正文')]};});
 assert.equal(requests.length,4);assert.equal(requests.filter(d=>d.focusNumbers).length,2);assert(!units.some(u=>u.sourceNumbers.includes('14')));
 assert(requests.every(d=>!d.focusNumbers||d.focusNumbers.includes('14')));
});
test('complete pages need no extra read even with low confidence, and independent checks remain disabled',async()=>{
 const i=await input();let calls=0;
 const units=await recognizeWorkflowUnits(i,async()=>{calls++;return {questions:numbers.map(n=>({...question(n,`${n}. 完整正文`),confidence:'low',warnings:['正文待教师看']}))};});
 assert.equal(calls,2);assert.equal(units.length,4);
});
test('strict mode keeps two independent reads after segmentation, while old frozen inputs keep original requests',async()=>{
 const i=await freezeInput({ownerId:'strict',workspace:workflowWorkspace(),mode:'dictation'});let calls=0;
 const units=await recognizeWorkflowUnits(i,async(stage,d)=>{calls++;assert.equal(d.segmentation,'printed-headings-v1');return {questions:[question('1','1. 第一题','2. 第二题')]};});
 assert.equal(calls,2);assert.equal(units.length,2);assert(units.every(u=>u.availability==='usable'));
 const {segmentationVersion,contentHash,...legacyBody}=i,legacy={...legacyBody,contentHash:await digest(legacyBody)};await assertFrozen(legacy);
 calls=0;await recognizeWorkflowUnits(legacy,async(stage,d)=>{calls++;assert.deepEqual(Object.keys(d),['pageId']);return {questions:[question('1','正文'),question('2','正文')]};});
 assert.equal(calls,2);assert.notEqual(legacy.contentHash,i.contentHash);
 assert(!modelRequest('recognize',{pageId:'p'}).instruction.includes('printedNumbers'));
 assert(modelRequest('recognize',{pageId:'p',segmentation:'printed-headings-v1'}).instruction.includes('不按数组位置'));
});
test('saved page repair responses replay locally in original order with no extra responses',async()=>{
 const i=await input(),payloads=[],calls=[];
 await recognizeWorkflowUnits(i,async(stage,d)=>{const value={questions:d.focusNumbers?[question('13','13. 原文'),question('14','14. 补读原文')]:d.pageId==='p1'?[question('12','12. 原文'),question('13','13. 原文')]:[question('15','15. 原文')]};
  const callId=String(calls.length);calls.push({callId,scopeId:d.pageId,stage:'recognize',status:'completed'});payloads.push(value);return value;});
 const run={contentHash:i.contentHash,mode:i.mode,calls},before=JSON.stringify(run);
 const result=await recheckSavedRecognition(i,run,async id=>({value:payloads[Number(id)],usage:{totalTokens:10}}));
 assert.equal(result.replayed,calls.length);assert.equal(JSON.stringify(run),before);assert(result.usableNumbers.includes('14'));
});
test('the original runner sends repaired neighbors to their own extraction units and records the bounded repair calls',async()=>{
 const i=await input(),s=await setupWorkflow({workspace:i.workspace,validationLevel:'minimum'}),base=s.model.call.bind(s.model),seen=[];
 s.ports.prepareUnits=(input,signal,invoke)=>recognizeWorkflowUnits(input,invoke);
 s.model.call=async(r,signal)=>{
  if(r.stage!=='recognize'){if(r.stage==='extract')seen.push(r.data.original);return base(r,signal);}
  const d=r.data,value=d.focusNumbers?{questions:[question('13','13. 基因工程独立题干'),question('14','14. 遗传独立题干')]}:
   d.pageId==='p1'?{printedNumbers:['12','13','14'],questions:[question('12','12. 独立题干'),question('13','13. 基因工程独立题干','三、非选择题','（10分）遗传题被错并')]}:{questions:[question('15','15. 独立题干')]};
  return {value,usage:{totalTokens:10}};
 };
 const run=await runWorkflow(s);assert.equal(run.state,'contentReady',run.errorCode);assert(!run.skipped.some(s=>s.sourceNumbers.includes('14')));
 assert.equal(run.calls.filter(c=>c.stage==='recognize').length,3);
 assert.equal(seen.find(o=>o.sourceNumbers[0]==='13').stem,'13. 基因工程独立题干');
 assert.equal(seen.find(o=>o.sourceNumbers[0]==='14').stem,'14. 遗传独立题干');
 assert(!run.calls.some(c=>['verifyFact','blindFill','solve'].includes(c.stage)));
});
