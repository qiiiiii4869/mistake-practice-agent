import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkflowActor, actorState } from '../app/packages/agent/src/workflow/machine.ts';
import { runWorkflow, freezeInput, exportProfile, MemoryWorkflowStore } from '../app/packages/agent/src/workflow/index.ts';
import { estimateBudget, reserveCall } from '../app/packages/agent/src/workflow/budget.ts';
import { mergeFacts } from '../app/packages/agent/src/workflow/assignment.ts';
import { teachingEvidence } from '../app/packages/agent/src/workflow/teachingEvidence.ts';
import { blindFillPassed, validateCloze, validateExercise, exerciseSolvePassed,validateFacts } from '../app/packages/agent/src/workflow/validators.ts';
import { setupWorkflow, sourceUnits, mockWorkflowModel, workflowWorkspace } from './workflow_fixture.mjs';
import {workflowAudit} from '../app/packages/agent/src/workflow/diagnostics.ts';
import {priorityEvidence,partitionValidationAttempts} from '../app/packages/agent/src/workflow/teachingAdvice.ts';
import {classOverview} from '../app/packages/agent/src/workflow/teachingEvidence.ts';
import {acceptedTermAliases} from '../app/packages/agent/src/workflow/answerAliases.ts';
import {deterministicCloze,generateDictation} from '../app/packages/agent/src/workflow/strategies/dictation.ts';

for (const mode of ['dictation','exercise']) for (const library of [false,true]) {
  test(`${mode} / ${library ? 'library' : 'paper'} completes offline content and separate teacher advice`,async () => {
    const s = await setupWorkflow({ mode, library }), states = [];
    s.ports.onProgress = state => states.push(state);
    const run = await runWorkflow({ ...s, runId: 'matrix' });
    assert.equal(run.state,'contentReady'); assert.equal(run.executionMode,'mock'); assert.equal(run.mode,mode);
    assert.equal(run.facts.length,2); assert.ok(run.facts.every(f => f.sourceMode === (library ? 'library' : 'paper')));
    assert.equal(run.items.length,1); assert.ok(run.items.every(i => i.mode === mode && i.status === 'passed'));
    assert.equal(run.assignments.length,3); assert.equal(run.assignments[0].coverage,1);
    assert.equal(run.assignments[2].status,'unavailable'); assert.equal(run.assignments[2].itemIds.length,0);
    assert.equal(run.advice.length,1); assert.equal(run.advice[0].generatedBy,'model');
    assert.equal(run.evidence.rows[1].scoreRate,1/3); assert.equal(run.evidence.rows[1].lossCount,2);
    assert.equal(run.calls.length,7); assert.ok(run.calls.every(c => c.status === 'completed' && c.usage === 100));
    assert.ok(states.includes(mode === 'dictation' ? 'validatingCloze' : 'validatingExercise'));
    assert.ok(!states.includes(mode === 'dictation' ? 'generatingExercises' : 'clozing'));
    assert.ok(!states.some(x => /review|confirm|settling|completed/.test(x)));
    const requests = JSON.stringify(s.model.calls);
    for (const student of s.input.workspace.students) { assert.ok(!requests.includes(student.id)); assert.ok(!requests.includes(student.name)); }
    assert.ok(!requests.includes(s.input.ownerId));
  });
}

