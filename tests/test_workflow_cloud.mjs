import test from 'node:test';
import assert from 'node:assert/strict';
import {freezeInput,runWorkflow,MemoryWorkflowStore} from '../app/packages/agent/src/workflow/index.ts';
import {cloudWorkflowPorts,recognizeWorkflowUnits} from '../app/packages/agent/src/workflow/live.ts';
import {mockWorkflowModel,workflowWorkspace} from './workflow_fixture.mjs';
import {transcriptionKey} from '../app/packages/agent/src/workflow/recognition.ts';
import {validateUnits} from '../app/packages/agent/src/workflow/validators.ts';
const jobId='00000000-0000-4000-8000-000000000002';
async function context(change){
  const input=await freezeInput({ownerId:'cloud-synthetic-owner',workspace:workflowWorkspace(),mode:'dictation',testScope:{questionNumbers:['2']}});
  const requests=[],model=mockWorkflowModel();let keyPresent=false,aborted;
  const invoke=async(command,args)=>{
    requests.push({command,args:structuredClone(args)});
    if(command==='workflow_begin'){keyPresent=true;return {jobId,state:'reserved'};}
    if(command==='workflow_end'){keyPresent=false;if(change?.endFailure)throw 'account_network_failed';return {charged:false};}
    if(command==='workflow_abort'){keyPresent=false;aborted?.();return;}
    if(command==='workflow_save_diagnostic'){assert.equal(keyPresent,false);return;}
    if(command==='search_knowledge')return [];
    if(command==='workflow_call_model'){
      assert.ok(keyPresent);assert.equal(args.jobId,jobId);
      const r=args.request;
      if(change?.hang){change.started?.();return new Promise((_resolve,reject)=>{aborted=()=>reject('workflow_cancelled');});}
      if(change?.authFailure)throw 'model_auth_failed';
      if(r.stage==='recognize')return {value:{questions:[{number:'2',stem:'说明细胞分化的实质。',confidence:'high'}],warnings:[]},usage:{totalTokens:20}};
      return model.call(r,new AbortController().signal);
    }
    throw new Error(`unexpected_${command}`);
  };
  const ports=cloudWorkflowPorts({invoke,requestKey:jobId,revision:1,modelConfigVersion:'synthetic-version'});
  return {input,ports,requests,keyPresent:()=>keyPresent};
}
test('real cloud adapter authorizes, independently recognizes, validates and releases without exposing a key',async()=>{
  const s=await context(),run=await runWorkflow(s);assert.equal(run.state,'contentReady');assert.equal(run.executionMode,'real');assert.equal(run.calls.length,6);
  assert.equal(run.teacherReport,null);assert.deepEqual(run.advice,[]);
  assert.equal(s.requests[0].command,'workflow_begin');assert.equal(s.requests.at(-1).command,'workflow_save_diagnostic');assert.equal(s.requests.find(r=>r.command==='workflow_end').args.outcome,'partial');
  assert.equal(s.keyPresent(),false);assert.equal(run.evidence.mappedQuestions,1);assert.equal(run.evidence.totalQuestions,2);
  assert.ok(!JSON.stringify(s.requests).includes('modelKey'));assert.ok(!JSON.stringify(run).includes('modelKey'));
  const cloud=s.requests[0].args.request;assert.equal(cloud.counts.units,1);assert.ok(!JSON.stringify(cloud).includes('模拟学生'));assert.ok(!JSON.stringify(cloud).includes('students":['));
  assert.deepEqual(s.requests.filter(r=>r.command==='workflow_call_model').map(r=>r.args.request.stage),['recognize','recognize','extract','verifyFact','cloze','blindFill']);
  const audit=s.requests.at(-1).args.report;assert.equal(audit.callCount,6);assert.equal(audit.knownTokens,440);
  assert.ok(!JSON.stringify(audit).includes('模拟学生'));assert.ok(!JSON.stringify(audit).includes('基因'));
});
test('failed cloud release still clears local credential and records release pending',async()=>{
  const s=await context({endFailure:true}),run=await runWorkflow(s);assert.equal(run.state,'contentReady');assert.equal(run.errorCode,'workflow_release_pending');assert.equal(s.keyPresent(),false);
});
test('model authentication failure ends task and clears local credential',async()=>{
  const s=await context({authFailure:true}),run=await runWorkflow(s);assert.equal(run.state,'failed');assert.equal(run.errorCode,'model_auth_failed');assert.equal(s.keyPresent(),false);
  assert.equal(s.requests.find(r=>r.command==='workflow_end').args.outcome,'failed');
});
test('cancelling pending cloud request signals native abort before release and ignores late data',async()=>{
  let start;const ready=new Promise(r=>{start=r;});const s=await context({hang:true,started:start}),controller=new AbortController();
  const pending=runWorkflow({...s,signal:controller.signal});await ready;controller.abort();const run=await pending;
  assert.equal(run.state,'cancelled');assert.equal(s.keyPresent(),false);assert.ok(s.requests.some(r=>r.command==='workflow_abort'));assert.equal(s.requests.find(r=>r.command==='workflow_end').args.outcome,'cancelled');
});

