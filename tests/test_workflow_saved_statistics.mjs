import test from 'node:test';
import assert from 'node:assert/strict';
import {runWorkflow} from '../app/packages/agent/src/workflow/index.ts';
import {validateStoredTask} from '../app/packages/agent/src/workflow/persistence.ts';
import {sameStatistics} from '../app/packages/agent/src/workflow/statisticsIntegrity.ts';
import {setupWorkflow} from './workflow_fixture.mjs';

test('legacy JSON tail drift is allowed only for calculated non-integer statistics',()=>{
 assert(sameStatistics({correctRate:0.4705882352941176},{correctRate:8/17}));
 assert(sameStatistics({meanScoreRate:0.9130434782608696},{meanScoreRate:0.9130434782608695}));
 assert(!sameStatistics({correctRate:0.48},{correctRate:8/17}));
 assert(!sameStatistics({correctRate:1-Number.EPSILON},{correctRate:1}));
 assert(!sameStatistics({participantCount:8+Number.EPSILON*8},{participantCount:8}));
 assert(!sameStatistics({score:0.4705882352941176},{score:8/17}));
 assert(!sameStatistics({correctRate:Infinity},{correctRate:8/17}));
 assert(!sameStatistics({correctRate:null},{correctRate:0}));
 assert(!sameStatistics({correctRate:0.5,extra:true},{correctRate:0.5}));
});
test('saved task returns recomputed evidence without changing input, while changed counts or scores still fail',async()=>{
 const s=await setupWorkflow(),run=await runWorkflow(s);
 const task={input:s.input,run,revision:1,context:{},createdAt:0,updatedAt:1};
 const rate=task.run.evidence.questions.find(q=>q.scoreRate!==null&&!Number.isInteger(q.scoreRate));assert(rate);
 const correct=rate.scoreRate;rate.scoreRate=correct-Number.EPSILON*Math.abs(correct);
 const original=structuredClone(task),checked=await validateStoredTask(task,s.input.ownerId,run.runId);
 assert.equal(checked.run.evidence.questions.find(q=>q.questionNumber===rate.questionNumber).scoreRate,correct);assert.deepEqual(task,original);
 for(const change of [t=>{t.run.evidence.questions[0].participantCount++;},t=>{t.run.evidence.questions[0].earnedScore+=0.5;},t=>{t.run.evidence.questions[0].correctRate=0.99;}]){
  const bad=structuredClone(task);change(bad);await assert.rejects(validateStoredTask(bad,s.input.ownerId,run.runId),/workflow_storage_corrupt/);
 }
});
