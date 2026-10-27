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
    current=workspace();current['overview']={'status':'received','classMax':90,'classAvg':60,'gradeMax':100,'gradeAvg':65,'topClassAvg':80,'topClassName':'二班'}
    current['students'][0]['questions'][0].update(score=1,result='partial_credit');current['students'][0]['classRank']=5;current['students'][1]['classRank']=1
    history=[{'examId':'old','examName':'上次考试','classId':'c','className':'模拟班级','subjectName':'生物','finishedAt':'SYNTHETIC','classAvg':50,'gradeAvg':55,'topClassAvg':70,
      'students':[{'id':'s1','name':'模拟学生甲','score':1,'fullScore':2,'classRank':1},{'id':'s2','name':'模拟学生乙','score':1,'fullScore':2,'classRank':4}]}]
    history=[{**history[0],'examId':'e','classAvg':999},*history,{**history[0],'examId':'older','examName':'更早考试','classAvg':40,'gradeAvg':45,'topClassAvg':60}]
    page.add_init_script(MOCK+'\nwindow.testStored='+json.dumps({'revision':1,'snapshot':current})+';window.testHistory='+json.dumps(history)+';'+EXTRA)
    page.goto(f'http://127.0.0.1:{server.server_port}/');nav=page.get_by_role('navigation',name='功能入口')
    expect(nav.get_by_role('button',name='信息导入')).to_have_attribute('aria-current','page')
    expect(page.get_by_role('heading',name='信息导入',exact=True)).to_be_visible()
    expect(page.get_by_role('heading',name='上传空白卷',exact=True)).to_be_visible()
    expect(page.get_by_role('heading',name='PDF 知识库',exact=True)).to_be_hidden()
    nav.get_by_role('button',name='数据分析',exact=True).click()
    expect(page.get_by_role('heading',name='数据分析',exact=True)).to_be_visible()
    expect(page.get_by_role('region',name='各题得分率图表')).to_contain_text('75%')
    expect(page.get_by_role('region',name='各题得分率图表').locator('svg')).to_be_visible()
    overview=page.get_by_role('region',name='班级和年级成绩概览')
    expect(overview).to_contain_text('最高班均分')
    expect(overview).to_contain_text('80')
    expect(overview).to_contain_text('本班均分')
    expect(overview).to_contain_text('班级最高')
    expect(overview).to_contain_text('年级最高')
    expect(overview).to_contain_text('100')
    expect(overview).not_to_contain_text('班级未获取')
    assert overview.locator('.score-overview-row').count()==2
    assert overview.locator('table').count()==0
    overview.screenshot(path=str(ROOT/f'tmp/score-overview-{width}.png'))
    highlights=page.get_by_role('region',name='学生成绩亮点')
    expect(highlights.locator('.highlight-best')).to_contain_text('模拟学生乙')
    page.get_by_label('对比考试').select_option('old')
    expect(highlights.locator('.highlight-progress')).to_contain_text('模拟学生乙')
    expect(highlights.locator('.highlight-decline')).to_contain_text('模拟学生甲')
    expect(highlights).to_contain_text('上升 3 名')
    expect(highlights).to_contain_text('下降 4 名')
    assert highlights.locator('table').count()==0
    page.get_by_label('题目排序').select_option('low')
    page.get_by_role('region',name='各题得分率图表').locator('.recharts-bar-rectangle').first.click()
    question=page.get_by_role('region',name='第 1 题明细')
    expect(question).to_contain_text('模拟学生甲')
    expect(question).to_contain_text('没扫')
    question.get_by_role('button',name='收起明细').click()
    heatmap=page.get_by_role('region',name='学生逐题热力图')
    expect(heatmap.get_by_role('button',name='模拟学生甲 第 1 题 1 / 2 · 50.0%')).to_be_visible()
    heatmap.get_by_role('button',name='模拟学生甲 第 1 题 1 / 2 · 50.0%').click()
    expect(heatmap.get_by_role('region',name='热力图成绩明细')).to_contain_text('50.0%')
    heatmap.get_by_label('查找学生').fill('没有这个学生')
    expect(heatmap).to_contain_text('没有匹配的学生')
    heatmap.get_by_label('查找学生').fill('')
    ranks=page.get_by_role('region',name='学生名次变化图')
    expect(ranks.locator('svg').first).to_be_visible()
    ranks.get_by_label('查看范围').select_option('down')
    expect(ranks).to_contain_text('共 1 人')
    ranks.get_by_text('查看名次明细',exact=True).click()
    ranks.get_by_role('button',name='模拟学生甲：1 → 5 名').click()
    expect(ranks.get_by_role('status')).to_contain_text('本次第 5 名')
    trend=page.get_by_role('region',name='班级历次表现趋势图')
    expect(trend).to_contain_text('共 3 场考试')
    expect(trend).to_contain_text('最高班均分')
    expect(trend.locator('svg').first).to_be_visible()
    trend.get_by_text('查看考试数据与调整顺序',exact=True).click()
    expect(trend.locator('.trend-order li').nth(0)).to_contain_text('更早考试')
    expect(trend.locator('.trend-order li').nth(2)).to_contain_text('本班 60 · 年级 65 · 最高班 80')
    trend.get_by_role('button',name='上次考试上移').click()
    expect(trend.locator('.trend-order li').nth(0)).to_contain_text('上次考试')
    heatmap.screenshot(path=str(ROOT/f'tmp/student-heatmap-{width}.png'))
    trend.screenshot(path=str(ROOT/f'tmp/class-trend-{width}.png'))
    assert page.get_by_role('region',name='逐题得分情况图表').count()==0
    assert page.get_by_role('region',name='学生得分分布图表').count()==0
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
   page=browser.new_page(viewport={'width':1280,'height':900})
   large=workspace()
   large['students']=[{**large['students'][0],'id':f's{i}','name':f'学生{i:02}','classRank':i+1,'questions':[
     {'number':str(q),'label':str(q),'score':1,'fullScore':2,'result':'partial_credit'} for q in range(1,36)]} for i in range(51)]
   page.add_init_script(MOCK+'\nwindow.testStored='+json.dumps({'revision':1,'snapshot':large})+';window.testHistory='+json.dumps([{'examId':'old','examName':'缺少均分的旧考试','classId':'c','className':'班级','subjectName':'生物','finishedAt':'OLD','students':[]}])+';'+EXTRA)
   page.goto(f'http://127.0.0.1:{server.server_port}/');page.get_by_role('navigation',name='功能入口').get_by_role('button',name='数据分析').click()
   heat=page.get_by_role('region',name='学生逐题热力图')
   expect(heat.locator('tbody tr')).to_have_count(25)
   expect(heat.locator('thead th')).to_have_count(31)
   heat.get_by_role('button',name='下一页学生').click()
   expect(heat).to_contain_text('学生 2 / 3 页')
   heat.get_by_role('button',name='下一页学生').click()
   expect(heat.locator('tbody tr')).to_have_count(1)
   heat.get_by_role('button',name='下一页题目').click()
   expect(heat.locator('thead th')).to_have_count(6)
   expect(page.get_by_role('region',name='班级历次表现趋势图')).to_contain_text('共 2 场考试')
   expect(page.get_by_role('region',name='班级历次表现趋势图')).to_contain_text('2 场考试缺少部分均分')
   page.close()
   page=browser.new_page();page.add_init_script(MOCK+"\nwindow.testStored={revision:0,snapshot:null};"+EXTRA);page.goto(f'http://127.0.0.1:{server.server_port}/')
   page.get_by_role('navigation',name='功能入口').get_by_role('button',name='数据分析').click();expect(page.get_by_text('暂无考试数据')).to_be_visible()
   page.get_by_role('button',name='前往信息导入').click();expect(page.get_by_role('heading',name='信息导入',exact=True)).to_be_visible()
   page.get_by_role('navigation',name='功能入口').get_by_role('button',name='生成报告').click();expect(page.get_by_text('暂无本场报告')).to_be_visible();expect(page.get_by_role('heading',name='PDF 知识库')).to_be_visible()
   browser.close();print('PASS: pages, score drilldown, heatmap search/click, rank filtering and details, all-exam three-line trend, reorder, responsive widths and preserved drafts.')
 finally:server.shutdown();server.server_close()

if __name__=='__main__':main()
