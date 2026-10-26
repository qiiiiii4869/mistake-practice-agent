import test from 'node:test';
import assert from 'node:assert/strict';
import { runPipeline, assemble, assertAnonymous, subjectConfig, editVariant, recheckVariant, regenerateVariant } from '../app/packages/agent/src/index.ts';
import { workspaceFromExport } from '../app/packages/core/src/index.ts';
import { fixture, addUnavailable } from './core_fixture.mjs';

const evidence = {documentId:'a'.repeat(64),name:'模拟课本.pdf',page:4,ordinal:1,text:'光合作用把光能转化为化学能。'};
function workspace() {
  const d=fixture();addUnavailable(d);
  const w=workspaceFromExport(d,'chrome_extension');
  w.paper={pages:[{id:'p',name:'paper.png',data:'data:image/png;base64,aGVsbG8='}],questions:[{number:'2',pageId:'p',stem:'说明光合作用。',confirmed:true}]};
  w.settings.variantsPerQuestion=2;
  return w;
}
const annotation = (kind='text',materialGroup=null)=>({knowledgePoints:['光合作用'],keywords:['光合作用'],kind,materialGroup});
function provider({wrong=false,kind='text',group=null,quota=false}={}) {
  const calls=[];
  return {mode:'real',calls,async call(r){
    calls.push(structuredClone(r));
    if(quota)throw new Error('model_quota_exhausted');
    if(r.stage==='annotate')return annotation(kind,group);
    if(r.stage==='generate')return {exercises:Array.from({length:r.data.count},(_,i)=>({stem:`纯文字变式 ${i+1}`,options:['选项甲','选项乙'],answer:'A',explanation:'正确解析',knowledgePoints:['光合作用'],sourceIndexes:[0]}))};
    return {answer:wrong?'B':'A',complete:true,inScope:true,tooSimilar:false,explanation:'独立解答'};
  }};
}
const run = (w=workspace(),p=provider(),retrieve=async()=>[evidence],overrides)=>runPipeline({workspace:w,provider:p,retrieve,overrides});
test('calls scale by weak question and variant count, not roster; independent solving receives no answer', async()=>{
  const p=provider(),w=workspace(); const batch=await run(w,p);
  assert.deepEqual(batch.calls,{annotate:1,generate:1,solve:2});
  assert.equal(batch.variants.length,2);assert.ok(batch.variants.every(v=>v.passed&&v.review==='pending'));
  assert.equal(batch.variants[0].evidence[0].page,4);
  const serialized=JSON.stringify(p.calls);
  for(const s of w.students){assert.ok(!serialized.includes(s.id));assert.ok(!serialized.includes(s.name));}
  assert.ok(!serialized.includes(evidence.name));
  for(const r of p.calls.filter(r=>r.stage==='solve')){assert.equal(r.data.question.answer,undefined);assert.equal(r.data.question.explanation,undefined);assert.ok(!JSON.stringify(r).includes('正确解析'));}
  const second=structuredClone(w.students[0]);second.id='EXTRA';second.name='额外同学';w.students.push(second);
  assert.deepEqual((await run(w)).calls,batch.calls);
});
test('failed self-check regenerates once per variant, retains red result if still inconsistent',async()=>{
  const batch=await run(workspace(),provider({wrong:true}));
  assert.deepEqual(batch.calls,{annotate:1,generate:3,solve:4});
  assert.ok(batch.variants.every(v=>!v.passed&&v.attempts===2));
  batch.variants.forEach(v=>v.review='approved');
  assert.ok(assemble(workspace(),batch).every(s=>s.variants.length===0));
});
test('missing or unconfirmed source never generates; no retrieval hit never generates',async()=>{
  const w=workspace();w.paper.questions[0].confirmed=false;
  const skipped=await run(w);assert.equal(skipped.variants.length,0);assert.equal(skipped.calls.annotate,0);
  const empty=await run(workspace(),provider(),async()=>[]);assert.equal(empty.calls.generate,0);assert.equal(empty.skipped[0].reason,'知识库未找到依据');
});
for(const kind of ['listening','writing','practical'])test(`${kind} stays out of automatic generation`,async()=>{
  const batch=await run(workspace(),provider({kind}));assert.equal(batch.calls.generate,0);assert.equal(batch.skipped.length,1);
});
test('diagram is constrained to text; teacher overrides annotation without another model call',async()=>{
  const p=provider();const batch=await run(workspace(),p,async()=>[evidence],{'2':annotation('diagram')});
  assert.equal(batch.calls.annotate,0);assert.equal(p.calls.find(r=>r.stage==='generate').data.textOnly,true);
  assert.equal(subjectConfig('数学').diagram,'text_only');assert.equal(subjectConfig('生物').formula,'latex');
});
test('shared-material questions form one generation unit and preserve all source numbers',async()=>{
  const d=fixture();for(const s of d.data.students){s.questions[0].score=0;s.questions[0].result='incorrect';s.questions[0].lost_points=true;}
  d.summary.result_counts={correct:0,incorrect:2,partial_credit:2,not_scored:0};
  const w=workspaceFromExport(d,'chrome_extension');w.paper=workspace().paper;
  w.paper.questions.unshift({number:'1',pageId:'p',stem:'共同材料及第一小题',confirmed:true});
  const batch=await run(w,provider({kind:'shared_material',group:'reading-1'}));
  assert.equal(batch.calls.annotate,2);assert.equal(batch.calls.generate,1);
  assert.deepEqual(batch.variants[0].sourceNumbers,['1','2']);
});
test('privacy guard normalizes case, full width and invisible/space separators; output also checked',async()=>{
  for(const value of ['模拟学生甲','模 拟\u200b学 生甲'])assert.throws(()=>assertAnonymous({text:value},['模拟学生甲']),/model_privacy_blocked/);
  assert.throws(()=>assertAnonymous('ＡＬＩＣＥ',['Alice']),/model_privacy_blocked/);
  const w=workspace();w.paper.questions[0].stem+='模拟学生甲';const p=provider();
  await assert.rejects(run(w,p),/model_privacy_blocked/);assert.equal(p.calls.length,0);
  const out=provider();out.call=async()=>({...annotation(),knowledgePoints:['模拟学生乙']});
  await assert.rejects(run(workspace(),out),/model_privacy_blocked/);
});
test('evidence body names are blocked before generation; file names are not transmitted',async()=>{
  const p=provider();await assert.rejects(run(workspace(),p,async()=>[{...evidence,text:'模拟学生甲的资料'}]),/model_privacy_blocked/);
  assert.equal(p.calls.filter(r=>r.stage==='generate').length,0);
  const safe=await run(workspace(),provider(),async()=>[{...evidence,name:'模拟学生甲的课本.pdf'}]);assert.equal(safe.variants.length,2);
});
test('invalid model structures and made-up citations fail closed',async()=>{
  for(const result of [{}, {exercises:[]}, {exercises:[{stem:'x',options:[],answer:'A',explanation:'x',knowledgePoints:['x'],sourceIndexes:[99]}]}]){
    const p=provider();const base=p.call.bind(p);p.call=async r=>r.stage==='generate'?result:base(r);
    await assert.rejects(run(workspace(),p),/invalid_model_output/);
  }
});
test('quota exhaustion stops immediately without retry or follow-up calls',async()=>{
  const p=provider({quota:true});await assert.rejects(run(workspace(),p),/model_quota_exhausted/);assert.equal(p.calls.length,1);
});
test('only approved passing questions assembled, concept dedup and unavailable students respected',async()=>{
  const w=workspace(),batch=await run(w);
  assert.ok(assemble(w,batch).every(s=>s.variants.length===0));
  batch.variants.forEach(v=>v.review='approved');
  const students=assemble(w,batch);assert.equal(students[0].variants.length,1);assert.equal(students[1].variants.length,1);
  assert.equal(students[2].variants.length,0);assert.deepEqual(students[2].uncoveredNumbers,[]);
  batch.mode='mock';assert.throws(()=>assemble(w,batch),/mock_not_exportable/);assert.equal(assemble(w,batch,true)[0].variants.length,1);
});
test('changed source or teacher settings cannot reuse old reviewed generation',async()=>{
  const w=workspace(),batch=await run(w);batch.variants[0].review='approved';
  const edited=structuredClone(w);edited.paper.questions[0].stem+='补充条件';
  assert.throws(()=>assemble(edited,batch),/stale_agent_batch/);
  w.settings.maxQuestionsPerStudent=1;assert.throws(()=>assemble(w,batch),/stale_agent_batch/);
});
test('cancellation stops before next model request',async()=>{
  const controller=new AbortController(),p=provider();
  await assert.rejects(runPipeline({workspace:workspace(),provider:p,signal:controller.signal,retrieve:async()=>{controller.abort();return [evidence];}}),/agent_cancelled/);
  assert.equal(p.calls.filter(r=>r.stage==='generate').length,0);
});
test('local exact-copy detection flags a model that falsely claims the original is a new variant',async()=>{
  const w=workspace(),p=provider(),base=p.call.bind(p);
  p.call=async r=>{const result=await base(r);if(r.stage==='generate')result.exercises.forEach(e=>e.stem=w.paper.questions[0].stem);return result;};
  const batch=await run(w,p);assert.ok(batch.variants.every(v=>!v.passed));
});
test('teacher edits revoke approval and require fresh independent solution',async()=>{
  const w=workspace(),batch=await run(w);const approved={...batch.variants[0],review:'approved'};
  const edited=editVariant(approved,{stem:'修改后的变式'});assert.equal(edited.passed,false);assert.equal(edited.review,'pending');
  const p=provider();const checked=await recheckVariant(w,p,edited);assert.equal(checked.passed,true);assert.equal(checked.review,'pending');
  assert.equal(p.calls[0].data.question.answer,undefined);
  const wrong=await recheckVariant(w,p,editVariant(approved,{answer:'不一致的答案'}));assert.equal(wrong.passed,false);
});
test('single-question regeneration replaces only target and revokes approval',async()=>{
 const w=workspace(),batch=await run(w);batch.variants.forEach(v=>v.review='approved');const p=provider();
 const next=await regenerateVariant(w,batch,batch.variants[0].id,p,async()=>[evidence]);
 assert.equal(next.variants[0].id,batch.variants[0].id);assert.equal(next.variants[0].review,'pending');assert.equal(next.variants[1].review,'approved');
 assert.deepEqual(next.calls,{annotate:2,generate:2,solve:3});assert.equal(batch.variants[0].review,'approved');
});
test('regeneration quota and missing evidence preserve previous reviewed batch',async()=>{
 const w=workspace(),batch=await run(w);batch.variants[0].review='approved';
 await assert.rejects(regenerateVariant(w,batch,batch.variants[0].id,provider({quota:true}),async()=>[evidence]),/model_quota_exhausted/);
 await assert.rejects(regenerateVariant(w,batch,batch.variants[0].id,provider(),async()=>[]),/agent_regeneration_unavailable/);
 assert.equal(batch.variants[0].review,'approved');
});