test('blind fill excludes answers/aliases/full fact; exercise solve excludes generated answer/explanation/rubric',async () => {
  const d = await setupWorkflow(); await runWorkflow(d);
  const blind = d.model.calls.find(c => c.stage === 'blindFill');
  assert.ok(!JSON.stringify(blind).includes('基因'));
  assert.ok(!JSON.stringify(blind.data).includes('acceptedAnswers')); assert.equal(blind.data.correction,undefined);
  const e = await setupWorkflow({ mode: 'exercise' }); await runWorkflow(e);
  const solve = e.model.calls.find(c => c.stage === 'solve');
  for (const key of ['answer','rubric','explanation','numericAnswer','fact']) assert.ok(!JSON.stringify(solve.data).includes(`"${key}"`));
});
test('same run reuses validated content; export layout changes hash without new model calls',async () => {
  const s = await setupWorkflow(), first = await runWorkflow({ ...s, runId: 'reuse' });
  const second = await runWorkflow({ ...s, runId: 'reuse' });
  assert.deepEqual(second,first); assert.equal(s.model.calls.length,7); assert.equal(s.prepareCalls,1);
  const one = await exportProfile(s.input,first.runId,'individual'), all = await exportProfile(s.input,first.runId,'combined');
  assert.notEqual(one.exportHash,all.exportHash); assert.equal(s.model.calls.length,7);
  const other = await freezeInput({ ownerId: s.input.ownerId, workspace: s.input.workspace, mode: 'exercise' });
  assert.notEqual(other.contentHash,s.input.contentHash);
  await assert.rejects(runWorkflow({ ...s, input: other, runId: 'reuse' }),/workflow_stale_run/);
});
test('caller mutation after start cannot change frozen inputs; tampered input rejected',async () => {
  const s = await setupWorkflow(), originalHash = s.input.contentHash;
  const pending = runWorkflow(s); s.input.settings.maxItems = 1;
  const run = await pending; assert.equal(run.state,'contentReady'); assert.equal(run.contentHash,originalHash);
  await assert.rejects(runWorkflow(s),/workflow_stale_input/);
});
test('generation work scales by shared target, not student count; full-score units still mapped',async () => {
  const w = workflowWorkspace();
  for (let i=0;i<20;i++) w.students.push({ ...structuredClone(w.students[0]), id: `extra-${i}`, name: `合成人员${i}` });
  const s = await setupWorkflow({ workspace: w }), run = await runWorkflow(s);
  assert.equal(run.calls.length,7); assert.equal(run.items.length,1);
  assert.equal(run.evidence.mappedQuestions,2); assert.equal(run.evidence.totalFullScore,5);
  assert.equal(run.evidence.rows[1].participantCount,22);
});
test('failed independent check repairs once, preserves selected targets, and does not assign failed item',async () => {
  const model = mockWorkflowModel((r,response) => { if (r.stage === 'blindFill') response.value.answers[0].value = '不一致'; return response; });
  const s = await setupWorkflow({ model }), run = await runWorkflow(s);
  assert.equal(run.state,'partial'); assert.equal(run.items[0].attempts,2); assert.equal(run.items[0].status,'failed');
  assert.equal(model.calls.filter(c => c.stage === 'cloze').length,2); assert.equal(model.calls.filter(c => c.stage === 'blindFill').length,2);
  assert.deepEqual(run.assignments[0].selectedTargets,['unit-2-fact-1']);
  assert.deepEqual(run.assignments[0].uncoveredTargets,['unit-2-fact-1']); assert.equal(run.assignments[0].coverage,0); assert.deepEqual(run.assignments[0].itemIds,[]);
});
test('missing recognition remains in raw weak questions and uncovered list',async () => {
  const s = await setupWorkflow(); s.ports.prepareUnits = async () => sourceUnits().slice(0,1);
  const run = await runWorkflow(s); assert.equal(run.state,'partial');
  assert.deepEqual(run.assignments[0].rawWeakNumbers,['2']); assert.deepEqual(run.assignments[0].uncoveredNumbers,['2']);
  assert.equal(run.evidence.mappedQuestions,1); assert.deepEqual(run.evidence.unmappedNumbers,['2']);
  assert.equal(run.teacherReport.mappingStatus,'partial');assert.deepEqual(run.advice,[]);
});
test('ambiguous source isolated without teacher intervention',async () => {
  const s = await setupWorkflow(); s.ports.prepareUnits = async () => sourceUnits().map(u => u.unitId === 'unit-2' ? { ...u,availability:'isolated',alignmentStatus:'ambiguous' } : u);
  const run = await runWorkflow(s); assert.equal(run.state,'partial');
  assert.ok(run.skipped.some(s => s.reason === 'recognition_ambiguous')); assert.equal(run.calls.filter(c => c.stage === 'extract').length,1);
});
test('fabricated teacher numbers repaired once then replaced by deterministic evidence template',async () => {
  const model = mockWorkflowModel((r,response) => { if (r.stage === 'guidance') response.value.advice[0].focus += '有99人确定不会'; return response; });
  const s = await setupWorkflow({ model }), run = await runWorkflow(s);
  assert.equal(run.state,'contentReady'); assert.equal(model.calls.filter(c => c.stage === 'guidance').length,2);
  assert.ok(run.advice.every(a => a.generatedBy === 'template')); assert.ok(!JSON.stringify(run.advice).includes('99'));
});
test('true zero counts, missing students excluded, and multi-question evidence deduplicates participants/losses',async () => {
  const s = await setupWorkflow(), run = await runWorkflow(s), input = structuredClone(s.input);
  for (const student of input.workspace.students.filter(x => x.availability === 'scored')) for (const q of student.questions) { q.score = 0; q.result = 'incorrect'; }
  const facts = [{ ...run.facts[0], sourceNumbers: ['1','2','2'] },{ ...run.facts[1], sourceNumbers: ['1','2'] }];
  const evidence = teachingEvidence(input,facts);
  assert.equal(evidence.mappedQuestions,2); assert.equal(evidence.mappedFullScore,5);
  for (const e of evidence.rows) { assert.equal(e.participantCount,2); assert.equal(e.lossCount,2); assert.equal(e.earnedScore,0); assert.equal(e.possibleScore,10); assert.equal(e.scoreRate,0); }
});
test('same knowledge-point name with different conditions is not merged',async () => {
  const s = await setupWorkflow(), run = await runWorkflow(s), original = run.facts[1];
  const same = { ...structuredClone(original), factId: 'same', sourceNumbers: ['1'] };
  const different = { ...structuredClone(original), factId: 'different', conditions: ['条件不同'] };
  const merged = mergeFacts([original,same,different]); assert.equal(merged.length,2); assert.deepEqual(merged[0].sourceNumbers,['2','1']);
});
test('parts reconstruction, answer leakage, empty aliases and ambiguous blind fill reject',async () => {
  const s = await setupWorkflow(), run = await runWorkflow(s), fact = run.facts[1], item = run.items[0];
  const candidate = { parts: structuredClone(item.parts), correction: item.correction };
  const wrong = structuredClone(candidate); wrong.parts[0].text += '多余';
  assert.throws(() => validateCloze(wrong,fact,'bad',1),/workflow_invalid_output/);
  const empty = structuredClone(candidate); empty.parts[1].acceptedAnswers = [];
  assert.throws(() => validateCloze(empty,fact,'bad',1),/workflow_invalid_output/);
  assert.equal(blindFillPassed({ answers: [{ blankId:'b1',value:'基因' }], ambiguous:true, missingConditions:false },item),false);
  const leakedFact = { ...fact, completeStatement:'基因的选择性表达体现基因的作用。' };
  assert.throws(() => validateCloze({ parts:[{type:'blank',blankId:'b',answer:'基因',acceptedAnswers:['基因']},{type:'text',text:'的选择性表达体现基因的作用。'}],correction:'说明' },leakedFact,'bad',1),/workflow_invalid_output/);
});
test('exercise schemas reject duplicate choices, wrong single answer sets, absent diagrams and exact copies',async () => {
  const s = await setupWorkflow({ mode:'exercise' }), run = await runWorkflow(s), item = run.items[0], fact = run.facts[1];
  for (const patch of [{ answer:['A','B'] },{ options:[{id:'A',text:'重复'},{id:'B',text:'重复'}] },{ stem:'如图所示，判断。' },{ stem:sourceUnits()[1].stem }])
    assert.throws(() => validateExercise({...item,...patch},fact,sourceUnits(),'bad',1),/workflow_invalid_output/);
  const multi = validateExercise({...item,type:'multiple_choice',answer:['A','B']},fact,sourceUnits(),'multi',1);
  assert.equal(exerciseSolvePassed({answer:['B','A'],complete:true,inScope:true,tooSimilar:false},multi),true);
  assert.equal(exerciseSolvePassed({answer:['A'],complete:true,inScope:true,tooSimilar:false},multi),false);
});
test('calculation compares controlled numeric/unit rules; short answer uses explicit independent scoring points',async () => {
  const s = await setupWorkflow({ mode:'exercise' }), run = await runWorkflow(s), item = run.items[0], fact = run.facts[1];
  const calc = validateExercise({...item,type:'calculation',options:[],answer:['2m'],numericAnswer:{value:2,unit:'m'}},fact,sourceUnits(),'calc',1);
  const valid = { complete:true,inScope:true,tooSimilar:false,numericAnswer:{value:2,unit:'m'} };
  assert.equal(exerciseSolvePassed(valid,calc),true); assert.equal(exerciseSolvePassed({...valid,numericAnswer:{value:2,unit:'cm'}},calc),false);
  const short = validateExercise({...item,type:'short_answer',options:[],answer:['解释概念'],rubric:['核心概念','限定条件']},fact,sourceUnits(),'short',1);
  assert.equal(exerciseSolvePassed({...valid,keyPoints:['限定条件','核心概念'],contradiction:false},short),true);
  assert.equal(exerciseSolvePassed({...valid,keyPoints:['核心概念'],contradiction:false},short),false);
});
test('privacy failure stops without persisting offending output',async () => {
  const model = mockWorkflowModel((r,response) => { if(r.stage === 'extract') response.value.facts[0].knowledgePoint = '模拟学生甲'; return response; });
  const s = await setupWorkflow({ model }), run = await runWorkflow({ ...s,runId:'privacy' });
  assert.equal(run.state,'failed'); assert.equal(run.errorCode,'model_privacy_blocked'); assert.equal(run.calls.length,1);
  const saved = await s.store.load(s.input.ownerId,'privacy'); assert.ok(!JSON.stringify(saved).includes('模拟学生甲'));
});
test('cancel between phases retains checkpoints; explicit resume reuses original calls and units',async () => {
  const controller = new AbortController(), s = await setupWorkflow();
  s.ports.onProgress = state => { if(state === 'selectingTargets')controller.abort(); };
  const cancelled = await runWorkflow({ ...s,runId:'resume',signal:controller.signal });
  assert.equal(cancelled.state,'cancelled'); assert.equal(cancelled.calls.length,4);
  await assert.rejects(runWorkflow({...s,runId:'resume'}),/workflow_resume_required/);
  delete s.ports.onProgress;
  const resumed = await runWorkflow({ ...s,runId:'resume',resume:true });
  assert.equal(resumed.state,'contentReady'); assert.equal(resumed.calls.length,7); assert.equal(s.prepareCalls,1);
});
test('cancellation interrupts pending request, ignores late result, and retains unknown reservation',async () => {
  const controller = new AbortController(); let resolve, started;
  const ready = new Promise(r => { started = r; });
  const model = { executionMode:'mock',call:async () => { started(); return new Promise(r => { resolve=r; }); } };
  const s = await setupWorkflow({ model }), pending = runWorkflow({ ...s,runId:'abort',signal:controller.signal });
  await ready; controller.abort(); const run = await pending;
  assert.equal(run.state,'cancelled'); assert.equal(run.calls[0].status,'unknown'); assert.ok(run.calls[0].reservedTokens > 0);
  resolve({value:{facts:[]},usage:{totalTokens:1}}); await Promise.resolve();
  assert.equal((await s.store.load(s.input.ownerId,'abort')).calls[0].status,'unknown');
  await assert.rejects(runWorkflow({...s,runId:'abort',resume:true}),/workflow_unknown_call_requires_decision/);
});
test('request timeout pauses with unknown usage and never automatically retries',async () => {
  const s = await setupWorkflow({ model:{ executionMode:'mock',call:async () => new Promise(() => {}) } });
  const run = await runWorkflow({...s,policy:{requestTimeoutMs:15}});
  assert.equal(run.state,'recoverable'); assert.equal(run.errorCode,'workflow_request_timeout'); assert.equal(run.calls.length,1); assert.equal(run.calls[0].usage,null);
});
test('budget pre-reservation stops before model invocation, unknown usage is not freed',async () => {
  const s = await setupWorkflow(); const run = await runWorkflow({...s,policy:{maxCalls:1}});
  assert.equal(run.state,'failed'); assert.equal(run.errorCode,'workflow_budget_exceeded'); assert.equal(s.model.calls.length,1);
  const policy = estimateBudget('dictation',1,2);
  assert.equal(policy.maxOutputTokens,16384);
  const reasoning=reserveCall(policy,[],'verifyFact','hash',10,1,0,1);
  assert.ok(reasoning.reservedTokens>=16384+10);
  assert.throws(() => estimateBudget('dictation',30,80),/workflow_budget_estimate_exceeded/);
  const unknown = {usage:null,reservedTokens:policy.maxTokens};
  assert.throws(() => reserveCall(policy,[unknown],'cloze','hash',10,1,0,1),/workflow_budget_exceeded/);
});
test('network failures have one retry; authentication/quota failures stop immediately',async () => {
  const model = mockWorkflowModel((r,response,m) => { if(m.calls.length === 1)throw new Error('workflow_network_error'); return response; });
  const s = await setupWorkflow({model}), run = await runWorkflow(s);
  assert.equal(run.state,'contentReady'); assert.equal(run.calls.length,8); assert.equal(run.calls[0].status,'unknown');
  for(const error of ['model_auth_failed','model_quota_exhausted']) {
    const broken = await setupWorkflow({model:mockWorkflowModel(() => { throw new Error(error); })});
    const result = await runWorkflow(broken); assert.equal(result.state,'failed'); assert.equal(result.calls.length,1); assert.equal(result.errorCode,error);
  }
});
test('duplicate start shares active task and competing task is rejected',async () => {
  let finish, started; const ready = new Promise(r => { started=r; });
  const s = await setupWorkflow(); s.ports.prepareUnits = async () => { started(); return new Promise(r => { finish=r; }); };
  const first = runWorkflow({...s,runId:'active'}); await ready;
  const duplicate = runWorkflow({...s,runId:'active'}); assert.equal(first,duplicate);
  await assert.rejects(runWorkflow({...s,runId:'other'}),/workflow_busy/);
  finish(sourceUnits()); assert.equal((await first).state,'contentReady');
});
test('memory store clones snapshots and isolates accounts',async () => {
  const s = await setupWorkflow(), run = await runWorkflow({...s,runId:'stored'});
  assert.equal(await s.store.load('different-owner','stored'),null);
  const copy = await s.store.load(s.input.ownerId,'stored'); copy.items.length=0;
  assert.equal((await s.store.load(s.input.ownerId,'stored')).items.length,run.items.length);
});
test('state machine rejects out-of-order events and serializes/restores its mode branch',() => {
  const actor = createWorkflowActor('exercise'); actor.start(); actor.send({type:'RESUME'}); assert.equal(actorState(actor),'idle');
  for(let i=0;i<11;i++)actor.send({type:'NEXT'});
  assert.equal(actorState(actor),'generatingExercises');
  const snapshot = JSON.parse(JSON.stringify(actor.getPersistedSnapshot())); actor.stop();
  const restored = createWorkflowActor('exercise',snapshot); restored.start(); restored.send({type:'NEXT'}); assert.equal(actorState(restored),'solving'); restored.stop();
});
test('no weak targets produces local overview with zero model and recognition calls',async () => {
  const w = workflowWorkspace();
  for (const s of w.students.filter(s => s.availability === 'scored')) for(const q of s.questions){q.score=q.fullScore;q.result='correct';}
  delete w.paper;
  const s = await setupWorkflow({workspace:w}), run = await runWorkflow(s);
  assert.equal(run.state,'contentReady'); assert.equal(run.calls.length,0); assert.equal(s.prepareCalls,0);
  assert.equal(run.assignments[0].status,'no_targets'); assert.equal(run.advice[0].generatedBy,'template');
});
test('live provider requires explicit authorization and release lifecycle',async () => {
  const s = await setupWorkflow(); s.ports.model.executionMode='real';
  await assert.rejects(runWorkflow(s),/workflow_authorization_required/); assert.equal(s.model.calls.length,0);
});

