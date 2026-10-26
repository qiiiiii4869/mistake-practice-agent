import test from 'node:test';
import assert from 'node:assert/strict';
import {validateRecognition,applyRecognition} from '../app/packages/paper/src/index.ts';
const response=()=>({questions:[{number:'1',stem:'识别题干 A B C D',confidence:'low'}],warnings:['图形需核对']});
test('recognition only becomes an unconfirmed draft and preserves other questions',()=>{
 const paper={pages:[{id:'p',name:'test.png',data:'data:image/png;base64,aGVsbG8='}],questions:[{number:'1',pageId:'p',stem:'旧题干',confirmed:true},{number:'2',pageId:'p',stem:'保留题干',confirmed:true}]};
 const draft=applyRecognition(paper,'p',response(),['1','2']);
 assert.equal(draft.questions.find(q=>q.number==='1').confirmed,false);assert.equal(draft.questions.find(q=>q.number==='2').confirmed,true);assert.equal(paper.questions[0].stem,'旧题干');
});
for(const [name,mutate] of [['unknown question',r=>r.questions[0].number='999'],['duplicate number',r=>r.questions.push({...r.questions[0]})],['empty stem',r=>r.questions[0].stem=''],['invalid confidence',r=>r.questions[0].confidence='certain'],['oversize stem',r=>r.questions[0].stem='中'.repeat(20001)]])test(`recognition rejects ${name}`,()=>{const r=response();mutate(r);assert.throws(()=>validateRecognition(r,['1','2']),/invalid_paper_recognition/);});
