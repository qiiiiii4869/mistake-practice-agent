import test from 'node:test';
import assert from 'node:assert/strict';
import { preparePaper } from '../app/packages/agent/src/preparePaper.ts';
import { workspaceFromExport } from '../app/packages/core/src/index.ts';
import { fixture, addUnavailable } from './core_fixture.mjs';
function workspace(){const d=fixture();addUnavailable(d);const w=workspaceFromExport(d,'chrome_extension');w.paper={pages:[{id:'p',name:'paper.png',data:'data:image/png;base64,aGVsbG8='}],questions:[]};return w;}
const response=()=>({questions:[{number:'2',stem:'完整题干及选项',confidence:'high'}],warnings:[]});
test('generation prepares uploaded paper only on invocation, with two independent reads and no mutations',async()=>{
 const w=workspace(), calls=[];const paper=await preparePaper(w,async id=>{calls.push(id);return response();},()=>{});
 assert.deepEqual(calls,['p','p']);assert.equal(paper.questions[0].confirmed,true);assert.deepEqual(w.paper.questions,[]);
});
for(const kind of ['uncertain','different','warnings','missing','quota','cancel'])test(`paper preparation stops before generation on ${kind}`,async()=>{
 const w=workspace();let count=0;const controller=new AbortController();
 await assert.rejects(preparePaper(w,async()=>{count++;const r=response();if(kind==='quota')throw new Error('model_quota_exhausted');if(kind==='uncertain')r.questions[0].confidence='low';if(kind==='different'&&count===2)r.questions[0].stem='另一个题干';if(kind==='warnings')r.warnings=['跨页内容不完整'];if(kind==='missing')r.questions=[];if(kind==='cancel')controller.abort();return r;},()=>{},controller.signal),/paper_check_required|paper_questions_missing|model_quota_exhausted|agent_cancelled/);
 assert.deepEqual(w.paper.questions,[]);if(kind==='quota'||kind==='cancel')assert.equal(count,1);
});
