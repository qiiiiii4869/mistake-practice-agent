"""Full-class entry with synthetic local IPC. Real native PDF bridge is tested separately."""
import json
from functools import partial
from http.server import ThreadingHTTPServer
from threading import Thread
from playwright.sync_api import sync_playwright,expect
from check_desktop_ui import ROOT,MOCK,QuietHandler
from check_agent_ui import workspace,EXTRA
from check_workflow_cloud_ui import CLOUD

CLASS=r"""
window.classExports={};window.classExportCalls=[];window.classPdfReady=true;window.classExportFail=false;window.classChooseCancel=false;
const classPrior=window.__TAURI_INTERNALS__.invoke;
const canon=v=>Array.isArray(v)?'['+v.map(canon).join(',')+']':v&&typeof v==='object'?'{'+Object.entries(v).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b,'en')).map(([k,v])=>JSON.stringify(k)+':'+canon(v)).join(',')+'}':JSON.stringify(v);
const classHash=async v=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canon(v))))].map(n=>n.toString(16).padStart(2,'0')).join('');
window.__TAURI_INTERNALS__.invoke=async(command,args)=>{
 if(command==='workflow_pdf_status')return {available:classPdfReady};
 if(command==='workflow_pdf_cancel')return;
 if(command==='workflow_store'&&args.operation==='list_exports')return structuredClone(classExports[args.payload.runId]??[]);
 if(command==='workflow_pdf_export'){
  classExportCalls.push(structuredClone(args));if(classChooseCancel)return null;
  const task=Object.values(testWorkflowDb.tasks).find(t=>t.run?.runId===args.runId);if(!task||task.input.testScope||!task.run.teacherReport)throw 'pdf_content_incomplete';
  let saved=classExports[args.runId]?.find(e=>e.data.profile.exportId===args.exportId);
  if(!saved){const body={runId:args.runId,layout:args.layout,includeAnswers:args.includeAnswers,templateVersion:'report-template-v1',printSettings:{duplex:false}};
   const profile={...body,exportId:crypto.randomUUID(),exportHash:await classHash({contentHash:task.input.contentHash,...body})};
   saved={data:{profile,state:'failed',staging:'synthetic-staging'},revision:1};(classExports[args.runId]??=[]).push(saved);}
  if(classExportFail)throw 'pdf_qa_failed';saved.data.state='verified';saved.data.folder='synthetic-output';
  return {state:'verified',folder:saved.data.folder,exportId:saved.data.profile.exportId,runId:args.runId,fileCount:saved.data.profile.layout==='individual'?task.input.workspace.students.length+1:2,settlementStatus:'not_requested'};
 }
 return classPrior(command,args);
};
"""
def main():
 server=ThreadingHTTPServer(('127.0.0.1',0),partial(QuietHandler,directory=str(ROOT/'app/apps/desktop/dist')));Thread(target=server.serve_forever,daemon=True).start()
 try:
  with sync_playwright() as p:
   browser=p.chromium.launch(channel='msedge',headless=True)
   for mode,layout in [('dictation','individual'),('exercise','combined')]:
    page=browser.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
    page.add_init_script(MOCK+'\nwindow.testStored='+json.dumps({'revision':1,'snapshot':workspace()})+';'+EXTRA+CLOUD+CLASS)
    page.goto(f'http://127.0.0.1:{server.server_port}/');page.get_by_role('navigation',name='功能入口').get_by_role('button',name='生成报告',exact=True).click()
    panel=page.get_by_role('region',name='全班练习与教师报告',exact=True)
    expect(panel).to_be_visible();expect(page.get_by_role('region',name='云端模型双模式测试',exact=True)).to_be_hidden();panel.get_by_label('全班内容模式',exact=True).select_option(mode);panel.get_by_label('全班导出方式',exact=True).select_option(layout)
    panel.get_by_label('全班每人数量上限',exact=True).fill('4');panel.get_by_label('全班生成难度',exact=True).select_option('basic')
    page.evaluate('classPdfReady=false');panel.get_by_role('button',name='生成并导出 PDF',exact=True).click()
    expect(panel.get_by_test_id('class-workflow-message')).to_contain_text('缺少 PDF 导出组件');assert not page.evaluate("testCloudCalls.some(c=>c.command==='workflow_begin')")
    page.evaluate('classPdfReady=true;classExportFail=true');panel.get_by_role('button',name='生成并导出 PDF',exact=True).click()
    expect(panel.get_by_test_id('class-workflow-message')).to_contain_text('PDF 检查未通过',timeout=15000)
    tasks=page.evaluate('Object.values(testWorkflowDb.tasks)');assert len(tasks)==1;task=tasks[0]
    assert 'testScope' not in task['input'];assert task['input']['settings']['maxItems']==4;assert task['input']['settings']['difficulty']=='basic';assert task['run']['teacherReport']
    begin=page.evaluate("testCloudCalls.find(c=>c.command==='workflow_begin')");assert begin['args']['request']['exportLayout']==layout
    calls=page.evaluate("testCloudCalls.filter(c=>c.command==='workflow_call_model').length")
    page.evaluate('classExportFail=false');panel.get_by_role('button',name='重试 PDF 导出',exact=True).click()
    expect(panel.get_by_test_id('class-workflow-message')).to_contain_text('已保存');assert page.evaluate("testCloudCalls.filter(c=>c.command==='workflow_call_model').length")==calls
    assert page.evaluate('testAccount.credits')==10
    page.evaluate('classChooseCancel=true');panel.get_by_role('button',name='导出已有结果 PDF',exact=True).click()
    expect(panel.get_by_test_id('class-workflow-message')).to_contain_text('取消选择保存位置');assert page.evaluate("testCloudCalls.filter(c=>c.command==='workflow_call_model').length")==calls
    assert not errors,errors;page.close()
    print('PASS:',mode,layout,'whole-class scope, settings, teacher report, PDF-only retry/cancel, resource preflight and no deduction.')
   browser.close()
 finally:server.shutdown();server.server_close()
if __name__=='__main__':main()
