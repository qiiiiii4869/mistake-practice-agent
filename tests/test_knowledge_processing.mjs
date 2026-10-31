import test from 'node:test';
import assert from 'node:assert/strict';
import {processKnowledge,KNOWLEDGE_PROCESSOR_VERSION} from '../app/packages/knowledge/src/processKnowledge.ts';
const document=(...texts)=>({id:'a'.repeat(64),name:'合成题库.pdf',pages:texts.map((text,i)=>({number:i+1,text}))});
test('first import separates question stem, options, inline answer and explanation, and records topic/page metadata',()=>{
 const result=processKnowledge(document('1. 关于光合作用，正确的是（ ）\nA. 光反应产生ATP\nB. 无关陈述\n【答案】A\n【解析】光反应在类囊体膜上进行。\n2. Aa自交，显性子代中杂合子的比例为________。\n【答案】2/3\n【解析】先筛选显性子代，再计算条件概率。')).processed;
 assert.equal(result.version,KNOWLEDGE_PROCESSOR_VERSION);assert.equal(result.questions.length,2);const q=result.questions[0];
 assert.equal(q.answer,'A');assert.equal(q.options.length,2);assert(!q.stem.includes('【答案】'));assert(!q.options[1].text.includes('解析'));assert(q.explanation.includes('类囊体膜'));assert(q.knowledgePoints.length);assert.equal(q.difficulty,'unrated');
 assert(q.knowledgeNotes.some(n=>n.includes('类囊体膜')));assert(result.questions[1].taskPatterns.includes('数量与概率'));
});
test('end-of-file answers use explicit printed numbers and preserve cross-page questions',()=>{
 const r=processKnowledge(document('14. 回答下列光合作用问题。\n（1）场所是________。','（2）产物是________。\n15. 遗传概率计算题。\n参考答案\n14. 【答案】类囊体膜；ATP\n【解析】光反应产生ATP。\n15. 【答案】1/4')).processed;
 assert.equal(r.questions.length,2);assert.equal(r.questions[0].pageStart,1);assert.equal(r.questions[0].pageEnd,2);assert(r.questions[0].stem.includes('（2）'));assert(r.questions[0].answer.includes('ATP'));assert.equal(r.questions[1].answer,'1/4');
});
test('compact answer rows link by explicit numbers without inventing missing answers',()=>{
 const r=processKnowledge(document('1. 下列说法正确的是？\nA. 第一项\nB. 第二项\n2. 下列说法错误的是？\nA. 第一项\nB. 第二项\n3. 请填空________\n参考答案\n1.A 2.B')).processed;
 assert.deepEqual(r.questions.map(q=>q.answer),['A','B','']);assert(r.questions[2].warnings.includes('未识别到答案'));
});
test('explicit two-row answer tables associate only equal columns and retain answer source pages',()=>{
 const r=processKnowledge(document('1. 下列说法正确的是？\nA. 第一项\nB. 第二项\n2. 下列说法错误的是？\nA. 第一项\nB. 第二项','题号 1 2\n答案 A B')).processed;
 assert.deepEqual(r.questions.map(q=>q.answer),['A','B']);assert.deepEqual(r.questions[0].answerPages,[2]);
 const bad=processKnowledge(document('1. 填空________\n2. 填空________\n题号 1 2\n答案 A')).processed;
 assert(bad.questions.every(q=>!q.answer));assert(bad.warnings.some(w=>w.includes('列数')));
});
test('repeated printed numbers are preserved and ambiguous answer associations remain unfilled',()=>{
 const r=processKnowledge(document('1. 第一套的题目？\nA. 第一项\nB. 第二项\n1. 第二套的题目？\nA. 另一项\nB. 不同项\n参考答案\n1. A')).processed;
 assert.equal(r.questions.length,2);assert.notEqual(r.questions[0].id,r.questions[1].id);assert(r.questions.every(q=>q.answer===''));assert(r.warnings.some(w=>w.includes('无法唯一对应')));
});
test('explicit new-paper headers separate answer scopes for repeated numbering',()=>{
 const r=processKnowledge(document('1. 第一套的题目？\n【答案】A\n参考答案\n1. A\n试卷二\n1. 第二套的题目？\n参考答案\n1. B')).processed;
 assert.deepEqual(r.questions.map(q=>q.answer),['A','B']);
});
test('ordinary reference material remains a reference, and explicit reference mode does not guess questions',()=>{
 assert.equal(processKnowledge(document('光合作用把光能转化为化学能。')).processed.kind,'reference');
 const r=processKnowledge(document('1. 光合作用概念\n2. 细胞呼吸概念')).processed;assert.equal(r.kind,'reference');assert.equal(r.questions.length,0);
 assert.equal(processKnowledge(document('1. 下列说法正确的是？\n【答案】A'),'reference').processed.questions.length,0);
});
test('question-only banks and image-only gaps retain truthful missing-answer and missing-page warnings',()=>{
 const r=processKnowledge(document('10. 请根据光合作用原理填空________。',''),'question_bank').processed;
 assert.equal(r.questions[0].answer,'');assert.equal(r.questions[0].explanation,'');assert(r.warnings.some(w=>w.includes('无文字层')));
});
test('processing is deterministic, keeps scientific scripts and gene case, and does not alter the caller data',()=>{
 const d=document('4. 比较Aa、aa和CO₂的变化？\n【答案】Aa\n【解析】分析CO₂、NADPH与ATP。'),before=JSON.stringify(d);
 const a=processKnowledge(d),b=processKnowledge(d);assert.deepEqual(a,b);assert.equal(JSON.stringify(d),before);assert(a.processed.questions[0].stem.includes('CO₂'));assert.equal(a.processed.questions[0].answer,'Aa');
});
