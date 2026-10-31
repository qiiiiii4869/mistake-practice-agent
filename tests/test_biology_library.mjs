import test from 'node:test';
import assert from 'node:assert/strict';
import {biologyLibrary,searchBiology,biologyEvidence,knowledgeVersion,BIOLOGY_LIBRARY_VERSION} from '../app/packages/knowledge/src/biology.ts';
import {cloudWorkflowPorts} from '../app/packages/agent/src/workflow/live.ts';
import {runWorkflow} from '../app/packages/agent/src/workflow/index.ts';
import {modelRequest} from '../app/packages/agent/src/workflow/prompts.ts';
import {setupWorkflow} from './workflow_fixture.mjs';
import {validateEvidence} from '../app/packages/agent/src/workflow/validators.ts';
import {BIOLOGY_AUTHORING_VERSION} from '../app/packages/knowledge/src/biologyAuthoring.ts';

test('source-backed library spans five modules and methods without posing as full textbooks',()=>{
 assert.equal(biologyLibrary.cards.length,86);assert.equal(biologyLibrary.cards.flatMap(c=>c.facts).length,167);
 const sources=new Map(biologyLibrary.sources.map(s=>[s.id,s]));
 assert.equal(new Set(biologyLibrary.cards.map(c=>c.id)).size,86);
 for(const card of biologyLibrary.cards){
  assert(card.facts.length&&card.sources.length);assert(biologyLibrary.modules.some(m=>m.id===card.moduleId));
  for(const fact of card.facts){assert(fact.keyTerms.every(t=>fact.statement.includes(t)));}
  for(const ref of card.sources){assert(sources.has(ref.sourceId));assert(ref.page>0&&ref.page<=sources.get(ref.sourceId).pages);}
 }
 assert.equal(biologyLibrary.sourceIssues.length,5);assert(biologyLibrary.uncoveredTopics.length);
 assert(biologyLibrary.basis.scope.includes('不是教材全文'));
});
for(const [query,expected]of [['以光合放氧和呼吸耗氧判断净光合速率','bio-m1-photosynthesis-balance'],['PCR引物设计与扩增片段范围','bio-m5-primer-design'],['种群随机交配后筛选存活个体的概率分母','bio-m2-conditional-probability'],['mRNA含量不变，蛋白质功能是否一定不变','bio-m2-gene-expression-levels'],['胰岛素与胰高血糖素维持血糖稳态','bio-m3-glucose']])test(`topic retrieval: ${query}`,()=>{
 const cards=searchBiology(query,6);assert(cards.some(c=>c.id===expected),cards.map(c=>c.title).join(','));
 const refs=validateEvidence(biologyEvidence(query));assert(refs.length);assert(refs.every(r=>r.text.includes('非教材原文')&&r.text.includes('PDF物理第')));
});
test('irrelevant topics do not manufacture knowledge hits; returned data cannot mutate the bundle',()=>{
 assert.deepEqual(searchBiology('交流电阻抗与洛伦兹力'),[]);assert.deepEqual(searchBiology(''),[]);
 const cards=searchBiology('PCR');cards[0].title='mutated';assert.notEqual(searchBiology('PCR')[0].title,'mutated');
 assert.equal(knowledgeVersion(0,'生物学'),`0:${BIOLOGY_LIBRARY_VERSION}:${BIOLOGY_AUTHORING_VERSION}`);assert.equal(knowledgeVersion(0,'物理'),'0');
});
test('live ports retrieve standard cards before extraction and merge concept searches with local PDFs',async()=>{
 const searches=[],native=async(command,args)=>{assert.equal(command,'search_knowledge');searches.push(args.query);return [{documentId:'user-doc',page:2,text:'本机资料中的补充解释。'}];};
 const ports=cloudWorkflowPorts({invoke:native,subject:'生物',requestKey:'unused',revision:1,modelConfigVersion:'test'});
 const before=await ports.retrieveForOriginal({stem:'说明光合作用的光反应与碳反应联系。',material:'',options:[]},new AbortController().signal);
 assert(before.length);assert.equal(searches.length,0);
 const after=await ports.retrieve('光反应 碳反应',new AbortController().signal);
 assert.deepEqual(searches,['光反应','碳反应']);assert(after.some(r=>r.documentId==='user-doc'));
 assert(!cloudWorkflowPorts({invoke:native,subject:'物理',requestKey:'x',revision:1,modelConfigVersion:'test'}).retrieveForOriginal);
});
test('source cards reach extraction and verification but never the blind solver answers',async()=>{
 const s=await setupWorkflow();const events=[];
 s.ports.retrieveForOriginal=async unit=>{events.push('source:'+unit.unitId);return biologyEvidence(unit.stem,2);};
 const original=s.model.call.bind(s.model);
 s.model.call=async(r,signal)=>{events.push(r.stage);if(r.stage==='extract'){assert(r.data.evidence.length);assert(r.instruction.includes('原题用于定位'));}return original(r,signal);};
 const result=await runWorkflow(s);assert.equal(result.state,'contentReady',result.errorCode);
 assert(events.indexOf('source:unit-2')<events.indexOf('extract'));
 for(const request of s.model.calls.filter(r=>r.stage==='verifyFact'))assert(request.data.evidence.some(e=>e.text.includes('内置知识卡')));
 for(const request of s.model.calls.filter(r=>r.stage==='blindFill')){
  const data=JSON.stringify(request.data);assert(!data.includes('内置知识卡'));assert(!data.includes('acceptedAnswers'));assert(!data.includes('evidence'));
 }
 assert(result.facts.every(f=>f.sourceMode==='library'));assert(result.checkpoints.includes('source-evidence:unit-1'));
});
test('unmatched evidence does not invent citations and source retrieval failure stops before paid extraction',async()=>{
 const s=await setupWorkflow();s.ports.retrieveForOriginal=async()=>{throw new Error('storage_failed');};
 const result=await runWorkflow(s);assert.equal(result.errorCode,'storage_failed');assert.equal(s.model.calls.length,0);
 const empty=await setupWorkflow();empty.ports.retrieveForOriginal=async()=>[];
 const run=await runWorkflow(empty);assert.equal(run.state,'contentReady');assert(run.facts.every(f=>f.sourceMode==='paper'));
});
test('source-aware prompt is limited to analysis stages',()=>{
 const evidence=biologyEvidence('PCR');assert(modelRequest('extract',{subject:'生物',evidence}).instruction.includes('不要求这些基础知识逐字出现在原题'));
 assert(!modelRequest('blindFill',{subject:'生物'}).instruction.includes('本次已有知识库依据'));
});
