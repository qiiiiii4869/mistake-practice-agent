"""A lost completion response must recover without another charge or model run."""
import json
from functools import partial
from http.server import ThreadingHTTPServer
from threading import Thread
from playwright.sync_api import sync_playwright,expect
from check_desktop_ui import ROOT,MOCK,QuietHandler
from check_agent_ui import workspace,EXTRA
from check_deepseek_ui import DEEPSEEK_MOCK

COUNTS=r"""
window.testCompletionCount=0;window.testCharged=false;window.testLostResponse=true;
window.testNoCredits=false;
const creditPrior=window.__TAURI_INTERNALS__.invoke;
window.__TAURI_INTERNALS__.invoke=async(command,args)=>{
 if(command==='account_generation_begin'&&testNoCredits)throw 'credits_exhausted';
 if(command==='account_generation_finish'&&args.batch){
  testCompletionCount++;
  if(!testCharged){testCharged=true;testAccount.credits--;testAccount.available--;}
  if(testLostResponse){testLostResponse=false;throw 'account_network_failed';}
  return {charged:true,user:structuredClone(testAccount)};
 }
 return creditPrior(command,args);
};
"""

def main():
 server=ThreadingHTTPServer(('127.0.0.1',0),partial(QuietHandler,directory=str(ROOT/'app/apps/desktop/dist')));Thread(target=server.serve_forever,daemon=True).start()
 try:
  with sync_playwright() as p:
   browser=p.chromium.launch(channel='msedge',headless=True);page=browser.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
   page.add_init_script(MOCK+'\nwindow.testStored='+json.dumps({'revision':1,'snapshot':workspace()})+';'+EXTRA+DEEPSEEK_MOCK+COUNTS)
   page.goto(f'http://127.0.0.1:{server.server_port}/');agent=page.get_by_role('region',name='出题流程演示',exact=True)
   agent.get_by_text('DeepSeek 模型设置',exact=True).click();agent.get_by_label('DeepSeek API Key',exact=True).fill('sk-synthetic-credit-only');agent.get_by_role('button',name='启用 DeepSeek',exact=True).click()
   agent.get_by_label('确认空白卷不含学生姓名',exact=True).check();agent.get_by_role('button',name='生成结果',exact=True).click()
   expect(agent.get_by_test_id('agent-message')).to_contain_text('同一批不会重复扣次')
   assert page.evaluate('testAccount.credits')==9
   calls=page.evaluate('testDeepseekCalls.length')
   agent.get_by_role('button',name='恢复并确认结果',exact=True).click()
   expect(agent.get_by_test_id('agent-message')).to_contain_text('同一批只扣 1 次')
   assert page.evaluate('testAccount.credits')==9
   assert page.evaluate('testCompletionCount')==2
   assert page.evaluate('testDeepseekCalls.length')==calls
   assert page.evaluate('testStored.snapshot.practice.mode')=='real'
   print('PASS: lost completion response preserves result, retries one operation, charges once and recovers without new model calls.')
   agent.get_by_label('确认空白卷不含学生姓名',exact=True).check();page.evaluate('testNoCredits=true')
   agent.get_by_role('button',name='生成结果',exact=True).click();expect(agent.get_by_test_id('agent-message')).to_contain_text('剩余次数不足')
   assert page.evaluate('testDeepseekCalls.length')==calls
   assert page.evaluate('testAccount.credits')==9
   print('PASS: server refusal for exhausted credits stops before recognition or any model call.')
   assert not errors,errors;browser.close()
 finally:server.shutdown();server.server_close()

if __name__=='__main__':main()
