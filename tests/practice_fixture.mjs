import { workspaceFromExport } from '../app/packages/core/src/index.ts';
import { runPipeline } from '../app/packages/agent/src/index.ts';
import { demoProvider } from '../app/packages/agent/src/mock.ts';
import { fixture,addUnavailable } from './core_fixture.mjs';

export async function practiceFixture() {
  const data=fixture();addUnavailable(data);
  const workspace=workspaceFromExport(data,'chrome_extension',{subjectName:'生物'});
  workspace.paper={pages:[{id:'p',name:'synthetic.png',data:'data:image/png;base64,aGVsbG8='}],questions:[{number:'2',pageId:'p',stem:'说明光合作用。',confirmed:true}]};
  workspace.practice=await runPipeline({workspace,provider:demoProvider('光合作用'),retrieve:async()=>[{documentId:'a'.repeat(64),name:'合成课本.pdf',page:12,ordinal:1,text:'光合作用的合成资料。参考 https://example.test/book'}]});
  workspace.practice.variants[0].review='approved';
  return workspace;
}
