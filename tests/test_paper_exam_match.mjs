import test from 'node:test';
import assert from 'node:assert/strict';
import {workflowWorkspace,setupWorkflow} from './workflow_fixture.mjs';
import {freezeInput,runWorkflow} from '../app/packages/agent/src/workflow/index.ts';
import {paperExamMatch} from '../app/packages/paper/src/examMatch.ts';
test('explicitly different exam and paper weeks are rejected, while missing metadata is not guessed',()=>{
 const w=workflowWorkspace();w.exam.name='高三生物第八周周练';w.paper.pages[0].name='第三周周练.pdf';
 assert.deepEqual(paperExamMatch(w),{examWeek:8,paperWeeks:[3],mismatch:true});
 for(const name of ['第8周周练.pdf','第八周周练.pdf · 第1页','第８周周练.pdf']){w.paper.pages[0].name=name;assert.equal(paperExamMatch(w).mismatch,false);}
 w.paper.pages[0].name='空白卷.pdf';assert.deepEqual(paperExamMatch(w),{examWeek:8,paperWeeks:[],mismatch:false});
 w.exam.name='高三生物周练';w.paper.pages[0].name='第三周周练.pdf';assert.equal(paperExamMatch(w).mismatch,false);
});
test('mismatched source materials stop before authorization and model calls without altering originals',async()=>{
 const s=await setupWorkflow();const workspace=structuredClone(s.input.workspace);workspace.exam.name='高三生物第八周周练';workspace.paper.pages[0].name='第三周周练.pdf';
 const input=await freezeInput({ownerId:s.input.ownerId,workspace,mode:'dictation'});let authorizations=0;s.ports.authorize=async()=>{authorizations++;};
 await assert.rejects(runWorkflow({...s,input}),/workflow_paper_exam_mismatch/);assert.equal(authorizations,0);assert.equal(s.model.calls.length,0);assert.equal(workspace.paper.pages[0].name,'第三周周练.pdf');
});