test('durable cloud pause drops credentials without finishing the job, and resume binds the original request',async()=>{
 const input=await freezeInput({ownerId:'owner',workspace:workflowWorkspace(),mode:'dictation',testScope:{questionNumbers:['2']}}),requests=[];
 const store=new MemoryWorkflowStore();store.durable=true;
 const invoke=async(command,args)=>{requests.push({command,args});if(command==='workflow_begin')return {jobId,leaseUntil:Date.now()+90000,expiresAt:Date.now()+7200000};if(command==='workflow_end'||command==='workflow_abort')return {};throw Error('unexpected');};
 const ports=cloudWorkflowPorts({invoke,requestKey:jobId,revision:1,modelConfigVersion:'v1',store});
 const binding=await ports.authorize(input,{maxCalls:40,maxTokens:2000000,maxRunMs:2700000},new AbortController().signal);
 assert.equal(binding.jobId,jobId);assert.equal(await ports.release('cancelled',{state:'cancelled'}),'suspended');
 assert.ok(requests.some(r=>r.command==='workflow_abort'));assert.ok(!requests.some(r=>r.command==='workflow_end'));
 const resumed=cloudWorkflowPorts({invoke,requestKey:jobId,revision:1,modelConfigVersion:'v1',store,resumeCloud:binding});
 await resumed.authorize(input,{maxCalls:40,maxTokens:2000000,maxRunMs:2700000},new AbortController().signal);
 assert.equal(requests.filter(r=>r.command==='workflow_begin')[1].args.request.requestKey,jobId);
 assert.equal(await resumed.release('partial',{state:'contentReady'}),'ended');
});
test('ambiguous and duplicated recognition is isolated; explicit keep-first rule never renumbers other questions',async()=>{
  const input=await freezeInput({ownerId:'owner',workspace:workflowWorkspace(),mode:'dictation',testScope:{questionNumbers:['2']}});
  const duplicate=async()=>({questions:[{number:'2',stem:'第一题完整条件',confidence:'high'},{number:'2',stem:'第二题不同条件',confidence:'high'}],warnings:[]});
  const isolated=await recognizeWorkflowUnits(input,duplicate);assert.equal(isolated[0].availability,'isolated');
  const first=await recognizeWorkflowUnits(input,duplicate,['2']);assert.equal(first[0].availability,'usable');assert.equal(first[0].stem,'第一题完整条件');assert.deepEqual(first[0].sourceNumbers,['2']);
});

test('OCR typography differences pass without loosening numbers, signs, units, negation or scripts',async()=>{
  const input=await freezeInput({ownerId:'owner',workspace:workflowWorkspace(),mode:'dictation',testScope:{questionNumbers:['2']}});
  let calls=0;const logs=[];
  const invoke=async()=>{calls++;return {questions:[{number:'2',stem:calls===1?'下列说法不正确的是：\nA．第一项；\nB．第二项。':'下列说法不正确的是:\nA. 第一项;\nB. 第二项.',confidence:'high'}],warnings:[]};};
  const units=await recognizeWorkflowUnits(input,invoke,[],c=>logs.push(c));assert.equal(units[0].availability,'usable');assert.equal(calls,2);assert.equal(logs[0].reason,'format_only');
  for(const [a,b]of[['浓度1.2mol','浓度12mol'],['增加','不增加'],['1mg','1g'],['x²','x2'],['CO₂','CO2'],['-2','2'],['1 2','12']])assert.notEqual(transcriptionKey(a),transcriptionKey(b));
});
test('warning explicitly about another question cannot block the selected complete question',async()=>{
  const input=await freezeInput({ownerId:'owner',workspace:workflowWorkspace(),mode:'dictation',testScope:{questionNumbers:['2']}});
  let calls=0;
  const units=await recognizeWorkflowUnits(input,async()=>{calls++;return {questions:[{number:'2',stem:'完整相同题干',confidence:'high'}],warnings:['第1题图片不清晰']};});
  assert.equal(calls,2);assert.equal(units[0].availability,'usable');
});

