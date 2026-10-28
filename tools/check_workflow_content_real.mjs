// Read-only score checks; the cloze rule sample comes verbatim from the approved
// implementation plan. It is not a knowledge mapping or generated result for this class.
import {DatabaseSync} from 'node:sqlite';
import {basename,dirname,resolve} from 'node:path';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {freezeInput} from '../app/packages/agent/src/workflow/freeze.ts';
import {aggregateQuestions,buildTeachingEvidence} from '../app/packages/agent/src/workflow/teachingEvidence.ts';
import {selectTargets,assignContent} from '../app/packages/agent/src/workflow/assignment.ts';
import {parseCloze,blindFillRequest,checkBlindFill,parseExercise} from '../app/packages/agent/src/workflow/validators.ts';

if(!process.argv[2])throw new Error('Pass actual account workspace.sqlite path');
const path=resolve(process.argv[2]),before=readFileSync(path),db=new DatabaseSync(path,{readOnly:true});
const workspace=JSON.parse(db.prepare('SELECT payload FROM active_workspace WHERE id=1').get().payload);db.close();
const settings={difficulty:'same',includePartialCredit:true,partialCreditThreshold:100,maxBlanks:16,maxExercises:5,minCoverage:0.8};
const report={};
for(const mode of ['dictation','exercise']){
 const input=await freezeInput(workspace,basename(dirname(path)),mode,0,settings);
 const all=[...new Set(input.students.filter(s=>s.availability==='scored').flatMap(s=>s.questions.map(q=>q.number)))];
 const raw=input.students.filter(s=>s.availability==='scored').flatMap(s=>s.questions.filter(q=>q.fullScore>0&&q.result!=='not_scored'));
 const aggregate=aggregateQuestions(input,all);
 assert.equal(aggregate.earnedScore,raw.reduce((n,q)=>n+q.score,0));assert.equal(aggregate.possibleScore,raw.reduce((n,q)=>n+q.fullScore,0));
 assert.equal(aggregate.participantCount,input.students.filter(s=>s.availability==='scored'&&s.questions.some(q=>q.fullScore>0&&q.result!=='not_scored')).length);
 assert.equal(aggregate.lossCount,input.students.filter(s=>s.availability==='scored'&&s.questions.some(q=>q.fullScore>0&&q.result!=='not_scored'&&q.score<q.fullScore)).length);
 assert.deepEqual(aggregateQuestions(input,[...all,...all]),aggregate);
 const evidence=buildTeachingEvidence(input,[]);assert.equal(evidence.evidence.length,0);assert.deepEqual(evidence.unmappedQuestionIds,all);assert.equal(evidence.mappedPossibleScore,0);
 // No reliable knowledge targets exist yet. Every raw weak question stays uncovered.
 const selection=selectTargets(input,[]);
 const assigned=assignContent(input,[],selection,{mode,contentHash:input.contentHash,items:[]});
 assert.equal(assigned.length,input.students.length);
 for(const a of assigned){const w=input.rawWeakQuestions.find(s=>s.localStudentId===a.localStudentId);assert.deepEqual(a.uncoveredSourceNumbers,w.numbers);assert.equal(a.status,w.availability!=='scored'?'unavailable':w.numbers.length?'partial':'no_targets');}
 assert.throws(()=>assignContent(input,[],selection,{mode:mode==='dictation'?'exercise':'dictation',contentHash:input.contentHash,items:[]}),/workflow_stale_pool/);
 report[mode]={students:assigned.length,unavailable:assigned.filter(a=>a.status==='unavailable').length,partial:assigned.filter(a=>a.status==='partial').length,unmappedQuestions:evidence.unmappedQuestionIds.length};
}
// Public plan example: no student scores or actual exam mapping are attached.
const plan=readFileSync('Agent知识点挖空工作流实施计划.md','utf8');
const block=plan.match(/```json\s*(\{\s*"id": "fact-001-cloze-01"[\s\S]*?)```/);assert.ok(block);
const example=JSON.parse(block[1]);example.itemId=example.id;delete example.id;
const fact={factId:example.factId,sourceNumbers:example.sourceNumbers,knowledgePoint:'方案示例',completeStatement:example.parts.map(p=>p.type==='text'?p.text:p.answer).join(''),conditions:[],evidenceRefs:[],sourceMode:'paper',factCheck:'verified'};
const item=parseCloze(example,fact,[]);const request=JSON.stringify(blindFillRequest(item));assert.ok(!request.includes('acceptedAnswers')&&!request.includes('"answer"')&&!request.includes('correction'));
const answers=item.parts.filter(p=>p.type==='blank').map(p=>({blankId:p.blankId,text:p.answer}));
assert.equal(checkBlindFill(item,{answers,ambiguous:false,missingConditions:false},[]).status,'verified');
assert.equal(checkBlindFill(item,{answers,ambiguous:true,missingConditions:false},[]).status,'isolated');
assert.throws(()=>parseCloze({...example,checks:{structure:true}},fact,[]),/workflow_invalid_content/);
assert.throws(()=>parseCloze(example,{...fact,completeStatement:fact.completeStatement+'。'},[]),/workflow_cloze_reconstruction/);
assert.throws(()=>parseExercise({passed:true},[],[],[]),/workflow_invalid_content/);
assert.deepEqual(readFileSync(path),before);
console.log(JSON.stringify({actualScoreChecks:report,planSampleRuleChecks:true,sourceUnchanged:true,modelCalls:0,realKnowledgeMappingOrContentGenerated:false}));
