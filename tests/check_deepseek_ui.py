"""DeepSeek UI wiring with synthetic IPC responses; never calls a paid API."""
import json
from functools import partial
from http.server import ThreadingHTTPServer
from threading import Thread
from playwright.sync_api import expect,sync_playwright
from check_desktop_ui import MOCK,QuietHandler,ROOT
from check_agent_ui import workspace,EXTRA

DEEPSEEK_MOCK=r"""
window.testDeepseek={configured:false,quotaExhausted:false,model:'deepseek-flash',usage:{promptTokens:0,completionTokens:0,totalTokens:0}};
window.testDeepseekCalls=[];window.testQuota=false;
const priorInvoke=window.__TAURI_INTERNALS__.invoke;
window.__TAURI_INTERNALS__.invoke=async(command,args)=>{
 if(command==='deepseek_status')return structuredClone(testDeepseek);
 if(command==='configure_deepseek'){testDeepseek.configured=!!args.key;testDeepseek.quotaExhausted=false;return;}
 if(command!=='call_deepseek')return priorInvoke(command,args);
 if(testDeepseek.quotaExhausted)throw 'model_quota_exhausted';
 testDeepseekCalls.push(structuredClone(args.request));
 if(testQuota){testDeepseek.quotaExhausted=true;throw 'model_quota_exhausted';}
 testDeepseek.usage.totalTokens+=10;
 if(args.request.stage==='recognize_paper')return {questions:[{number:'1',stem:'说明光合作用的意义。',confidence:'high'}],warnings:[]};
 if(args.request.stage==='annotate')return {knowledgePoints:['光合作用'],keywords:['光合作用'],kind:'text',materialGroup:null};
 if(args.request.stage==='generate')return {exercises:Array.from({length:args.request.data.count},(_,i)=>({stem:'接口协议模拟变式'+i,options:[],answer:'正确答案',explanation:'协议模拟解析',knowledgePoints:['光合作用'],sourceIndexes:[0]}))};
 return {answer:'正确答案',complete:true,inScope:true,tooSimilar:false,explanation:'协议模拟独立解答'};
};
"""

def main():
    server=ThreadingHTTPServer(('127.0.0.1',0),partial(QuietHandler,directory=str(ROOT/'app/apps/desktop/dist')))
    Thread(target=server.serve_forever,daemon=True).start()
    try:
        with sync_playwright() as p:
            browser=p.chromium.launch(channel='msedge',headless=True);page=browser.new_page();errors=[]
            page.on('pageerror',lambda e:errors.append(str(e)))
            initial=json.dumps({'revision':1,'snapshot':workspace()})
            page.add_init_script(MOCK+'\nwindow.testStored='+initial+';'+EXTRA+DEEPSEEK_MOCK)
            page.goto(f'http://127.0.0.1:{server.server_port}/')
            agent=page.get_by_role('region',name='出题流程演示',exact=True)
            agent.get_by_text('DeepSeek 模型设置',exact=True).click()
            key=agent.get_by_label('DeepSeek API Key',exact=True)
            expect(key).to_have_attribute('type','password')
            key.fill('sk-synthetic-test-not-a-real-key')
            agent.get_by_role('button',name='启用 DeepSeek',exact=True).click()
            expect(key).to_have_value('')
            expect(agent.get_by_label('出题运行模式',exact=True)).to_have_value('real')
            run=agent.get_by_role('button',name='生成结果',exact=True)
            agent.get_by_label('确认空白卷不含学生姓名',exact=True).check()
            run.click()
            expect(agent.get_by_test_id('agent-message')).to_contain_text('生成完成：2 道题')
            assert page.evaluate('testDeepseekCalls.map(r=>r.stage)')==['recognize_paper','recognize_paper','annotate','generate','solve','solve']
            assert '模拟学生甲' not in page.evaluate('JSON.stringify(testDeepseekCalls)')
            assert 'sk-synthetic' not in page.evaluate('JSON.stringify(testStored)+JSON.stringify(sessionStorage)')
            agent.get_by_role('button',name='保存本场出题与审核',exact=True).click()
            expect(page.get_by_test_id('workspace-message')).to_contain_text('已校验并保存')
            assert page.evaluate('testStored.snapshot.practice.mode')=='real'
            expect(agent.get_by_text('修改题目（修改后需重新自检与审核）',exact=True).first).to_be_visible()
            print('PASS: password input, session-only key IPC, real-provider pipeline, anonymous requests and correctly marked stored batch.')
            agent.get_by_label('确认空白卷不含学生姓名',exact=True).check()
            page.evaluate('testQuota=true')
            run.click()
            expect(agent.get_by_test_id('agent-message')).to_contain_text('额度已耗尽')
            expect(run).to_be_disabled()
            count=page.evaluate('testDeepseekCalls.length')
            assert count==7
            agent.locator('details').first.evaluate("el=>el.open=true")
            agent.get_by_role('button',name='清除会话密钥',exact=True).click()
            expect(agent.get_by_label('出题运行模式',exact=True)).to_have_value('mock')
            assert page.evaluate('testDeepseekCalls.length')==count
            assert not errors,errors
            print('PASS: quota stops after one failed call, no automatic retry/fallback, session key can be cleared.')
            browser.close()
    finally:server.shutdown();server.server_close()

if __name__=='__main__':main()
