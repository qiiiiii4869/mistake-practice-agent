import { workspaceFromExport } from '../app/packages/core/src/index.ts';
import { runPipeline } from '../app/packages/agent/src/index.ts';
import { demoProvider } from '../app/packages/agent/src/mock.ts';
import { fixture, addUnavailable } from './core_fixture.mjs';

export async function exportFixture() {
  const data=fixture();addUnavailable(data,'no_original_paper');
  const workspace=workspaceFromExport(data,'chrome_extension',{name:'合成数据排版检查',subjectName:'生物',className:'模拟班级'});
  workspace.paper={pages:[{id:'p',name:'synthetic.png',data:'data:image/png;base64,aGVsbG8='}],questions:[{number:'2',pageId:'p',stem:'说明光合作用。',confirmed:true}]};
  const batch=await runPipeline({workspace,provider:demoProvider('光合作用'),retrieve:async()=>[{documentId:'a'.repeat(64),name:'合成课本.pdf',page:12,ordinal:1,text:'光合作用与能量转换的合成资料。'}]});
  batch.variants[0].review='approved';
  batch.variants[0].stem='【合成排版测试，非正式题】说明光合作用的能量转换，并计算 $E=\\frac{1}{2}mv^{2}$。\n请在下方写出推理过程。特殊字符按文字显示：#read("private.txt")。';
  batch.variants[0].options=['光能转化为化学能','化学能全部转化为热能'];
  batch.variants[0].answer='A；$x=\\frac{1}{2}$';
  batch.variants[0].explanation='此页仅验证中文、选项、公式和来源排版，不用于教学。公式示例 $a^{2}+b^{2}=c^{2}$，根式 $\\sqrt{x+1}$。';
  return {workspace,batch};
}