test('text-only diagram pointers and explicit ratio interval typography align without merging signs or bounds',async()=>{
  const a='条件如图所示，数量比为1：1-1：2之间。',b='条件如下图所示，数量比为1：1～1：2之间。';
  assert.equal(transcriptionKey(a),transcriptionKey(b));
  for(const [left,right]of [['浓度1-2','浓度1~2'],['比值1:1-1:2','比值1:1~1:2'],['1:1~1:2之间','1:1~1:3之间'],['-2','2'],['图甲','图乙'],['不增加','增加']])assert.notEqual(transcriptionKey(left),transcriptionKey(right));
  const input=await freezeInput({ownerId:'owner',workspace:workflowWorkspace(),mode:'dictation',testScope:{questionNumbers:['2']}});let calls=0;
  const units=await recognizeWorkflowUnits(input,async()=>({questions:[{number:'2',stem:++calls===1?a:b,confidence:'high'}],warnings:[]}));
  assert.equal(calls,2);assert.equal(units[0].availability,'usable');assert.equal(units[0].stem,a);
});
test('real disagreement triggers one targeted independent reread and keeps failed recognition diagnostics',async()=>{
  const input=await freezeInput({ownerId:'owner',workspace:workflowWorkspace(),mode:'dictation',testScope:{questionNumbers:['2']}}),requests=[],logs=[];
  const units=await recognizeWorkflowUnits(input,async(stage,data)=>{requests.push(data);return {questions:[{number:'2',stem:`条件分别是${requests.length}mg。`,confidence:'high'}],warnings:[]};},[],c=>logs.push(c));
  assert.equal(requests.length,3);assert.deepEqual(requests[2].focusNumbers,['2']);assert.equal(units[0].availability,'isolated');
  assert.equal(logs[0].reason,'content_mismatch');assert.equal(logs[0].readings.length,3);
  assert.ok(!JSON.stringify(logs).includes('条件分别'));
});
test('one malformed OCR response or out-of-scope known question does not discard two agreeing target readings',async()=>{
  const input=await freezeInput({ownerId:'owner',workspace:workflowWorkspace(),mode:'dictation',testScope:{questionNumbers:['2']}});let calls=0;
  const units=await recognizeWorkflowUnits(input,async()=>{calls++;return calls===1?{}:{questions:[{number:'1',stem:'其他题',confidence:'high'},{number:'2',stem:'目标题完整原文',confidence:'high'}],warnings:[]};});
  assert.equal(calls,3);assert.equal(units.length,1);assert.equal(units[0].sourceNumbers[0],'2');assert.equal(units[0].availability,'usable');
});
test('original OCR formulas are kept as source data; generated output must still pass renderability checks',async()=>{
  const input=await freezeInput({ownerId:'owner',workspace:workflowWorkspace(),mode:'dictation',testScope:{questionNumbers:['2']}});
  const stem='分析公式 $\\text{raw source}$ 的适用条件。';
  const units=await recognizeWorkflowUnits(input,async()=>({questions:[{number:'2',stem,confidence:'high'}],warnings:[]}));
  assert.equal(units[0].availability,'usable');assert.equal(units[0].stem,stem);
});
test('missing or low-confidence selected text cannot be promoted to usable by only one confident reading',async()=>{
  const input=await freezeInput({ownerId:'owner',workspace:workflowWorkspace(),mode:'dictation',testScope:{questionNumbers:['2']}}),logs=[];let calls=0;
  const units=await recognizeWorkflowUnits(input,async()=>{calls++;return {questions:[{number:'2',stem:'仍不清晰的题干',confidence:calls===3?'high':'low'}],warnings:[]};},[],c=>logs.push(c));
  assert.equal(units[0].availability,'isolated');assert.equal(logs[0].reason,'low_confidence');assert.equal(calls,3);
});
test('cloud audit distinguishes recognition failure from knowledge extraction and missing frozen targets',async()=>{
  const s=await context();let reads=0;
  const original=s.ports.model.call.bind(s.ports.model);
  s.ports.model.call=async(request,signal)=>request.stage==='recognize'?{value:{questions:[{number:'2',stem:`无法一致的条件${++reads}`,confidence:'high'}],warnings:[]},usage:{totalTokens:10}}:original(request,signal);
  const run=await runWorkflow(s);assert.equal(run.state,'partial');assert.equal(run.calls.length,3);assert.equal(run.facts.length,0);
  assert.equal(run.recognitionChecks[0].reason,'content_mismatch');assert.deepEqual(run.assignments[0].rawWeakNumbers,['2']);assert.deepEqual(run.assignments[0].uncoveredNumbers,['2']);
  const audit=s.requests.at(-1).args.report;assert.equal(audit.recognitions[0].status,'isolated');assert.equal(audit.skipped[0].reason,'recognition_ambiguous');
});
test('text-only OCR ignores legacy diagram metadata and never forwards diagrams to fact analysis',async()=>{
  const input=await freezeInput({ownerId:'owner',workspace:workflowWorkspace(),mode:'dictation',testScope:{questionNumbers:['2']}});let calls=0;
  const units=await recognizeWorkflowUnits(input,async()=>{calls++;return {questions:[{number:'2',stem:'根据图示，判断条件。',confidence:'high',figure:calls===1?{present:true,labels:['甲','乙']}:{present:false,labels:[]}}],warnings:[]};});
  assert.equal(calls,2);assert.equal(units[0].availability,'usable');assert.equal(units[0].figure,undefined);
  assert.equal(validateUnits([{...units[0],figure:{labels:['不得送往模型的图中标签']}}],input)[0].figure,undefined);
  const s=await context(),prior=s.ports.model.call.bind(s.ports.model),requests=[];
  s.ports.model.call=async(request,signal)=>{requests.push(structuredClone(request));const response=await prior(request,signal);if(request.stage==='recognize')response.value.questions[0].figure={present:true,labels:['甲']};return response;};
  assert.equal((await runWorkflow(s)).state,'contentReady');
  for(const r of requests.filter(r=>['extract','verifyFact'].includes(r.stage))){assert.equal(r.data.original.hasFigure,undefined);assert.equal(r.data.original.pageIds,undefined);assert.equal(r.data.original.figureLabels,undefined);assert.ok(!JSON.stringify(r.data).includes('data:image'));}
});