test('cross-mode analysis cache reuses only common stages and binds owner, library and model versions',async () => {
  const s = await setupWorkflow(); s.model.cacheKey='synthetic-model-v1';
  const first = await runWorkflow({...s,runId:'cache-dictation'}); assert.equal(first.calls.length,7);
  const exercise = await freezeInput({ownerId:s.input.ownerId,workspace:s.input.workspace,mode:'exercise'});
  const second = await runWorkflow({...s,input:exercise,runId:'cache-exercise'});
  assert.equal(second.state,'contentReady'); assert.equal(second.analysisCacheHit,true);
  assert.deepEqual(second.calls.map(c => c.stage),['exercise','solve','guidance']); assert.equal(s.prepareCalls,1);
  assert.ok(second.items.every(i => i.mode==='exercise'));
  const library = await freezeInput({ownerId:s.input.ownerId,workspace:s.input.workspace,mode:'exercise',knowledgeRevision:'different-library'});
  assert.equal((await runWorkflow({...s,input:library,runId:'new-library'})).calls.length,7);
  const other = await freezeInput({ownerId:'another-owner',workspace:s.input.workspace,mode:'exercise'});
  assert.equal((await runWorkflow({...s,input:other,runId:'new-owner'})).calls.length,7);
  s.model.cacheKey='synthetic-model-v2';
  assert.equal((await runWorkflow({...s,input:exercise,runId:'new-model'})).calls.length,7);
  await assert.rejects(runWorkflow({...s,runId:'cache-dictation'}),/workflow_stale_run/);
});
test('cache-backed run resumes without rebuilding common analysis',async () => {
  const s=await setupWorkflow();s.model.cacheKey='synthetic-model-v1';
  await runWorkflow({...s,runId:'cache-source'});
  const controller=new AbortController();s.ports.onProgress=state=>{if(state==='selectingTargets')controller.abort();};
  const input=await freezeInput({ownerId:s.input.ownerId,workspace:s.input.workspace,mode:'exercise'});
  const cancelled=await runWorkflow({...s,input,runId:'cache-resume',signal:controller.signal});
  assert.equal(cancelled.analysisCacheHit,true);assert.equal(cancelled.calls.length,0);
  delete s.ports.onProgress;
  const resumed=await runWorkflow({...s,input,runId:'cache-resume',resume:true});
  assert.equal(resumed.state,'contentReady');assert.equal(resumed.calls.length,3);assert.equal(s.prepareCalls,1);
});
test('fact check retries once and rejects unsupported facts without fake citations',async () => {
  const s=await setupWorkflow({model:mockWorkflowModel((r,response)=>{
    if(r.stage==='verifyFact')response.value.checks.forEach(c=>{c.supported=false;});return response;
  })});
  const run=await runWorkflow(s);assert.equal(run.state,'partial');assert.equal(run.facts.length,0);assert.equal(run.items.length,0);
  assert.equal(run.calls.filter(c=>c.stage==='extract').length,4);assert.equal(run.calls.filter(c=>c.stage==='verifyFact').length,4);
  assert.ok(run.assignments[0].uncoveredNumbers.includes('2'));assert.equal(run.evidence.mappedQuestions,0);
  assert.equal(run.advice[0].generatedBy,'template');
});
test('a later malformed repair cannot discard a fact that already passed independent checking',async()=>{
  let extracts=0;
  const model=mockWorkflowModel((r,response)=>{
    if(r.stage==='extract'){
      extracts++;
      if(extracts===1)response.value.facts=[response.value.facts[0],{knowledgePoint:'待修复概念',completeStatement:'待修复概念具有某种结果。',conditions:[],candidateAnswers:['结果']}];
      else response.value.facts=[{knowledgePoint:'结构错误',completeStatement:'陈述。',conditions:[],candidateAnswers:['句外答案']}];
    }
    if(r.stage==='verifyFact')response.value.checks[1].supported=false;
    return response;
  });
  const s=await setupWorkflow({model,testScope:{questionNumbers:['2']}});s.ports.prepareUnits=async()=>sourceUnits().filter(u=>u.unitId==='unit-2');
  const run=await runWorkflow(s);assert.equal(run.state,'partial');assert.equal(run.facts.length,1);assert.equal(run.facts[0].factId,'unit-2-fact-1');
  assert.equal(run.items.filter(i=>i.status==='passed').length,1);assert.equal(run.calls.filter(c=>c.stage==='verifyFact').length,1);
  assert.ok(run.validationAttempts.some(v=>v.stage==='verifyFact'&&v.reason==='fact_unsupported'));
  assert.ok(run.validationAttempts.some(v=>v.stage==='verifyFact'&&v.attempt===2&&v.reason==='invalid_structure'));
});

