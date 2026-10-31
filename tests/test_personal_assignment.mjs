import test from 'node:test';
import assert from 'node:assert/strict';
import {selectTargets,assignStudents} from '../app/packages/agent/src/workflow/assignment.ts';
import {freezeInput,digest,exportProfile} from '../app/packages/agent/src/workflow/input.ts';
import {workflowWorkspace,setupWorkflow,factCandidate} from './workflow_fixture.mjs';
import {runWorkflow} from '../app/packages/agent/src/workflow/runner.ts';
import {buildDocumentPlan} from '../app/packages/pdf/src/workflow/plan.ts';

async function fixture(maxItems=5,mode='exercise'){
 const w=workflowWorkspace(),s=w.students[0],q=s.questions[0];
 const scores=[[0,5,0,9,0],[0,10,0,10,10],[0,10,10,10,10],[0,10,10,10,10]];
 w.students=scores.map((values,i)=>({...s,id:`synthetic-${i}`,name:`合成${i}`,questions:values.map((score,j)=>({...q,number:String(j+1),label:String(j+1),fullScore:10,score,result:score===10?'correct':score===0?'incorrect':'partial_credit'}))}));
 w.students.push({...s,id:'missing',name:'无原卷合成学生',availability:'no_original_paper',reasonSource:'roster_has_origin_paper',questions:[]});
 return freezeInput({ownerId:'synthetic-personal',workspace:w,mode,validationLevel:'minimum',settings:{maxItems}});
}
const fact=(id,numbers)=>({factId:id,sourceNumbers:numbers,unitIds:numbers.map(n=>`unit-${n}`),completeStatement:`知识${id}的约定术语是目标。`,knowledgePoint:`知识${id}`,conditions:[],candidateAnswers:['目标'],evidenceRefs:[],sourceMode:'paper',reviewStatus:'unchecked',factCheck:{accurate:false,supported:false,inScope:false}});
const facts=()=>Array.from({length:5},(_,i)=>['a','b','c'].map(s=>fact(`${i+1}${s}`,[String(i+1)]))).flat();
const item=(f,mode='exercise',cost=1)=>({itemId:'i'+f.factId,factId:f.factId,sourceNumbers:f.sourceNumbers,mode,status:'draft',...(mode==='dictation'?{parts:Array.from({length:cost},(_,i)=>({type:'blank',blankId:`b${i+1}`,answer:'目标',acceptedAnswers:['目标']}))}:{})});

