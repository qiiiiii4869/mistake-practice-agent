// Read-only real score snapshot. Recognition fragments below are protocol probes,
// not OCR results, student fixtures, knowledge mappings, or teaching acceptance.
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {resolve,basename,dirname} from 'node:path';
import {freezeInput} from '../app/packages/agent/src/workflow/freeze.ts';
import {parsePaperRead,alignPaperReads,createPaperAdapters} from '../app/packages/agent/src/workflow/sourceAdapters.ts';

if(!process.argv[2])throw new Error('Pass actual account workspace.sqlite path');
const path=resolve(process.argv[2]),before=readFileSync(path),db=new DatabaseSync(path,{readOnly:true});
const workspace=JSON.parse(db.prepare('SELECT payload FROM active_workspace WHERE id=1').get().payload);db.close();
const frozen=await freezeInput(workspace,basename(dirname(path)),'dictation',0,{difficulty:'same',includePartialCredit:true,partialCreditThreshold:100,maxBlanks:16,maxExercises:5,minCoverage:0.8});
const allowed=[...new Set(frozen.students.filter(s=>s.availability==='scored').flatMap(s=>s.questions.map(q=>q.number)))];
assert(allowed.length>=2);
const [n,m]=allowed;
const image='data:image/png;base64,AA=='; // never rendered or sent to a service
const input={...frozen,paperFiles:[{id:'file',name:'protocol.png',data:image}],paperExclusions:[]};
const page=(i=1)=>({id:`p${i}`,sourceFileId:'file',pageIndex:i,data:image});
const q=(number=n,changes={})=>({number,stem:'协议片段',options:[],material:'',materialGroup:null,confidence:'high',complete:true,continuesFromPreviousPage:false,continuesOnNextPage:false,...changes});
const read=(questions,warnings=[])=>parsePaperRead({questions,warnings},allowed);
const invalid={valid:false,questions:[],warnings:[],errorCode:'workflow_invalid_paper_read'};
const record=(i,reads)=>({pageId:`p${i}`,reads});
const find=(units,number=n)=>units.find(u=>u.sourceNumbers.includes(number));
let checks=0;
function run(pages,reads,source=input){return alignPaperReads(source,pages,reads);}
function status(pages,reads,expected,source=input){assert.equal(find(run(pages,reads,source)).availability,expected);checks++;}
status([page()],[record(1,[read([q()]),read([q()])])],'recognized_by_machine');
status([page()],[record(1,[read([q()]),read([q(n,{stem:'不同片段'})])])],'incomplete');
status([page()],[record(1,[read([q()]),read([q(n,{stem:'不同片段'})]),read([q()])])],'recognized_by_machine');
status([page()],[record(1,[read([q(n,{stem:'x²'})]),read([q(n,{stem:'x2'})])])],'incomplete');
status([page()],[record(1,[read([q(n,{stem:'不能'})]),read([q(n,{stem:'能'})])])],'incomplete');
status([page(),page(2)],[record(1,[read([q()]),read([q()])]),record(2,[invalid,invalid])],'incomplete');
status([page()],[record(1,[read([]),read([]),read([q()])])],'incomplete');
status([page()],[record(1,[read([q()]),read([q(n,{confidence:'low'})])])],'incomplete');
status([page()],[record(1,[read([q()],['警告']),read([q()])])],'incomplete');
status([page()],[record(1,[read([q(),q()]),read([q(),q()])])],'incomplete');
const duplicate=[record(1,[read([q(),q()]),read([q(),q()])])];
const excluded={...input,paperExclusions:[{sourceFileId:'file',pageIndex:1,number:n,occurrence:2}]};
status([page()],duplicate,'recognized_by_machine',excluded);
status([page()],[record(1,[read([q()]),read([q()])])],'incomplete',excluded);
status([page()],[record(1,[read([q()]),read([q()])])],'incomplete',{...input,paperExclusions:[{sourceFileId:'file',pageIndex:2,number:n,occurrence:1}]});
const first=q(n,{continuesOnNextPage:true}),last=q(n,{stem:'',options:['A. 协议选项'],continuesFromPreviousPage:true});
const cross=[record(1,[read([first]),read([first])]),record(2,[read([last]),read([last])])];
status([page(),page(2)],cross,'recognized_by_machine');
status([page()],[cross[0]],'incomplete');
const shared=[q(n,{material:'协议共用材料',materialGroup:'g'}),q(m,{material:'协议共用材料',materialGroup:'g'})];
const merged=run([page()],[record(1,[read(shared),read(shared)])]);
assert.deepEqual(find(merged).sourceNumbers,[n,m]);checks++;
const conflict=[shared[0],{...shared[1],material:'冲突材料'}];
status([page()],[record(1,[read(conflict),read(conflict)])],'incomplete');
assert.throws(()=>run([page(),page(2)],[record(1,[read([]),read([])]),record(1,[read([]),read([])])]));checks++;
assert.throws(()=>run([page(),page(3)],[record(1,[read([]),read([])]),record(3,[read([]),read([])])]));checks++;
assert.throws(()=>parsePaperRead({questions:[{...q(),extra:true}],warnings:[]},allowed));checks++;
let calls=0;
const adapters=createPaperAdapters({resources:async()=>({typst:true,font:true,outputWritable:true}),render:async p=>p,maxCallTokens:10,
 recognize:async()=>{calls++;return {value:{questions:[q()],warnings:[]},usage:1};}});
const ctx={input,profile:{},signal:new AbortController().signal,outputs:{rendering:{value:{pages:[page()]}}},callModel:async(id,hash,budget,perform)=>(await perform()).value};
const recognized=await adapters.recognizing(ctx);assert.equal(calls,2);
const aligned=await adapters.aligning({...ctx,outputs:{...ctx.outputs,recognizing:recognized}});
assert.equal(calls,2);assert.equal(find(aligned.value.units).availability,'recognized_by_machine');assert.equal(find(aligned.value.units).recognitionChecks.readHashes.length,2);checks++;
const conflictResult={value:{reads:[record(1,[read([q()]),read([q(n,{stem:'冲突片段'})])])]}};
await adapters.aligning({...ctx,outputs:{...ctx.outputs,recognizing:conflictResult}});assert.equal(calls,3);checks++;
const corrupted={value:{reads:[record(1,[{valid:true,errorCode:null,questions:'bad',warnings:[]},read([q()])])]}};
await assert.rejects(adapters.aligning({...ctx,outputs:{...ctx.outputs,recognizing:corrupted}}),/workflow_invalid_paper_read/);assert.equal(calls,3);checks++;
const empty=run([page()],[record(1,[read([]),read([])])]);
assert.deepEqual(empty.flatMap(u=>u.sourceNumbers).sort(),[...allowed].sort());assert(empty.every(u=>u.availability==='incomplete'));checks++;
assert.deepEqual(readFileSync(path),before);
console.log(JSON.stringify({checks,students:frozen.students.length,questionNumbers:allowed.length,sourceDatabaseUnchanged:true,realModelCalls:0,cloudCalls:0,teachingContentGenerated:0}));