test('fact repair sends only rejected slots and preserves passed content and source order',async()=>{
  let extracts=0,checks=0;
  const model=mockWorkflowModel((r,response)=>{
    if(r.stage==='extract'){
      extracts++;
      const other={knowledgePoint:'光合作用',completeStatement:'光合作用将光能转化为化学能。',conditions:[],candidateAnswers:['化学能']};
      response.value.facts=extracts===1?[response.value.facts[0],other]:[other];
      if(extracts===2){assert.equal(r.data.repair.facts.length,1);assert.equal(r.data.repair.facts[0].knowledgePoint,'光合作用');assert.equal(r.data.repair.checks[0].inScope,false);}
    }
    if(r.stage==='verifyFact'){
      checks++;
      if(checks===1)response.value.checks[1].inScope=false;
      else{assert.equal(r.data.facts.length,1);assert.equal(r.data.facts[0].knowledgePoint,'光合作用');}
    }
    return response;
  });
  const s=await setupWorkflow({model,testScope:{questionNumbers:['2']}});s.ports.prepareUnits=async()=>sourceUnits().filter(u=>u.unitId==='unit-2');
  const run=await runWorkflow(s);assert.equal(run.state,'contentReady');assert.equal(run.items.filter(i=>i.status==='passed').length,2);
  assert.deepEqual(run.facts.map(f=>f.factId),['unit-2-fact-1','unit-2-fact-2']);assert.equal(extracts,2);assert.equal(checks,2);
  assert.equal(partitionValidationAttempts(run).unresolved.length,0);assert.equal(partitionValidationAttempts(run).resolved[0].reason,'fact_context_incomplete');
});

test('fact checks preserve partial success when the repair returns no usable knowledge',async()=>{
  let extracts=0;
  const model=mockWorkflowModel((r,response)=>{
    if(r.stage==='extract'){extracts++;response.value.facts=extracts===1?[response.value.facts[0],response.value.facts[0]]:[];}
    if(r.stage==='verifyFact'){response.value.checks[1].accurate=false;response.value.checks[1].supported=false;}
    return response;
  });
  const s=await setupWorkflow({model,testScope:{questionNumbers:['2']}});s.ports.prepareUnits=async()=>sourceUnits().filter(u=>u.unitId==='unit-2');
  const run=await runWorkflow(s);assert.equal(run.state,'partial');assert.equal(run.facts.length,1);assert.equal(run.items.filter(i=>i.status==='passed').length,1);
  assert.deepEqual(run.validationAttempts.map(v=>v.reason),['fact_inaccurate','fact_unsupported']);
  assert.ok(workflowAudit(run).validations.every(v=>v.stage==='verifyFact'));
});

