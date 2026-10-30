import test from 'node:test';
import assert from 'node:assert/strict';
import {workflowPdfFixture} from './workflow_pdf_fixture.mjs';
import {exportProfile} from '../app/packages/agent/src/workflow/index.ts';
import {buildDocumentPlan,renderDocument} from '../app/packages/pdf/src/workflow/plan.ts';

for(const mode of ['dictation','exercise'])for(const layout of ['individual','combined'])test(`document plan ${mode}/${layout} preserves every owner and separates teacher and answers`,async()=>{
  const s=await workflowPdfFixture(mode),profile=await exportProfile(s.input,s.run.runId,layout,true),plan=await buildDocumentPlan(s.input,s.run,profile,{syntheticPreview:true});
  assert.equal(plan.documents.length,layout==='individual'?4:2);
  assert.equal(plan.documents.filter(d=>d.role==='teacher').length,1);
  assert.deepEqual(plan.documents.filter(d=>d.role==='student').flatMap(d=>d.ownerIds),s.input.workspace.students.map(s=>s.id));
  for(const doc of plan.documents.filter(d=>d.role==='student')){
    assert.ok(doc.blocks.every(b=>b.role!=='teacher'&&doc.ownerIds.includes(b.ownerId)));
    for(const owner of doc.ownerIds){const a=s.run.assignments.find(a=>a.localStudentId===owner);
      assert.deepEqual([...new Set(doc.blocks.filter(b=>b.ownerId===owner&&b.role==='practice'&&b.itemId).map(b=>b.itemId))],a.itemIds);
      assert.deepEqual([...new Set(doc.blocks.filter(b=>b.ownerId===owner&&b.role==='answers'&&b.itemId).map(b=>b.itemId))],a.itemIds);
    }
    assert.match(renderDocument(plan,doc),/不可分发/);
  }
});

test('mock, incomplete and scoped results cannot become formal PDF deliveries',async()=>{
  const s=await workflowPdfFixture(),p=await exportProfile(s.input,s.run.runId,'combined',true);
  await assert.rejects(buildDocumentPlan(s.input,s.run,p),/pdf_mock_not_exportable/);
  for(const change of [r=>r.state='partial',r=>r.teacherReport=null,r=>r.items[0].checks.independent=false,r=>r.assignments[0].itemIds=[],r=>r.evidence.questions[0].correctCount++]){
    const r=structuredClone(s.run);change(r);await assert.rejects(buildDocumentPlan(s.input,r,p,{syntheticPreview:true}));
  }
});

test('no-answer exports contain only practice blocks while preserving structured answers locally',async()=>{
  const s=await workflowPdfFixture('dictation'),before=JSON.stringify(s.run),p=await exportProfile(s.input,s.run.runId,'combined',false);
  const plan=await buildDocumentPlan(s.input,s.run,p,{syntheticPreview:true});
  assert.ok(plan.documents.filter(d=>d.role==='student').every(d=>d.blocks.every(b=>b.role==='practice')));
  assert.equal(JSON.stringify(s.run),before);assert.ok(s.run.items.every(i=>i.parts.some(p=>p.type==='blank'&&p.answer)));
  const source=renderDocument(plan,plan.documents[0]);assert.ok(!source.includes('acceptedAnswers'));assert.ok(!source.includes('甲项'));
});

test('layout changes reuse content and keep export hashes distinct; stale settings reject',async()=>{
  const s=await workflowPdfFixture(),count=s.model.calls.length,a=await exportProfile(s.input,s.run.runId,'combined',true),b=await exportProfile(s.input,s.run.runId,'individual',true);
  const x=await buildDocumentPlan(s.input,s.run,a,{syntheticPreview:true}),y=await buildDocumentPlan(s.input,s.run,b,{syntheticPreview:true});
  assert.equal(x.contentHash,y.contentHash);assert.notEqual(x.exportHash,y.exportHash);assert.equal(s.model.calls.length,count);
  await assert.rejects(buildDocumentPlan(s.input,s.run,{...a,includeAnswers:false},{syntheticPreview:true}),/pdf_stale_profile/);
});

test('long dictation keeps each gap once, and raw Typst is printed as literal data',async()=>{
  const s=await workflowPdfFixture('dictation',{stress:true}),p=await exportProfile(s.input,s.run.runId,'combined',true);
  const plan=await buildDocumentPlan(s.input,s.run,p,{syntheticPreview:true});
  for(const a of s.run.assignments){for(const itemId of a.itemIds){
    const blocks=plan.documents[0].blocks.filter(b=>b.ownerId===a.localStudentId&&b.itemId===itemId&&b.role==='practice');
    const item=s.run.items.find(i=>i.itemId===itemId);
    assert.deepEqual(blocks.flatMap(b=>b.blankIds??[]),item.parts.flatMap(p=>p.type==='blank'?[p.blankId]:[]));
  }}
  const doc=structuredClone(plan.documents[0]);doc.blocks[1].text='#read("private.txt")';
  assert.ok(renderDocument(plan,doc).includes('#text("#read(\\"private.txt\\")")'));
});
