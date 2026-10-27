"""Four-page navigation and chart accuracy with synthetic local data only."""
import json
from functools import partial
from http.server import ThreadingHTTPServer
from threading import Thread
from playwright.sync_api import expect,sync_playwright
from check_desktop_ui import ROOT,MOCK,QuietHandler
from check_agent_ui import workspace,EXTRA

def main():
 server=ThreadingHTTPServer(('127.0.0.1',0),partial(QuietHandler,directory=str(ROOT/'app/apps/desktop/dist')));Thread(target=server.serve_forever,daemon=True).start()
 try:
  with sync_playwright() as p:
   browser=p.chromium.launch(channel='msedge',headless=True)
   for width,height in [(1280,900),(760,900),(390,844)]:
    page=browser.new_page(viewport={'width':width,'height':height});errors=[];page.on('pageerror',lambda error:errors.append(str(error)))
    page.add_init_script(MOCK+'\nwindow.testStored='+json.dumps({'revision':1,'snapshot':workspace()})+';'+EXTRA)
    page.goto(f'http://127.0.0.1:{server.server_port}/');nav=page.get_by_role('navigation',name='功能入口')
    expect(nav.get_by_role('button',name='信息导入')).to_have_attribute('aria-current','page')
    expect(page.get_by_role('heading',name='信息导入',exact=True)).to_be_visible()
    expect(page.get_by_role('heading',name='上传空白卷',exact=True)).to_be_visible()
    expect(page.get_by_role('heading',name='PDF 知识库',exact=True)).to_be_hidden()
    nav.get_by_role('button',name='数据分析',exact=True).click()
    expect(page.get_by_role('heading',name='数据分析',exact=True)).to_be_visible()
    expect(page.get_by_role('region',name='各题失分率图表')).to_contain_text('第 1 题')
    expect(page.get_by_role('region',name='逐题得分情况图表')).to_contain_text('2 条')
    expect(page.get_by_role('region',name='学生得分分布图表')).to_contain_text('2 人')
    expect(page.get_by_role('region',name='逐题得分情况图表')).to_contain_text('50.0%')
    expect(page.get_by_role('region',name='各题失分率图表').locator('svg')).to_be_visible()
    expect(page.get_by_role('region',name='学生得分分布图表').locator('svg')).to_be_visible()
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'),f'Horizontal overflow at {width}'
    page.screenshot(path=str(ROOT/f'tmp/workspace-analysis-{width}.png'))
    nav.get_by_role('button',name='生成报告',exact=True).click()
    expect(page.get_by_role('heading',name='PDF 知识库')).to_be_visible()
    expect(page.get_by_role('region',name='出题流程演示')).to_be_visible()
    keyword=page.get_by_label('演示知识点与检索词',exact=True);keyword.fill('光合作用')
    nav.get_by_role('button',name='充值中心',exact=True).click()
    expect(page.get_by_role('region',name='充值信息')).to_contain_text('暂无收款二维码')
    expect(page.get_by_role('region',name='充值信息')).to_contain_text('10')
    assert page.get_by_role('region',name='充值信息').locator('img').count()==0
    nav.get_by_role('button',name='生成报告',exact=True).click();expect(keyword).to_have_value('光合作用')
    nav.get_by_role('button',name='信息导入',exact=True).click();expect(page.get_by_role('heading',name='上传空白卷',exact=True)).to_be_visible()
    if width==1280:page.screenshot(path=str(ROOT/'tmp/workspace-import.png'))
    assert not errors,errors;page.close()
   page=browser.new_page();page.add_init_script(MOCK+"\nwindow.testStored={revision:0,snapshot:null};"+EXTRA);page.goto(f'http://127.0.0.1:{server.server_port}/')
   page.get_by_role('navigation',name='功能入口').get_by_role('button',name='数据分析').click();expect(page.get_by_text('暂无考试数据')).to_be_visible()
   page.get_by_role('button',name='前往信息导入').click();expect(page.get_by_role('heading',name='信息导入',exact=True)).to_be_visible()
   page.get_by_role('navigation',name='功能入口').get_by_role('button',name='生成报告').click();expect(page.get_by_text('暂无本场报告')).to_be_visible();expect(page.get_by_role('heading',name='PDF 知识库')).to_be_visible()
   browser.close();print('PASS: four navigable pages, synthetic chart counts, unsaved state preservation, empty states and desktop/mobile widths.')
 finally:server.shutdown();server.server_close()

if __name__=='__main__':main()