test('coverage is measured against frozen targets and selected count limits remain explicit',async () => {
  const w=workflowWorkspace();for(const s of w.students.filter(s=>s.availability==='scored')){s.questions[0].score=0;s.questions[0].result='incorrect';}
  const model=mockWorkflowModel((r,response)=>{if(r.stage==='blindFill'&&r.data.contentId==='unit-2-fact-1')response.value.ambiguous=true;return response;});
  const s=await setupWorkflow({workspace:w,model}), run=await runWorkflow(s);
  assert.equal(run.state,'partial');assert.equal(run.assignments[0].selectedTargets.length,2);assert.equal(run.assignments[0].coverage,0.5);
  assert.equal(run.assignments[0].itemIds.length,1);assert.equal(run.assignments[0].uncoveredTargets.length,1);
  const limited=await setupWorkflow({workspace:w,settings:{maxItems:1}}), result=await runWorkflow(limited);
  assert.equal(result.assignments[0].selectedTargets.length,1);assert.equal(result.assignments[0].excludedTargets.length,1);
});
test('progress states correspond to actual mode requests across retries and multiple items',async () => {
  const w=workflowWorkspace();for(const s of w.students.filter(s=>s.availability==='scored')){s.questions[0].score=0;s.questions[0].result='incorrect';}
  let state;
  const model=mockWorkflowModel((r,response)=>{
    const expected={cloze:'clozing',blindFill:'validatingCloze',exercise:'generatingExercises',solve:'solving',guidance:'writingGuidance'};
    if(expected[r.stage])assert.equal(state,expected[r.stage]);return response;
  });
  const s=await setupWorkflow({workspace:w,model,mode:'exercise'});s.ports.onProgress=value=>{state=value;};
  const run=await runWorkflow(s);assert.equal(run.state,'contentReady');assert.equal(run.items.length,2);
});
test('unsupported generated correction is discarded before safe fallback; unsafe source material fails closed',async () => {
  const s=await setupWorkflow({model:mockWorkflowModel((r,response)=>{if(r.stage==='cloze')response.value.correction='公式 $\\input{private}$';return response;})});
  const run=await runWorkflow(s);assert.equal(run.state,'contentReady');assert.equal(run.items[0].authoring,'deterministic');assert.ok(!run.items[0].correction.includes('input'));
  const bad=await setupWorkflow();bad.ports.retrieve=async()=>[{documentId:'book',page:1,text:'<img src="https://invalid.test/x">'}];
  const failed=await runWorkflow(bad);assert.equal(failed.state,'failed');assert.equal(failed.errorCode,'workflow_invalid_output');
});
test('run deadline cannot reset on resume and unknown usage consumes the remaining budget',async () => {
  let time=0;
  const s=await setupWorkflow({model:mockWorkflowModel((r,response)=>{time=2000;delete response.usage;return response;})});s.ports.now=()=>time;
  const run=await runWorkflow({...s,runId:'deadline',policy:{maxRunMs:1000}});
  assert.equal(run.state,'recoverable');assert.equal(run.calls[0].usage,null);assert.equal(run.startedAt,0);
  const resumed=await runWorkflow({...s,runId:'deadline',resume:true});assert.equal(resumed.state,'recoverable');assert.equal(resumed.calls.length,1);
});
test('per-stage repair cap survives retries rather than restarting its count',() => {
  const policy=estimateBudget('exercise',1,2),calls=[];
  calls.push(reserveCall(policy,calls,'exercise','first',10,0,0,1,'fact'));
  calls.push(reserveCall(policy,calls,'exercise','second',10,0,0,1,'fact'));
  assert.throws(()=>reserveCall(policy,calls,'exercise','third',10,0,0,1,'fact'),/workflow_stage_budget_exceeded/);
});

test('same original can retain two valid facts and report the third failure with a stable target denominator',async()=>{
  const model=mockWorkflowModel((request,response)=>{
    if(request.stage==='extract'&&request.data.original.sourceNumbers[0]==='2')response.value.facts=[response.value.facts[0],
      {knowledgePoint:'合成知识乙',completeStatement:'合成关系乙的关键结果是乙项。',conditions:[],candidateAnswers:['乙项']},
      {knowledgePoint:'合成知识丙',completeStatement:'合成关系丙的关键结果是丙项。',conditions:[],candidateAnswers:['丙项']}];
    if(request.stage==='blindFill'&&request.data.contentId.endsWith('-2'))response.value.answers[0].value='乙项';
    if(request.stage==='cloze'&&request.data.contentId.endsWith('-3'))response.value.parts[0].text+='多余字符';
    return response;
  });
  const s=await setupWorkflow({model}),run=await runWorkflow(s);
  assert.equal(run.state,'partial');assert.equal(run.items.filter(i=>i.status==='passed').length,2);
  assert.equal(run.assignments[0].selectedTargets.length,3);assert.equal(run.assignments[0].coverage,2/3);
  assert.equal(run.assignments[0].uncoveredTargets.length,1);
  assert.deepEqual(run.validationAttempts.map(v=>[v.factId,v.stage,v.attempt,v.reason]),[
    ['unit-2-fact-3','cloze',1,'statement_not_restored'],['unit-2-fact-3','blindFill',1,'blind_fill_answer_mismatch'],
    ['unit-2-fact-3','cloze',2,'statement_not_restored'],['unit-2-fact-3','blindFill',2,'blind_fill_answer_mismatch']]);
  const audit=workflowAudit(run);assert.equal(audit.passedItems,2);assert.equal(audit.skippedItems,1);
  const raw=JSON.stringify(audit);for(const student of s.input.workspace.students){assert.ok(!raw.includes(student.name));assert.ok(!raw.includes(student.id));}
  for(const fact of run.facts){assert.ok(!raw.includes(fact.completeStatement));assert.ok(!raw.includes(fact.knowledgePoint));}
  assert.ok(!raw.includes('acceptedAnswers'));assert.ok(!raw.includes('modelKey'));
});
test('blind fill ambiguity is distinguishable from wrong answer and structure errors',async()=>{
  for(const [field,value,reason] of [['ambiguous',true,'blind_fill_ambiguous'],['missingConditions',true,'blind_fill_missing_conditions']]){
    const s=await setupWorkflow({model:mockWorkflowModel((r,response)=>{if(r.stage==='blindFill')response.value[field]=value;return response;})});
    const run=await runWorkflow(s);assert.equal(run.state,'partial');assert.equal(run.validationAttempts.filter(v=>v.stage==='blindFill').length,2);
    assert.ok(run.validationAttempts.filter(v=>v.stage==='blindFill').every(v=>v.reason===reason));
  }
});
test('safe programmatic fallback preserves failure trace and still requires independent blind fill',async()=>{
  const s=await setupWorkflow({model:mockWorkflowModel((r,response)=>{if(r.stage==='cloze'&&r.data.attempt===1)response.value.parts[0].text+='错字';return response;})});
  const run=await runWorkflow(s);assert.equal(run.state,'contentReady');assert.equal(run.items[0].attempts,1);assert.equal(run.items[0].authoring,'deterministic');
  assert.equal(run.validationAttempts.length,1);assert.equal(run.validationAttempts[0].reason,'statement_not_restored');
  assert.deepEqual(run.assignments[0].uncoveredTargets,[]);
});

