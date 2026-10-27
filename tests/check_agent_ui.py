"""Offline demo flow against synthetic workspace and local retrieval responses."""
import json
from functools import partial
from http.server import ThreadingHTTPServer
from threading import Thread
from playwright.sync_api import expect, sync_playwright
from check_desktop_ui import MOCK, QuietHandler, ROOT

def workspace():
    question={'number':'1','label':'1','score':0,'fullScore':2,'result':'incorrect'}
    return {'schemaVersion':1,'source':{'kind':'chrome_extension','finishedAt':'SYNTHETIC'},
      'exam':{'id':'e','name':'模拟考试','subjectId':'p','subjectName':'生物','classId':'c','className':'模拟班级'},
      'settings':{'variantsPerQuestion':2,'maxQuestionsPerStudent':5,'includePartialCredit':True,'partialCreditThreshold':100,'difficulty':'same'},
      'students':[
        {'id':'s1','name':'模拟学生甲','availability':'scored','reasonSource':None,'rosterScore':None,'rankCode':None,'questions':[question]},
        {'id':'s2','name':'模拟学生乙','availability':'scored','reasonSource':None,'rosterScore':None,'rankCode':None,'questions':[{**question,'score':2,'result':'correct'}]},
        {'id':'s3','name':'模拟学生丙','availability':'not_scanned','reasonSource':'roster_score_column','rosterScore':None,'rankCode':None,'questions':[]}],
      'paper':{'pages':[{'id':'page-1','name':'synthetic.png','data':'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII='}],
        'questions':[{'number':'1','pageId':'page-1','stem':'说明光合作用的意义。','confirmed':True}]}}

EXTRA = r"""
window.testNoEvidence=false;
const originalInvoke=window.__TAURI_INTERNALS__.invoke;
window.__TAURI_INTERNALS__.invoke=async(command,args)=>{
 if(command==='list_knowledge')return {revision:0,documents:[]};
 if(command==='search_knowledge')return testNoEvidence?[]:[{documentId:'a'.repeat(64),name:'模拟课本.pdf',page:4,ordinal:1,text:'光合作用将光能转化为化学能。'}];
 return originalInvoke(command,args);
};
"""