test('every student prioritizes unique loss, then rare loss, then personal loss percentage and numeric question order',async()=>{
 const input=await fixture(),targets=selectTargets(input,facts());
 assert.deepEqual(targets[0].rawWeakNumbers,['5','2','4','3','1']);
 assert.deepEqual(targets[1].rawWeakNumbers,['3','1']);
 assert.deepEqual(targets[0].questionPriorities.map(p=>[p.number,p.lossStudents,p.eligibleStudents]),[['5',1,4],['2',1,4],['4',1,4],['3',2,4],['1',4,4]]);
 assert.deepEqual(targets[4].rawWeakNumbers,[]);
});
test('one fact per wrong original is selected before supplementation, and supplementary rounds do not consume the first pass',async()=>{
 const limited=selectTargets(await fixture(5),facts())[0];assert.deepEqual(limited.selectedTargets,['5a','2a','4a','3a','1a']);
 const more=selectTargets(await fixture(8),facts())[0];assert.deepEqual(more.selectedTargets,['5a','2a','4a','3a','1a','5b','2b','4b']);
});
test('a shared fact covers several originals once and releases space for other wrong questions',async()=>{
 const fs=[fact('shared',['5','2']),...facts().filter(f=>!['5a','2a'].includes(f.factId))];
 const input=await fixture(4),t=selectTargets(input,fs),a=assignStudents(input,t,fs.map(f=>item(f)),fs)[0];
 assert.deepEqual(t[0].selectedTargets,['shared','4a','3a','1a']);assert.deepEqual(a.uncoveredNumbers,[]);assert.equal(a.itemIds.length,4);
});
test('small caps explicitly retain uncovered originals rather than treating excluded questions as covered',async()=>{
 const input=await fixture(2),fs=facts(),t=selectTargets(input,fs),a=assignStudents(input,t,fs.map(f=>item(f)),fs)[0];
 assert.deepEqual(t[0].selectedTargets,['5a','2a']);assert.deepEqual(a.uncoveredNumbers,['4','3','1']);assert.equal(a.itemIds.length,2);
});
test('dictation uses real blank costs and a cheaper available fact before adding a second point from the same original',async()=>{
 const input=await fixture(3,'dictation'),fs=[fact('5a',['5']),fact('2a',['2']),fact('5b',['5'])];
 const t=selectTargets(input,fs),items=[item(fs[0],'dictation',2),item(fs[1],'dictation',2),item(fs[2],'dictation',1)];
 const a=assignStudents(input,t,items,fs)[0];assert.deepEqual(a.itemIds,['i5b','i2a']);assert.equal(a.itemIds.reduce((n,id)=>n+items.find(i=>i.itemId===id).parts.length,0),3);
 assert(!a.uncoveredNumbers.includes('5'));assert(!a.uncoveredNumbers.includes('2'));
});
test('missing facts and failed generated items remain uncovered and no items from correct originals are assigned',async()=>{
 const input=await fixture(),fs=facts().filter(f=>!f.sourceNumbers.includes('2')),t=selectTargets(input,fs),items=fs.map(f=>({...item(f),status:f.sourceNumbers.includes('5')?'failed':'draft'}));
 const a=assignStudents(input,t,items,fs);assert(a[0].uncoveredNumbers.includes('2'));assert(a[0].uncoveredNumbers.includes('5'));
 assert(a[1].itemIds.every(id=>['3','1'].some(n=>fs.find(f=>'i'+f.factId===id).sourceNumbers.includes(n))));
});
test('partial scores still count as classmates losing points even when partial-credit recommendations are off',async()=>{
 const input=await fixture();input.workspace.students[1].questions[4].score=9;input.workspace.students[1].questions[4].result='partial_credit';input.workspace.settings.includePartialCredit=false;
 const t=selectTargets(input,facts())[0];assert.equal(t.questionPriorities.find(p=>p.number==='5').lossStudents,2);assert(!t.rawWeakNumbers.includes('2'));assert(!t.rawWeakNumbers.includes('4'));
});
test('legacy inputs preserve their prior score ordering and target/assignment semantics',async()=>{
 const current=await fixture(2),{assignmentVersion,contentHash,...body}=current,legacy={...body,contentHash:await digest(body)};
 const t=selectTargets(legacy,facts());assert.deepEqual(t[0].rawWeakNumbers,['1','3','5','2','4']);assert.deepEqual(t[0].selectedTargets,['1a','1b']);assert.equal(t[0].questionPriorities,undefined);
 const a=assignStudents(legacy,t,facts().map(f=>item(f)),facts())[0];assert(!a.uncoveredNumbers.includes('3'));
});
test('actual runner and exported PDFs retain per-student recommendations and original question provenance',async()=>{
 const input=await fixture(5,'dictation'),fs=facts(),s=await setupWorkflow({workspace:input.workspace,validationLevel:'minimum',settings:{maxItems:5}});
 s.ports.prepareUnits=async()=>Array.from({length:5},(_,i)=>({unitId:`unit-${i+1}`,sourceNumbers:[String(i+1)],pageIds:['page-1'],stem:`合成原题${i+1}`,material:'',options:[],availability:'usable',alignmentStatus:'recognized_by_machine'}));
 const base=s.model.call.bind(s.model);s.model.call=async(r,signal)=>r.stage==='extract'?{value:{facts:['a','b','c'].map(letter=>({...factCandidate('2'),knowledgePoint:`知识${r.data.original.sourceNumbers[0]}${letter}`,completeStatement:`知识${r.data.original.sourceNumbers[0]}${letter}的约定术语是目标。`,candidateAnswers:['目标']}))},usage:{totalTokens:10}}:base(r,signal);
 const run=await runWorkflow(s);assert.equal(run.state,'contentReady',run.errorCode);assert.deepEqual(run.assignments[0].uncoveredNumbers,[]);
 assert.equal(run.assignments[0].itemIds.length,5);assert.deepEqual(run.assignments[1].rawWeakNumbers,['3','1']);
 const profile=await exportProfile(s.input,run.runId,'individual'),plan=await buildDocumentPlan(s.input,run,profile,{syntheticPreview:true});
 const text=plan.documents[0].blocks.map(b=>b.text).join('\n');assert(text.includes('仅本人失分且本次已安排的原题：5、2、4'));assert(text.includes('对应原题 5'));
});
