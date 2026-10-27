"""Synthetic reads archive history before the user decides to replace the workspace."""
import json
from functools import partial
from http.server import ThreadingHTTPServer
from threading import Thread
from playwright.sync_api import expect, sync_playwright
from check_desktop_ui import ROOT, MOCK, QuietHandler
from check_agent_ui import workspace, EXTRA
from test_full_class_audit import fixture

def main():
 server=ThreadingHTTPServer(('127.0.0.1',0),partial(QuietHandler,directory=str(ROOT/'app/apps/desktop/dist')))
 Thread(target=server.serve_forever,daemon=True).start()
 try:
  with sync_playwright() as p:
   browser=p.chromium.launch(channel='msedge',headless=True)
   page=browser.new_page(viewport={'width':1280,'height':950})
   current=workspace();current['exam'].update(classId='c-test',subjectName='模拟生物')
   options=[{'id':f'week{i}','name':f'第{i}周练'} for i in [2,3,5]]
   page.add_init_script(MOCK+'\nwindow.testStored='+json.dumps({'revision':1,'snapshot':current})+';window.testExamOptions='+json.dumps(options)+';'+EXTRA)
   page.goto(f'http://127.0.0.1:{server.server_port}/')
   page.get_by_role('button',name='登录智学网',exact=True).click()
   page.get_by_role('button',name='读取考试列表',exact=True).click()
   nav=page.get_by_role('navigation',name='功能入口')
   for index,item in enumerate(options):
    data=fixture();data['data'].update(exam_id=item['id'],subject_id='p-test',class_id='c-test')
    page.evaluate('(value)=>{window.testExport=value;}',data)
    page.get_by_label('选择考试',exact=True).select_option(item['id'])
    read=page.get_by_role('button',name='读取全班逐题得分',exact=True)
    expect(read).to_be_enabled();read.click()
    confirm=page.get_by_role('region',name='确认替换考试',exact=True)
    expect(confirm).to_contain_text('历史成绩已保存')
    assert page.evaluate('testHistory.length')==index+2
    assert page.evaluate('testStored.revision')==1
    assert page.evaluate('testStored.snapshot.exam.id')=='e'
    confirm.get_by_role('button',name='仅存为历史，保留当前考试',exact=True).click()
    nav.get_by_role('button',name='数据分析',exact=True).click()
    expect(page.get_by_label('对比考试').locator('option')).to_have_count(index+2)
    expect(page.get_by_role('region',name='班级历次表现趋势图')).to_contain_text(f'共 {index+2} 场考试')
    nav.get_by_role('button',name='信息导入',exact=True).click()
   # Updating an existing read does not append a duplicate.
   page.evaluate("testSaveFailure=true")
   read.click()
   expect(page.get_by_test_id('workspace-message')).to_contain_text('本地存储未能确认完成')
   expect(confirm).to_have_count(0)
   assert page.evaluate('testHistory.length')==4
   page.evaluate("testSaveFailure=false")
   page.reload()
   nav.get_by_role('button',name='数据分析',exact=True).click()
   expect(page.get_by_label('对比考试').locator('option')).to_have_count(4)
   assert not page.evaluate("testCommands.includes('read_exam_list') || testCommands.includes('read_class_scores')")
   expect(page.get_by_role('region',name='班级历次表现趋势图')).to_contain_text('共 4 场考试')
   browser.close()
   print('PASS: weeks 2/3/5 archive without replacing, immediate comparison refresh, storage failure and offline reload.')
 finally:
  server.shutdown();server.server_close()

if __name__=='__main__':main()
