import test from 'node:test';
import assert from 'node:assert/strict';
import { latexToTypst,typstContent,buildPdfSources } from '../app/packages/pdf/src/index.ts';
import { exportFixture } from './pdf_export_fixture.mjs';

test('supported formulas map to safe Typst tokens',()=>{
  assert.equal(latexToTypst('E=\\frac{1}{2}mv^{2}'),'E = frac(1, 2) m v^(2)');
  assert.equal(latexToTypst('\\sqrt{x+1}'),'sqrt(x + 1)');
  assert.equal(latexToTypst('x_{i} \\leq 2'),'x_(i) <= 2');
  assert.equal(latexToTypst('\\mathrm{CO}_{2}'),'upright(C O)_(2)');
});
for(const value of ['\\unknown{x}','\\frac{1}','\\sqrt{}','#read("secret")','x$y','{'.repeat(40)+'x'+'}'.repeat(40)])test(`reject unsupported formula ${value.slice(0,20)}`,()=>assert.throws(()=>latexToTypst(value),/unsupported_formula/));
test('literal Typst syntax is quoted as text and only recognized math is parsed',()=>{
  assert.equal(typstContent('#read("secret")'), '#text("#read(\\"secret\\")")');
  assert.ok(typstContent('速度 $v=2$。').includes('$v = 2$'));
  assert.throws(()=>typstContent('公式 $\\input{secret}$'),/unsupported_formula/);
});
test('demo preview cannot lose watermark; normal export rejects mock results',async()=>{
  const {workspace,batch}=await exportFixture();
  assert.throws(()=>buildPdfSources(workspace,batch,{layout:'class',includeAnswers:true}),/mock_not_exportable/);
  const sources=buildPdfSources(workspace,batch,{layout:'class',includeAnswers:true,demoPreview:true});
  assert.equal(sources.length,1);assert.equal(sources[0].filename,'demo-class.pdf');
  assert.ok(sources[0].typst.includes('仅供排版验证 / 离线演示 / 不可分发'));
  assert.ok(sources[0].typst.includes('合成课本.pdf 第 12 页'));
  assert.ok(sources[0].typst.includes('参考答案与解析'));
});
test('all generated questions must be reviewed and adopted questions must pass self-check',async()=>{
  const {workspace,batch}=await exportFixture();batch.variants[0].review='pending';
  assert.throws(()=>buildPdfSources(workspace,batch,{layout:'class',includeAnswers:true,demoPreview:true}),/pdf_unreviewed/);
  batch.variants[0].review='approved';batch.variants[0].passed=false;
  assert.throws(()=>buildPdfSources(workspace,batch,{layout:'class',includeAnswers:true,demoPreview:true}),/pdf_failed_self_check/);
});
test('individual filenames never contain student data or paths; answer pages can be omitted',async()=>{
  const {workspace,batch}=await exportFixture();
  const sources=buildPdfSources(workspace,batch,{layout:'individual',includeAnswers:false,demoPreview:true});
  assert.deepEqual(sources.map(s=>s.filename),['demo-student-001.pdf','demo-student-002.pdf','demo-student-003.pdf']);
  assert.ok(sources.every(s=>!s.typst.includes('参考答案与解析')));
  assert.ok(sources[2].typst.includes('没有逐题判断'));
});
