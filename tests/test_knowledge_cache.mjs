import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdir,mkdtemp,writeFile,unlink} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {processKnowledge} from '../app/packages/knowledge/src/processKnowledge.ts';
import {cloudWorkflowPorts} from '../app/packages/agent/src/workflow/live.ts';
import {setupWorkflow} from './workflow_fixture.mjs';
import {runWorkflow} from '../app/packages/agent/src/workflow/runner.ts';
await mkdir(resolve('tmp/knowledge-cache-tests'),{recursive:true});
const source={id:'e'.repeat(64),name:'合成题库.pdf',pages:[{number:1,text:'1. 关于光合作用中光反应的场所，下列叙述正确的是？\nA. 类囊体膜\nB. 细胞质基质\n【答案】A\n【解析】绿色植物的光反应在类囊体膜上进行。'}]};
async function fixture(){const dir=await mkdtemp(resolve('tmp/knowledge-cache-tests/run-')),db=join(dir,'knowledge.sqlite');
 return {dir,db,call(data){const r=spawnSync('tools/storage-check/target/debug/knowledge_probe.exe',[db],{input:JSON.stringify(data)+'\n',encoding:'utf8',windowsHide:true});assert.equal(r.status,0,r.stderr);const p=JSON.parse(r.stdout);if(p.error)throw new Error(p.error);return p.value;}};
}
test('first import caches structured records; after deleting the source file fresh processes still retrieve questions, answers and explanations',async()=>{
 const s=await fixture(),path=join(s.dir,'source.pdf');await writeFile(path,'synthetic source marker');
 const imported=s.call({operation:'import',revision:0,document:processKnowledge(source)});assert.equal(imported.documents[0].processing.questionCount,1);await unlink(path);
 const listed=s.call({operation:'list'});assert.equal(listed.documents[0].processing.answerCount,1);
 const cached=s.call({operation:'processed',id:source.id});assert.equal(cached.questions[0].answer,'A');assert(cached.questions[0].explanation.includes('类囊体膜'));
 const hits=s.call({operation:'related',query:'请说明叶绿体内光反应产生ATP时的反应场所。'});assert(hits.some(h=>h.kind==='question'&&h.questionNumber==='1'&&h.text.includes('参考答案')));
 assert.throws(()=>s.call({operation:'import',revision:1,document:processKnowledge({...source,name:'改名.pdf'})}),/knowledge_duplicate/);assert.equal(s.call({operation:'list'}).revision,1);
});
test('legacy imports can process their already saved text and removal clears structured records and indexes',async()=>{
 const s=await fixture();s.call({operation:'import',revision:0,document:source});const saved=s.call({operation:'read',id:source.id});assert.equal(saved.pages[0].text,source.pages[0].text);
 const doc=processKnowledge(saved);const next=s.call({operation:'process',revision:1,id:source.id,processed:doc.processed});assert.equal(next.documents[0].processing.questionCount,1);
 s.call({operation:'remove',revision:2,id:source.id});assert.deepEqual(s.call({operation:'search',query:'光反应'}),[]);assert.equal(s.call({operation:'processed',id:source.id}),null);
});
test('imported cached questions reach first extraction in minimum mode, so skipped verification does not skip the user knowledge bank',async()=>{
 const bank=await fixture();bank.call({operation:'import',revision:0,document:processKnowledge(source)});
 const events=[],port=cloudWorkflowPorts({subject:'生物',invoke:async(command,args)=>{assert.equal(command,'search_knowledge_for_question');events.push('cached-retrieval');return bank.call({operation:'related',query:args.query});},requestKey:'unused',revision:0,modelConfigVersion:'test'});
 const s=await setupWorkflow({validationLevel:'minimum'});s.ports.retrieveForOriginal=port.retrieveForOriginal;
 const base=s.model.call.bind(s.model);s.model.call=async(r,signal)=>{if(r.stage==='extract'&&r.data.original.sourceNumbers.includes('1')){events.push('extract');assert(r.data.evidence.some(e=>e.documentId===source.id&&e.text.includes('参考答案')&&e.text.includes('解析')));}return base(r,signal);};
 const run=await runWorkflow(s);assert.equal(run.state,'contentReady',run.errorCode);assert(events.indexOf('cached-retrieval')<events.indexOf('extract'));assert(!run.calls.some(c=>c.stage==='verifyFact'));
});
