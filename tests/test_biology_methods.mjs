import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {modelRequest} from '../app/packages/agent/src/workflow/prompts.ts';
import {runWorkflow} from '../app/packages/agent/src/workflow/index.ts';
import {setupWorkflow} from './workflow_fixture.mjs';
import {PROMPT_VERSION} from '../app/packages/agent/src/workflow/types.ts';
const methods=JSON.parse(readFileSync(new URL('../app/packages/agent/src/workflow/biology-methods.json',import.meta.url),'utf8'));

test('biology methods are selected by subject and never imposed on other subjects',()=>{
 for(const stage of ['extract','verifyFact','cloze','blindFill','exercise','solve']){
  assert(modelRequest(stage,{subject:'高中生物学'}).instruction.includes(methods[stage]));
  assert(modelRequest(stage,{subject:'Biology'}).instruction.includes(methods[stage]));
  assert(!modelRequest(stage,{subject:'物理'}).instruction.includes(methods[stage]));
  assert(!modelRequest(stage,{}).instruction.includes(methods[stage]));
 }
 assert.equal(PROMPT_VERSION,'report-prompts-v11');
});

for(const mode of ['dictation','exercise'])test(`biology ${mode} carries fixed method through the real runner DTO without leaking independent answers`,async()=>{
 const s=await setupWorkflow({mode});assert(s.input.workspace.exam.subjectName.includes('生物'));
 const result=await runWorkflow(s);assert.equal(result.state,'contentReady');
 for(const stage of mode==='dictation'?['extract','verifyFact','cloze','blindFill']:['extract','verifyFact','exercise','solve']){
  const requests=s.model.calls.filter(r=>r.stage===stage);assert(requests.length);
  for(const r of requests){assert.equal(r.data.subject,s.input.workspace.exam.subjectName);assert(r.instruction.includes(methods[stage]));}
 }
 const independent=s.model.calls.find(r=>r.stage===(mode==='dictation'?'blindFill':'solve'));
 const data=JSON.stringify(independent.data);
 for(const key of ['acceptedAnswers','correction','explanation','rubric'])assert(!data.includes(`"${key}"`));
 for(const student of s.input.workspace.students)assert(!JSON.stringify(s.model.calls).includes(student.name));
});