test('teacher priority uses whole-class per-question correctness even when high partial scores keep score rate high',async()=>{
  const s=await setupWorkflow(),base=await runWorkflow(s),w=workflowWorkspace();
  w.settings.includePartialCredit=false;
  for(const student of w.students.filter(s=>s.availability==='scored')){student.questions[1].score=2.7;student.questions[1].result='partial_credit';}
  const input=await freezeInput({ownerId:'teacher-evidence-test',workspace:w,mode:'dictation'});
  const evidence=teachingEvidence(input,base.facts),q=evidence.questions.find(q=>q.questionNumber==='2');
  assert.equal(q.participantCount,2);assert.equal(q.correctCount,0);assert.equal(q.partialCount,2);assert.equal(q.incorrectCount,0);
  assert.equal(q.correctRate,0);assert.equal(q.scoreRate,0.9);
  assert.equal(priorityEvidence(evidence)[0].knowledgePointId,'unit-2-fact-1');
  assert.equal(evidence.questions.find(q=>q.questionNumber==='1').correctRate,1);
});
test('teacher priority preserves each original rate instead of masking weak questions with high-score questions',async()=>{
  const s=await setupWorkflow(),base=await runWorkflow(s),w=workflowWorkspace();
  for(const student of w.students.filter(s=>s.availability==='scored')){
    student.questions[0].fullScore=100;student.questions[0].score=100;student.questions[0].result='correct';
    student.questions[1].score=0;student.questions[1].result='incorrect';
  }
  const input=await freezeInput({ownerId:'teacher-evidence-test',workspace:w,mode:'dictation'});
  const facts=[{...base.facts[0],sourceNumbers:['1','2']},{...base.facts[1],sourceNumbers:['2']}],evidence=teachingEvidence(input,facts);
  assert.ok(evidence.rows[0].scoreRate>0.9);assert.ok(priorityEvidence(evidence).some(e=>e.knowledgePointId===facts[0].factId));
  assert.deepEqual(evidence.rows[0].questionStats.map(q=>q.correctRate),[1,0]);
  assert.equal(evidence.questions[1].knowledgePointIds.length,2);assert.equal(evidence.questions[1].participantCount,2);
});
test('teacher denominator excludes unavailable records and real zero remains an incorrect response',async()=>{
  const s=await setupWorkflow(),base=await runWorkflow(s),w=workflowWorkspace();
  w.students[0].questions[1].score=0;w.students[0].questions[1].result='incorrect';
  w.students[1].questions[1].score=3;w.students[1].questions[1].result='correct';
  const input=await freezeInput({ownerId:'teacher-evidence-test',workspace:w,mode:'dictation'}),evidence=teachingEvidence(input,base.facts);
  const q=evidence.questions.find(q=>q.questionNumber==='2');
  assert.equal(q.participantCount,2);assert.equal(q.correctCount,1);assert.equal(q.incorrectCount,1);assert.equal(q.correctRate,0.5);
  assert.equal(q.correctCount+q.partialCount+q.incorrectCount,q.participantCount);
});
test('unmapped original questions keep whole-class correctness without inventing knowledge points',async()=>{
  const s=await setupWorkflow(),base=await runWorkflow(s),evidence=teachingEvidence(s.input,base.facts.slice(0,1));
  assert.equal(evidence.questions.length,2);const q=evidence.questions[1];assert.equal(q.correctRate,0);assert.deepEqual(q.knowledgePointIds,[]);
  assert.deepEqual(evidence.unmappedNumbers,['2']);assert.equal(priorityEvidence(evidence).length,0);
});
test('explicit meiosis stage aliases do not merge first/second division or different phases',async()=>{
  const s=await setupWorkflow(),run=await runWorkflow(s),fact={...run.facts[1],completeStatement:'同源染色体联会发生在减数分裂I前期。',candidateAnswers:['减数分裂I前期']};
  const item=deterministicCloze(fact,'alias-test',1);assert.ok(item);
  const result=value=>({answers:[{blankId:'b1',value}],ambiguous:false,missingConditions:false});
  assert.equal(blindFillPassed(result('减数第一次分裂前期'),item),true);
  assert.equal(blindFillPassed(result('减数第二次分裂前期'),item),false);
  assert.equal(blindFillPassed(result('减数分裂I中期'),item),false);
  assert.equal(blindFillPassed(result('减数第一次分裂前期（额外解释）'),item),false);
  assert.deepEqual(acceptedTermAliases('普通术语'),['普通术语']);
});

test('canonical cloze answer is retained when model lists only equivalent wording',async()=>{
  const base=(await runWorkflow(await setupWorkflow())).facts[1];
  const fact={...base,completeStatement:'合成性状由位点甲、乙两对基因共同决定。',conditions:[],candidateAnswers:['两对基因']};
  const raw={parts:[{type:'text',text:'合成性状由位点甲、乙'},{type:'blank',blankId:'b1',answer:'两对基因',acceptedAnswers:['两对等位基因']},{type:'text',text:'共同决定。'}],correction:''};
  const item=validateCloze(raw,fact,'canonical',1);
  assert.deepEqual(item.parts[1].acceptedAnswers,['两对基因','两对等位基因']);
  assert.deepEqual(raw.parts[1].acceptedAnswers,['两对等位基因']);
  const fill=value=>({answers:[{blankId:'b1',value}],ambiguous:false,missingConditions:false});
  assert.equal(blindFillPassed(fill('两对等位基因'),item),true);
  for(const wrong of ['一对基因','三对等位基因','控制'])assert.equal(blindFillPassed(fill(wrong),item),false);
});

test('a valid single blank can retain model aliases when another blank leaks its answer',async()=>{
  const base=(await runWorkflow(await setupWorkflow())).facts[1];
  const fact={...base,completeStatement:'合成性状由两对基因控制，具有多种表现。',context:'本材料可观察到多种表现。',conditions:[],candidateAnswers:['两对基因','多种表现']};
  const requests=[];
  const invoke=async(stage,data)=>{requests.push({stage,data});
    if(stage==='cloze')return {parts:[{type:'text',text:'合成性状由'},
      {type:'blank',blankId:'b1',answer:'两对基因',acceptedAnswers:['两对等位基因']},
      {type:'text',text:'控制，具有'},{type:'blank',blankId:'b2',answer:'多种表现',acceptedAnswers:['多种表现']},{type:'text',text:'。'}],correction:''};
    return {answers:[{blankId:'b1',value:'两对等位基因'}],ambiguous:false,missingConditions:false};};
  const failures=[],item=await generateDictation(fact,invoke,{generating:async()=>{},validating:async()=>{}},failure=>failures.push(failure));
  assert.equal(item.status,'passed');assert.equal(item.authoring,'deterministic');
  assert.equal(item.parts.filter(p=>p.type==='blank').length,1);
  assert.ok(item.parts.some(p=>p.type==='text'&&p.text==='多种表现'));
  assert.deepEqual(requests.map(r=>r.stage),['cloze','blindFill']);assert.equal(failures[0].reason,'answer_visible');
  const blind=requests[1].data;assert.ok(!JSON.stringify(blind).includes('两对等位基因'));assert.ok(!JSON.stringify(blind).includes('acceptedAnswers'));
});

test('repair fallback prefers remaining knowledge candidates to arbitrary sentence words',async()=>{
  const base=(await runWorkflow(await setupWorkflow())).facts[1];
  const fact={...base,completeStatement:'合成过程通过中间步骤影响最终结果。',conditions:[],candidateAnswers:['中间步骤','最终结果']};
  const item=deterministicCloze(fact,'repair-keyword',2,['中间步骤']);
  assert.equal(item.parts.find(p=>p.type==='blank').answer,'最终结果');
  const grammar={...fact,candidateAnswers:['中间步骤'],completeStatement:'中间步骤影响体色。',context:'这里讨论体色。'};
  assert.equal(deterministicCloze(grammar,'no-grammar',2,['中间步骤']),null);
});