test('diagram-dependent text can produce no facts without guessing or invoking later model stages',async()=>{
  const s=await context(),prior=s.ports.model.call.bind(s.ports.model);
  s.ports.model.call=async(request,signal)=>request.stage==='extract'?{value:{facts:[]},usage:{totalTokens:5}}:prior(request,signal);
  const run=await runWorkflow(s);assert.equal(run.state,'partial');assert.equal(run.facts.length,0);assert.equal(run.items.length,0);
  assert.deepEqual(run.skipped,[{sourceNumbers:['2'],reason:'text_evidence_insufficient'}]);
  assert.equal(s.requests.at(-1).args.report.skipped[0].reason,'text_evidence_insufficient');
  assert.deepEqual(run.assignments[0].rawWeakNumbers,['2']);assert.deepEqual(run.assignments[0].uncoveredNumbers,['2']);
  assert.deepEqual(s.requests.filter(r=>r.command==='workflow_call_model').map(r=>r.args.request.stage),['recognize','recognize']);
  assert.equal(run.calls.filter(c=>c.stage==='extract').length,1);assert.equal(s.keyPresent(),false);
});

test('long-question text preserves all subquestions while ignoring returned diagram and table metadata',async()=>{
  const w=workflowWorkspace();
  for(const student of w.students.filter(s=>s.availability==='scored'))student.questions=[{number:'11',label:'11',score:0,fullScore:10,result:'incorrect'}];
  const input=await freezeInput({ownerId:'large-text-test',workspace:w,mode:'dictation',testScope:{questionNumbers:['11']}});
  let reads=0;
  const body='材料给出两对基因D/d、E/e，D对d完全显性。\n（1）①判断其遗传方式_____。②说明原因________。\n（2）请结合结果如下回答：突变体是____性突变，请在图中标注。';
  const units=await recognizeWorkflowUnits(input,async()=>({questions:[{number:'11',paragraphs:(++reads===1?body:body.replaceAll('_____','__________')).split('\n'),confidence:'high',
    tables:[{headers:['不得传出'],rows:[['3:1']]}],figure:{labels:['图中标签']}}],warnings:[]}));
  assert.equal(reads,2);assert.equal(units[0].availability,'usable');assert.equal(units[0].stem,body);
  assert.equal(units[0].material,'');assert.deepEqual(units[0].options,[]);
  assert.ok(!JSON.stringify(units).includes('不得传出'));assert.ok(!JSON.stringify(units).includes('3:1'));assert.ok(!JSON.stringify(units).includes('图中标签'));
  for(const changed of [body.replace('D对d','d对D'),body.replace('完全显性','不完全显性'),body.replace('②说明原因________。',''),body.replace('(2)','(3)')]){
    if(changed!==body)assert.notEqual(transcriptionKey(body),transcriptionKey(changed));
  }
  assert.notEqual(transcriptionKey('有____、____两个空'),transcriptionKey('有________一个空'));
});