def main():
    server=ThreadingHTTPServer(('127.0.0.1',0),partial(QuietHandler,directory=str(ROOT/'app/apps/desktop/dist')))
    Thread(target=server.serve_forever,daemon=True).start()
    try:
        with sync_playwright() as playwright:
            browser=playwright.chromium.launch(channel='msedge',headless=True)
            page=browser.new_page(viewport={'width':1060,'height':900});errors=[]
            page.on('pageerror',lambda e:errors.append(str(e)))
            initial=json.dumps({'revision':1,'snapshot':workspace()})
            page.add_init_script(MOCK+'\nwindow.testStored=JSON.parse(sessionStorage.getItem("synthetic-workspace")??'+json.dumps(initial)+');'+EXTRA)
            page.goto(f'http://127.0.0.1:{server.server_port}/')
            page.get_by_role('navigation',name='功能入口').get_by_role('button',name='生成报告').click()
            agent=page.get_by_role('region',name='出题流程演示',exact=True)
            expect(agent).to_be_visible()
            expect(agent).to_contain_text('不能作为正式补练导出')
            keyword=agent.get_by_label('演示知识点与检索词',exact=True)
            keyword.fill('光合作用')
            run=agent.get_by_role('button',name='运行离线出题演示',exact=True)
            run.click()
            expect(agent.get_by_test_id('agent-message')).to_contain_text('演示完成：2 道题')
            expect(agent).to_contain_text('标注 1 次 · 出题 1 次 · 独立解题 2 次')
            first=agent.get_by_role('article',name='审核 q1-v1',exact=True)
            first.locator('summary').first.click()
            expect(first).to_contain_text('模拟课本.pdf · 第 4 页')
            agent.get_by_label('教师审核 q1-v1',exact=True).select_option('approved')
            agent.get_by_label('教师审核 q1-v2',exact=True).select_option('approved')
            agent.get_by_text('本机组卷预览（演示，不可导出）',exact=True).click()
            rows=agent.locator('table').last.locator('tbody tr')
            expect(rows.nth(0).locator('td').nth(1)).to_have_text('1')
            expect(rows.nth(1).locator('td').nth(1)).to_have_text('0')
            expect(rows.nth(2).locator('td').nth(1)).to_contain_text('不判对错')
            first.get_by_text('修改演示题（修改后需重新自检与审核）',exact=True).click()
            first.get_by_label('修改解析 q1-v1',exact=True).fill('教师补充的演示解析')
            expect(agent.get_by_label('教师审核 q1-v1',exact=True)).to_have_value('pending')
            expect(agent.get_by_label('教师审核 q1-v1',exact=True).locator('option[value=approved]')).to_have_attribute('disabled','')
            first.get_by_role('button',name='重新自检 q1-v1',exact=True).click()
            expect(agent.get_by_test_id('agent-message')).to_contain_text('仍需教师重新采用')
            agent.get_by_label('教师审核 q1-v1',exact=True).select_option('approved')
            first.get_by_role('button',name='重新生成 q1-v1',exact=True).click()
            expect(agent.get_by_test_id('agent-message')).to_contain_text('需重新审核采用')
            expect(agent.get_by_label('教师审核 q1-v1',exact=True)).to_have_value('pending')
            expect(agent.get_by_label('教师审核 q1-v2',exact=True)).to_have_value('approved')
            agent.get_by_label('教师审核 q1-v1',exact=True).select_option('approved')
            page.screenshot(path=str(ROOT/'tmp/desktop-agent-ui-mock.png'),full_page=True)
            print('PASS: demo watermark, local retrieval source, separate self-check count, teacher approval and concept-deduplicated assignment.')
            agent.get_by_role('button',name='保存本场出题与审核',exact=True).click()
            expect(agent.get_by_test_id('agent-message')).to_contain_text('已保存本场出题与审核')
            assert page.evaluate('testStored.snapshot.practice.variants[0].review')=='approved'
            page.reload()
            expect(agent.get_by_role('article')).to_have_count(2)
            expect(agent.get_by_label('教师审核 q1-v1',exact=True)).to_have_value('approved')
            first.get_by_text('修改演示题（修改后需重新自检与审核）',exact=True).click()
            first.get_by_label('修改解析 q1-v1',exact=True).fill('保存失败时应保留此草稿')
            page.evaluate('testSaveFailure=true')
            agent.get_by_role('button',name='保存本场出题与审核',exact=True).click()
            expect(agent.get_by_test_id('agent-message')).to_contain_text('本次未能保存')
            expect(first.get_by_label('修改解析 q1-v1',exact=True)).to_have_value('保存失败时应保留此草稿')
            assert page.evaluate('testStored.snapshot.practice.variants[0].review')=='approved'
            page.evaluate('testSaveFailure=false')
            print('PASS: approved batches restore after reload; failed saves preserve old stored review and current unsaved draft.')
            keyword.fill('模拟学生甲');run.click()
            expect(agent.get_by_test_id('agent-message')).to_contain_text('名单姓名，已拦截')
            expect(first).to_be_visible()
            keyword.fill('光合作用');page.evaluate('testNoEvidence=true');run.click()
            expect(agent).to_contain_text('知识库未找到依据')
            expect(agent.get_by_role('article')).to_have_count(0)
            page.evaluate('testNoEvidence=false')
            agent.get_by_text('题型规则（已核对 1 题）',exact=True).click()
            agent.get_by_label('第 1 题题型',exact=True).select_option('listening');run.click()
            expect(agent).to_contain_text('听力、作文或实验操作不自动出题')
            expect(agent.get_by_role('article')).to_have_count(0)
            print('PASS: privacy failure preserves prior result, absent evidence and unsupported question types cannot generate.')
            agent.get_by_label('第 1 题题型',exact=True).select_option('text');run.click()
            expect(agent.get_by_role('article')).to_have_count(2)
            page.get_by_role('navigation',name='功能入口').get_by_role('button',name='数据分析').click()
            current=page.get_by_role('region',name='本机当前考试',exact=True)
            current.get_by_text('本场教师设置',exact=True).click()
            current.get_by_label('每人题数上限',exact=True).fill('1')
            current.get_by_role('button',name='保存设置并重算',exact=True).click()
            page.get_by_role('navigation',name='功能入口').get_by_role('button',name='生成报告').click()
            expect(agent.get_by_role('article')).to_have_count(0)
            assert page.evaluate('testStored.snapshot.practice===undefined') is True
            keyword.fill('光合作用');run.click()
            expect(agent.get_by_role('article')).to_have_count(2)
            agent.get_by_role('button',name='保存本场出题与审核',exact=True).click()
            expect(agent.get_by_test_id('agent-message')).to_contain_text('已保存本场出题与审核')
            page.get_by_role('navigation',name='功能入口').get_by_role('button',name='数据分析').click()
            current.get_by_role('button',name='清除当前考试',exact=True).click()
            page.get_by_role('button',name='确认清除',exact=True).click()
            expect(agent).to_have_count(0)
            assert page.evaluate('testStored.snapshot') is None
            assert not errors,errors
            browser.close()
            print('PASS: persisted teacher setting changes invalidate all generated demo review results.')
    finally:server.shutdown();server.server_close()

if __name__=='__main__':main()
