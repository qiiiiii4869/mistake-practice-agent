"""Deferred paper processing, all files and model responses are synthetic."""
import base64,json
from functools import partial
from http.server import ThreadingHTTPServer
from threading import Thread
from playwright.sync_api import expect,sync_playwright
from check_desktop_ui import MOCK,QuietHandler,ROOT
from check_agent_ui import workspace,EXTRA
from check_deepseek_ui import DEEPSEEK_MOCK

VISION=r"""
window.testVisionMode='ok';window.testVisionCount=0;window.testEvents=[];
const deferredPrior=window.__TAURI_INTERNALS__.invoke;
window.__TAURI_INTERNALS__.invoke=async(command,args)=>{
 if(command==='call_deepseek')testEvents.push(args.request.stage);
 if(command==='save_workspace')testEvents.push('save_workspace');
 if(command==='call_deepseek'&&args.request.stage==='recognize_paper'){
  testVisionCount++;
  if(testVisionMode==='save_fail')return {questions:[{number:'1',stem:'另一份完整题干',confidence:'high'}],warnings:[]};
  if(testVisionMode==='uncertain')return {questions:[{number:'1',stem:'不清楚',confidence:'low'}],warnings:[]};
  if(testVisionMode==='different')return {questions:[{number:'1',stem:'核对题干'+testVisionCount,confidence:'high'}],warnings:[]};
 }
 return deferredPrior(command,args);
};
"""

def main():
 server=ThreadingHTTPServer(('127.0.0.1',0),partial(QuietHandler,directory=str(ROOT/'app/apps/desktop/dist')));Thread(target=server.serve_forever,daemon=True).start()
 try:
  with sync_playwright() as p:
   browser=p.chromium.launch(channel='msedge',headless=True);page=browser.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
   initial=workspace();image=base64.b64decode(initial['paper']['pages'][0]['data'].split(',')[1]);initial['paper']={'pages':[],'questions':[]}
   page.add_init_script(MOCK+'\nwindow.testStored='+json.dumps({'revision':1,'snapshot':initial})+';'+EXTRA+DEEPSEEK_MOCK+VISION)
   page.goto(f'http://127.0.0.1:{server.server_port}/');paper=page.get_by_role('region',name='试卷题干核对',exact=True);agent=page.get_by_role('region',name='出题流程演示',exact=True)
   paper.get_by_label('添加试卷照片',exact=True).set_input_files({'name':'synthetic.png','mimeType':'image/png','buffer':image})
   expect(paper.get_by_role('status')).to_contain_text('空白卷已保存到本机')
   assert page.evaluate('testStored.snapshot.paper.pages.length')==1
   assert page.evaluate('testStored.snapshot.paper.questions.length')==0
   assert page.evaluate('testDeepseekCalls.length')==0
   expect(paper.get_by_role('button',name='识别当前已保存照片',exact=True)).to_have_count(0)
   agent.get_by_text('DeepSeek 模型设置',exact=True).click();agent.get_by_label('DeepSeek API Key',exact=True).fill('sk-synthetic-deferred-key');agent.get_by_role('button',name='启用 DeepSeek',exact=True).click()
   run=agent.get_by_role('button',name='生成结果',exact=True);expect(run).to_be_disabled();agent.get_by_label('确认空白卷不含学生姓名',exact=True).check();expect(run).to_be_enabled()
   page.evaluate('testEvents=[]');run.click();expect(agent.get_by_test_id('agent-message')).to_contain_text('生成完成：2 道题')
   assert page.evaluate('testEvents')==['recognize_paper','recognize_paper','save_workspace','annotate','generate','solve','solve','save_workspace']
   assert page.evaluate('testAccount.credits')==9
   assert page.evaluate('testStored.snapshot.paper.questions[0].confirmed') is True
   assert page.evaluate('testDeepseekCalls[0].data')=={'pageId':page.evaluate('testStored.snapshot.paper.pages[0].id')}
   agent.get_by_role('button',name='保存本场出题与审核',exact=True).click();expect(page.get_by_test_id('workspace-message')).to_contain_text('已校验并保存')
   assert page.evaluate('testStored.snapshot.practice.mode')=='real'
   print('PASS: upload only saves locally; explicit generation reads/checks paper before knowledge retrieval, generation and independent solving; results remain savable.')
   agent.get_by_label('确认空白卷不含学生姓名',exact=True).check()
   for mode in ['uncertain','different']:
    page.evaluate('testVisionMode='+json.dumps(mode)+';testEvents=[]');run.click();expect(agent.get_by_test_id('agent-message')).to_contain_text('核对不一致')
    assert page.evaluate('testEvents')==['recognize_paper','recognize_paper']
    assert page.evaluate('testStored.snapshot.practice.variants.length')==2
   page.evaluate("testVisionMode='save_fail';testSaveFailure=true;testEvents=[]");run.click();expect(agent.get_by_test_id('agent-message')).to_contain_text('题干未能保存')
   assert page.evaluate('testEvents')==['recognize_paper','recognize_paper','save_workspace']
   expect(agent.get_by_role('article')).to_have_count(2);assert page.evaluate('testStored.snapshot.paper.questions[0].stem')=='说明光合作用的意义。'
   page.evaluate("testSaveFailure=false;testVisionMode='ok';testQuota=true;testEvents=[]");run.click();expect(agent.get_by_test_id('agent-message')).to_contain_text('额度已耗尽');expect(run).to_be_disabled()
   assert page.evaluate('testEvents')==['recognize_paper'];assert page.evaluate('testStored.snapshot.practice.variants.length')==2
   assert page.evaluate('testAccount.credits')==9
   assert not errors,errors
   print('PASS: uncertainty, inconsistent reads and quota exhaustion stop the pipeline without overwriting saved paper/results or continuing paid calls.')
   browser.close()
 finally:server.shutdown();server.server_close()
if __name__=='__main__':main()