test('single-gap repair never bypasses exact restoration, retained conditions or independent failure',async()=>{
  const base=(await runWorkflow(await setupWorkflow())).facts[1];
  const fact={...base,completeStatement:'在限定环境下，合成机制得到目标产物。',context:'本条的限定环境保持不变。',conditions:['在限定环境下'],candidateAnswers:['目标产物']};
  for(const extra of ['', '额外字符']){
    let clozes=0,fills=0;const failures=[];
    const item=await generateDictation(fact,async(stage)=>{
      if(stage==='cloze'){clozes++;return {parts:[{type:'text',text:'在'},{type:'blank',blankId:'condition',answer:'限定环境',acceptedAnswers:['限定环境']},
        {type:'text',text:'下，合成机制得到'+extra},{type:'blank',blankId:'b1',answer:'目标产物',acceptedAnswers:['目标产物']},{type:'text',text:'。'}],correction:''};}
      fills++;return {answers:[{blankId:'b1',value:'错误产物'}],ambiguous:false,missingConditions:false};
    },{generating:async()=>{},validating:async()=>{}},v=>failures.push(v));
    assert.notEqual(item?.status,'passed');assert.equal(clozes,2);assert.equal(fills,2);
    assert.ok(failures.some(v=>v.reason==='blind_fill_answer_mismatch'));
  }
});

test('cloze rejects grammar-only verbs and open-ended examples rather than accepting coincidental blind agreement',async()=>{
  const base=(await runWorkflow(await setupWorkflow())).facts[1];
  for(const [statement,answer] of [['合成过程影响材料颜色。','影响'],['合成过程控制材料颜色。','控制'],['材料可产生色素等物质。','色素'],
    ['基因能影响体色等性状。','体色'],['基因能影响性状，如控制某种色素的沉积。','某种色素']]){
    const fact={...base,completeStatement:statement,conditions:[],candidateAnswers:[answer]},at=statement.indexOf(answer);
    assert.throws(()=>validateCloze({parts:[{type:'text',text:statement.slice(0,at)},
      {type:'blank',blankId:'b1',answer,acceptedAnswers:[answer]},{type:'text',text:statement.slice(at+answer.length)}],correction:''},fact,'generic',1),
    error=>error.reason==='non_specific_blank');
    assert.equal(deterministicCloze(fact,'generic-fallback',1),null);
  }
});

test('repair picks a knowledge-point term when candidates only describe illustrative examples',async()=>{
  const base=(await runWorkflow(await setupWorkflow())).facts[1];
  const fact={...base,knowledgePoint:'基因对性状的影响',completeStatement:'基因能影响体色等性状，如控制某种色素的沉积。',conditions:[],candidateAnswers:['体色','某种色素','沉积']};
  const item=deterministicCloze(fact,'core-term',2,['体色']);
  assert.equal(item.parts.find(p=>p.type==='blank').answer,'性状');
});

