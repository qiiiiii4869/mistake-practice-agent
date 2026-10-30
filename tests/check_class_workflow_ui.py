"""Full-class entry with synthetic local IPC. Real native PDF bridge is tested separately."""
import json,subprocess
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
    page.evaluate("() => {window.noFactsPrior=window.__TAURI_INTERNALS__.invoke;window.testCloudModelVersion='fedcba9876543210';window.__TAURI_INTERNALS__.invoke=async(c,a)=>{if(c==='workflow_call_model'&&a.request.stage==='extract'){testCloudCalls.push({command:c,args:structuredClone(a)});return {value:{facts:[]},usage:{totalTokens:5}};}return noFactsPrior(c,a);};}")
    panel.get_by_role('button',name='生成并导出 PDF',exact=True).click()
    expect(panel.get_by_text('仅有成绩统计兜底说明，尚无知识点讲评报告',exact=False)).to_be_visible(timeout=15000)
    expect(panel.get_by_text('本次没有生成有效练习。',exact=False)).to_be_visible()
    expect(panel.get_by_role('button',name='导出已有结果 PDF',exact=True)).to_have_count(0)
    page.evaluate("() => {window.__TAURI_INTERNALS__.invoke=noFactsPrior;window.queryFailurePrior=noFactsPrior;window.testCloudModelVersion='0123456789abcdf0';window.__TAURI_INTERNALS__.invoke=async(c,a)=>{if(c==='search_knowledge')throw 'knowledge_invalid_query';return queryFailurePrior(c,a);};}")
    panel.get_by_role('button',name='生成并导出 PDF',exact=True).click()
    expect(panel.get_by_test_id('class-workflow-message')).to_contain_text('知识库检索词为空或超过100字',timeout=15000)
    assert page.evaluate('Object.values(testWorkflowDb.tasks).some(t=>t.run?.errorCode==="knowledge_invalid_query"&&t.run.errorStage==="retrieving")')
    page.evaluate("() => {window.testCloudModelVersion='0123456789abcdf1';window.pausePrior=noFactsPrior;window.testInterrupt=true;window.__TAURI_INTERNALS__.invoke=async(c,a)=>{if(c==='workflow_call_model'&&a.request.stage==='verifyFact'&&testInterrupt){testInterrupt=false;testCloudCalls.push({command:c,args:structuredClone(a)});throw 'model_output_truncated';}return pausePrior(c,a);};}")
    panel.get_by_role('button',name='生成并导出 PDF',exact=True).click()
    expect(panel.get_by_test_id('class-workflow-message')).to_contain_text('长度限制',timeout=15000)
    continued=panel.get_by_role('button',name='继续已保存任务',exact=True);expect(continued).to_be_disabled()
    before_resume=page.evaluate("testCloudCalls.filter(c=>c.command==='workflow_call_model'&&['recognize','extract'].includes(c.args.request.stage)).length")
    panel.get_by_label('全班允许重试未知请求',exact=True).check();continued.click()
    expect(panel.get_by_test_id('class-workflow-message')).to_contain_text('取消选择保存位置',timeout=15000)
    assert page.evaluate("testCloudCalls.filter(c=>c.command==='workflow_call_model'&&['recognize','extract'].includes(c.args.request.stage)).length")==before_resume
    assert not errors,errors;page.close()
    print('PASS:',mode,layout,'whole-class scope, settings, teacher report, PDF-only retry/cancel, resource preflight and no deduction.')
   page=browser.new_page();initial=workspace();base=initial['students'][0];q=base['questions'][0]
   initial['students']=[{**base,'id':f'synthetic-{i}','name':f'合成学生{i}','questions':[{**q,'number':str(j+1),'label':str(j+1),'score':0,'result':'incorrect'} for j in range(15)]} for i in range(50)]
   initial['paper']={'pages':[{**initial['paper']['pages'][0],'id':f'page-{i+1}'} for i in range(4)],'questions':[]}
   batch=r"""
const batchPrior=window.__TAURI_INTERNALS__.invoke;
window.__TAURI_INTERNALS__.invoke=async(command,args)=>{
 if(command==='workflow_begin'){
  const checked=await checkNativeAuthorization({selected:args.questionNumbers,available:Array.from({length:15},(_,i)=>String(i+1)),request:args.request,pages:args.pages.length,students:50});
  if(checked.error)throw checked.error;if(!checked.value.accepted)throw 'workflow_failed';
 }
 if(command==='workflow_call_model'){
  const r=args.request,d=r.data;
  if(r.stage==='recognize'){
   testCloudCalls.push({command,args:structuredClone(args)});
   const page=Number(d.pageId.split('-').at(-1))-1;
   return {value:{questions:Array.from({length:15},(_,i)=>i+1).filter(n=>(n-1)%4===page).map(n=>({number:String(n),stem:'说明光合作用的能量转化。',confidence:'high'})),warnings:[]},usage:{totalTokens:10}};
  }
  if(d.groups){
   testCloudCalls.push({command,args:structuredClone(args)});
   return {value:{groups:d.groups.map(g=>r.stage==='extract'?{unitId:g.unitId,facts:[{knowledgePoint:'光合作用',context:'',completeStatement:'光合作用将光能转化为化学能。',conditions:[],candidateAnswers:['化学能']}]}:{unitId:g.unitId,checks:g.facts.map(()=>({accurate:true,supported:true,inScope:true}))})},usage:{totalTokens:10}};
  }
 }
 return batchPrior(command,args);
};
"""
   def native_authorization(value):
    result=subprocess.run([str(ROOT/'tools/storage-check/target/debug/workflow_authorization_probe.exe')],input=json.dumps(value),text=True,capture_output=True,check=True)
    return json.loads(result.stdout)
   page.expose_function('checkNativeAuthorization',native_authorization)
   page.add_init_script(MOCK+'\nwindow.testStored='+json.dumps({'revision':1,'snapshot':initial})+';'+EXTRA+CLOUD+CLASS+batch)
   page.goto(f'http://127.0.0.1:{server.server_port}/');page.get_by_role('navigation',name='功能入口').get_by_role('button',name='生成报告',exact=True).click()
   panel=page.get_by_role('region',name='全班练习与教师报告',exact=True);panel.get_by_role('button',name='生成并导出 PDF',exact=True).click()
   expect(panel.get_by_test_id('class-workflow-message')).to_contain_text('已保存',timeout=20000)
   request=page.evaluate("testCloudCalls.find(c=>c.command==='workflow_begin').args.request")
   assert request['counts']=={'pages':4,'units':15,'students':50};assert request['requestedBudget']['maxCalls']==300
   assert page.evaluate("testCloudCalls.filter(c=>c.command==='workflow_call_model'&&c.args.request.stage==='extract').length")==3
   assert len(page.evaluate('Object.values(testWorkflowDb.tasks)[0].run.facts[0].sourceNumbers'))==15
   assert page.evaluate('testAccount.credits')==10
   calls_before_recheck=page.evaluate("testCloudCalls.filter(c=>c.command==='workflow_call_model').length")
   panel.get_by_role('button',name='离线复核已保存识题',exact=True).click()
   expect(panel.get_by_test_id('class-workflow-message')).to_contain_text('已离线复核')
   expect(panel.get_by_test_id('class-workflow-message')).to_contain_text('15 道原题有可靠文字')
   assert page.evaluate("testCloudCalls.filter(c=>c.command==='workflow_call_model').length")==calls_before_recheck
   page.evaluate("() => {window.failNextBegin=window.__TAURI_INTERNALS__.invoke;window.__TAURI_INTERNALS__.invoke=async(c,a)=>{if(c==='workflow_begin')throw 'account_network_failed';return failNextBegin(c,a);};}")
   model_calls=page.evaluate("testCloudCalls.filter(c=>c.command==='workflow_call_model').length")
   panel.get_by_role('button',name='生成并导出 PDF',exact=True).click();expect(panel.get_by_test_id('class-workflow-message')).to_contain_text('账号服务连接失败')
   assert page.evaluate("testCloudCalls.filter(c=>c.command==='workflow_call_model').length")==model_calls
   assert page.evaluate('Object.values(testWorkflowDb.tasks).some(t=>t.run?.errorCode==="account_network_failed"&&t.run.calls.length===0)')
   page.close();print('PASS: 50 students / 15 originals / 4 pages / 300 calls passes native authorization guard; native string failures preserve cause without model calls.')
   page=browser.new_page();mismatched=workspace();mismatched['exam']['name']='高三生物第八周周练';mismatched['paper']['pages'][0]['name']='第三周周练.pdf'
   page.add_init_script(MOCK+'\nwindow.testStored='+json.dumps({'revision':1,'snapshot':mismatched})+';'+EXTRA+CLOUD+CLASS)
   page.goto(f'http://127.0.0.1:{server.server_port}/');page.get_by_role('navigation',name='功能入口').get_by_role('button',name='生成报告',exact=True).click()
   panel=page.get_by_role('region',name='全班练习与教师报告',exact=True)
   expect(panel.get_by_role('alert')).to_contain_text('成绩为第8周，试卷文件包含第3周')
   panel.get_by_role('button',name='生成并导出 PDF',exact=True).click();expect(panel.get_by_test_id('class-workflow-message')).to_contain_text('周次不一致')
   assert not page.evaluate("testCloudCalls.some(c=>['workflow_begin','workflow_call_model'].includes(c.command))")
   page.close();print('PASS: different exam/paper weeks block authorization and paid calls with an explicit source mismatch.')
   browser.close()
 finally:server.shutdown();server.server_close()
if __name__=='__main__':main()