test('quantified knowledge keeps its number visible and never treats two as several',async()=>{
  const base=(await runWorkflow(await setupWorkflow())).facts[1];
  const fact={...base,completeStatement:'一种合成性状可以由两对基因共同控制。',conditions:[],candidateAnswers:['两对基因']};
  const item=deterministicCloze(fact,'retained-number',2,['两对基因']);
  assert.equal(item.parts.find(p=>p.type==='blank').answer,'基因');
  assert.equal(item.parts[0].text,'一种合成性状可以由两对');
  assert.equal(item.parts.map(p=>p.type==='text'?p.text:p.answer).join(''),fact.completeStatement);
  const raw={parts:[{type:'text',text:'一种合成性状可以由'},{type:'blank',blankId:'b1',answer:'两对基因',acceptedAnswers:['两对基因']},{type:'text',text:'共同控制。'}],correction:''};
  assert.equal(blindFillPassed({answers:[{blankId:'b1',value:'多对基因'}],ambiguous:false,missingConditions:false},validateCloze(raw,fact,'count',1)),false);
});
test('alternative cloze keyword must be an exact meaningful fragment of the same checked statement',async()=>{
  const s=await setupWorkflow(),run=await runWorkflow(s),fact={...run.facts[1],completeStatement:'同源染色体非姐妹染色单体片段交换可产生变异配子。',candidateAnswers:['同源染色体非姐妹染色单体']};
  const raw={parts:[{type:'text',text:'同源染色体非姐妹染色单体片段交换可产生'},{type:'blank',blankId:'b1',answer:'变异配子',acceptedAnswers:['变异配子']},{type:'text',text:'。'}],correction:''};
  assert.equal(validateCloze(raw,fact,'alternative',1).status,'failed');
  const forged=structuredClone(raw);forged.parts[1].answer='句外虚构答案';forged.parts[1].acceptedAnswers=['句外虚构答案'];
  assert.throws(()=>validateCloze(forged,fact,'forged',1),/workflow_invalid_output/);
});
test('blind-fill retry gets failure reason and changes position without leaking answers to independent request',async()=>{
  let fill=0;const model=mockWorkflowModel((r,response)=>{if(r.stage==='blindFill'){fill++;if(fill===1)response.value.ambiguous=true;else{const sentence=r.data.sentence;const statement='细胞分化的实质是基因的选择性表达。';const [before,after]=sentence.split('【填空b1】');response.value.answers[0].value=statement.slice(before.length,statement.length-after.length);}}return response;});
  const s=await setupWorkflow({model}),run=await runWorkflow(s);assert.equal(run.state,'contentReady');
  const clozes=model.calls.filter(r=>r.stage==='cloze');assert.equal(clozes[1].data.repair.reason,'blind_fill_ambiguous');
  assert.deepEqual(clozes[1].data.repair.avoidAnswers,['基因']);
  for(const r of model.calls.filter(r=>r.stage==='blindFill')){assert.ok(r.data.sentence.includes('【填空b1】'));assert.ok(!JSON.stringify(r).includes('acceptedAnswers'));assert.ok(!JSON.stringify(r.data).includes('repair'));}
});
test('subset tests never call or produce teacher guidance, even if several original questions are selected',async()=>{
  for(const numbers of [['2'],['1','2']]){
    const s=await setupWorkflow({testScope:{questionNumbers:numbers}}),states=[];s.ports.onProgress=state=>states.push(state);
    const run=await runWorkflow(s);assert.equal(run.teacherReport,null);assert.deepEqual(run.advice,[]);
    assert.equal(s.model.calls.filter(r=>r.stage==='guidance').length,0);assert.ok(!states.includes('writingGuidance'));
    assert.equal(run.evidence.classOverview.scoredCount,2);
  }
});
test('whole-exam guidance is generated once at the end from class distribution, all questions and knowledge map',async()=>{
  const w=workflowWorkspace();for(const s of w.students.filter(s=>s.availability==='scored')){s.questions[0].score=0;s.questions[0].result='incorrect';}
  const s=await setupWorkflow({workspace:w}),run=await runWorkflow(s),calls=s.model.calls;
  assert.equal(calls.filter(c=>c.stage==='guidance').length,1);assert.equal(calls.at(-1).stage,'guidance');
  const payload=calls.at(-1).data;assert.equal(payload.reportKind,'whole_exam_class_report');assert.equal(payload.questions.length,2);
  assert.equal(payload.knowledgeMap.length,2);assert.equal(payload.classOverview.scoredCount,2);assert.equal(payload.classOverview.rosterCount,3);
  assert.equal(run.teacherReport.generatedBy,'model');assert.equal(run.teacherReport.mappingStatus,'complete');
  assert.equal(run.teacherReport.groupActions.length,1);
  for(const student of s.input.workspace.students){assert.ok(!JSON.stringify(payload).includes(student.id));assert.ok(!JSON.stringify(payload).includes(student.name));}
});
test('score distribution uses entire exam, precise interval boundaries, real zero and no unavailable students',async()=>{
  const w=workflowWorkspace(),template=structuredClone(w.students[0]);
  w.students=[...Array.from([0,59,60,74,75,84,85,100],(score,index)=>({...structuredClone(template),id:`band-${index}`,name:`区间合成人员${index}`,
    questions:[{number:'1',label:'1',score,fullScore:100,result:score===0?'incorrect':score===100?'correct':'partial_credit'},
      {number:'2',label:'2',score:0,fullScore:0,result:'not_scored'}]})),w.students[2]];
  const input=await freezeInput({ownerId:'class-overview-test',workspace:w,mode:'dictation'}),overview=classOverview(input);
  assert.equal(overview.scoredCount,8);assert.equal(overview.notScannedCount,1);assert.equal(overview.rosterCount,9);
  assert.deepEqual(overview.scoreBands.map(b=>b.studentCount),[2,2,2,2]);assert.equal(overview.minScore,0);assert.equal(overview.maxScore,100);
  assert.equal(overview.medianScore,74.5);assert.equal(overview.meanScore,67.125);assert.equal(overview.fullScore,100);
  assert.ok(!JSON.stringify(overview).includes('band-'));assert.ok(!JSON.stringify(overview).includes('区间合成人员'));
});
test('invented grade bands in final teacher report cause bounded repair then deterministic whole-class fallback',async()=>{
  const s=await setupWorkflow({model:mockWorkflowModel((r,response)=>{if(r.stage==='guidance')response.value.groupActions[0].bandId='invented';return response;})});
  const run=await runWorkflow(s);assert.equal(s.model.calls.filter(c=>c.stage==='guidance').length,2);assert.equal(run.teacherReport.generatedBy,'template');
  assert.ok(run.teacherReport.groupActions.every(g=>g.bandId!=='invented'));assert.equal(run.teacherReport.mappingStatus,'complete');
});
test('repaired validation attempts are separated from unresolved failures without changing coverage',async()=>{
  const s=await setupWorkflow({model:mockWorkflowModel((r,response)=>{if(r.stage==='cloze')response.value.parts[0].text+='额外字符';return response;})});
  const run=await runWorkflow(s),groups=partitionValidationAttempts(run);assert.equal(run.state,'contentReady');
  assert.equal(groups.unresolved.length,0);assert.equal(groups.resolved.length,1);assert.equal(run.assignments[0].coverage,1);
});
test('verified background and retained conditions reach blind fill without leaking the missing direction',async()=>{
  const model=mockWorkflowModel((r,response)=>{
    if(r.stage==='extract')response.value.facts=[{knowledgePoint:'材料条件与变化方向',context:'材料中的片段X编码执行交换的酶。',
      completeStatement:'若片段X的基因表达受抑制，变异配子的比例下降。',conditions:['在材料给定交换机制下'],candidateAnswers:['下降']}];
    if(r.stage==='blindFill'){assert.ok(r.data.context.includes('片段X编码执行交换的酶'));assert.ok(r.data.context.includes('在材料给定交换机制下'));
      assert.ok(!r.data.context.includes('下降'));assert.deepEqual(r.data.answerFormats,[{blankId:'b1',kind:'change_direction'}]);
      response.value.answers[0].value='降低';response.value.ambiguous=false;response.value.missingConditions=false;}
    return response;
  });
  const s=await setupWorkflow({model,testScope:{questionNumbers:['2']}}),run=await runWorkflow(s);
  assert.equal(run.state,'contentReady');assert.equal(run.items[0].status,'passed');assert.ok(run.items[0].context.includes('交换机制'));
  const verified=model.calls.find(r=>r.stage==='verifyFact');assert.ok(verified.data.facts[0].context.includes('交换机制'));
  assert.equal(model.calls.filter(r=>r.stage==='guidance').length,0);
});
test('background cannot contain the blank answer or its controlled synonyms; direction polarity stays distinct',async()=>{
  const s=await setupWorkflow(),run=await runWorkflow(s),fact={...run.facts[1],context:'此处降低是材料背景的一部分。',
    completeStatement:'材料条件改变后，该比例下降。',candidateAnswers:['下降'],conditions:[]};
  const raw={parts:[{type:'text',text:'材料条件改变后，该比例'},{type:'blank',blankId:'b1',answer:'下降',acceptedAnswers:['下降']},{type:'text',text:'。'}],correction:''};
  assert.throws(()=>validateCloze(raw,fact,'leak',1),error=>error.reason==='answer_visible');
  const item=validateCloze(raw,{...fact,context:'仅给出机制背景。'},'direction',1),answer=value=>({answers:[{blankId:'b1',value}],ambiguous:false,missingConditions:false});
  assert.equal(blindFillPassed(answer('降低'),item),true);assert.equal(blindFillPassed(answer('上升'),item),false);
  assert.equal(blindFillPassed(answer('保持不变'),item),false);assert.equal(blindFillPassed(answer('下降一半'),item),false);
  assert.equal(blindFillPassed({...answer('降低'),ambiguous:true},item),false);
});
test('same statement with different explanatory material cannot share a merged fact',async()=>{
  const s=await setupWorkflow(),run=await runWorkflow(s),fact=run.facts[1];
  assert.equal(mergeFacts([{...fact,context:'材料甲'},{...fact,factId:'another',context:'材料乙'}]).length,2);
  assert.throws(()=>validateFacts({facts:[{knowledgePoint:'概念',context:'http://unexpected.invalid',completeStatement:'概念的结果是结果。',conditions:[],candidateAnswers:['结果']}]}),/workflow_invalid_output/);
});

test('a repaired fact check stays resolved when a later cloze check fails',async()=>{
  const s=await setupWorkflow(),run=await runWorkflow(s),factId=run.items[0].factId;
  run.items[0].status='failed';
  run.validationAttempts=[{factId,sourceNumbers:['2'],stage:'verifyFact',attempt:1,reason:'fact_context_incomplete'},
    {factId,sourceNumbers:['2'],stage:'blindFill',attempt:2,reason:'blind_fill_ambiguous'}];
  const groups=partitionValidationAttempts(run);
  assert.deepEqual(groups.resolved.map(v=>v.stage),['verifyFact']);assert.deepEqual(groups.unresolved.map(v=>v.stage),['blindFill']);
});
