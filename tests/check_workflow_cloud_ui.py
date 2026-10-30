"""Cloud-workflow UI against synthetic IPC; no account server or paid model calls."""
import json
from functools import partial
from http.server import ThreadingHTTPServer
from threading import Thread
from playwright.sync_api import expect, sync_playwright
from check_desktop_ui import open_workflow_tools
from check_desktop_ui import MOCK, QuietHandler, ROOT
from check_agent_ui import workspace, EXTRA

CLOUD = r"""
window.testCloudCalls=[];window.testCloudKeyPresent=false;window.testCloudHang=false;window.testCloudReject=null;
window.testCloudBadCloze=false;
window.testCloudFactReject=false;
window.testCloudRecognitionMismatch=false;
window.testCloudModelVersion='0123456789abcdef';
window.testWorkflowDb=JSON.parse(localStorage.getItem('synthetic-workflow-db')||'{"tasks":{},"responses":{},"analysis":{}}');
const saveWorkflowDb=()=>localStorage.setItem('synthetic-workflow-db',JSON.stringify(testWorkflowDb));
const cloudPrior=window.__TAURI_INTERNALS__.invoke;
window.__TAURI_INTERNALS__.invoke=async(command,args)=>{
 if(!command.startsWith('workflow_'))return cloudPrior(command,args);
 testCloudCalls.push({command,args:structuredClone(args)});
 if(command==='workflow_store'){
  const {operation:op,payload:p,ownerId}=args,key=ownerId+':'+p.runId;const task=testWorkflowDb.tasks[key];
  if(op==='list')return Object.entries(testWorkflowDb.tasks).filter(([k])=>k.startsWith(ownerId+':')).map(([k,t])=>({runId:k.slice(ownerId.length+1),contentHash:t.input.contentHash,
   mode:t.input.mode,examName:t.input.workspace.exam.name,state:t.run?.state??null,workspaceRevision:t.context.workspaceRevision,updatedAt:t.updatedAt,
   callCount:t.run?.calls.length??0,unknownCalls:t.run?.calls.filter(c=>c.status!=='completed').length??0})).sort((a,b)=>b.updatedAt-a.updatedAt);
  if(op==='load')return structuredClone(task??null);
  if(op==='begin'){if(!task)testWorkflowDb.tasks[key]={input:p.input,run:null,revision:0,context:p.context,createdAt:Date.now(),updatedAt:Date.now()};saveWorkflowDb();return {revision:testWorkflowDb.tasks[key].revision};}
  if(op==='save'){task.run=structuredClone(p.run);task.revision++;task.updatedAt=Date.now();if(p.receipt)testWorkflowDb.responses[key+':'+p.receipt.callId]=structuredClone(p.receipt.response);saveWorkflowDb();return {revision:task.revision};}
  if(op==='load_response')return structuredClone(testWorkflowDb.responses[key+':'+p.callId]??null);
  if(op==='load_analysis')return structuredClone(testWorkflowDb.analysis[ownerId+':'+p.cacheKey]??null);
  if(op==='save_analysis'){testWorkflowDb.analysis[ownerId+':'+p.cacheKey]=structuredClone(p.value);saveWorkflowDb();return;}
  if(op==='end'||op==='renew')return {};
  throw 'unexpected_store_operation';
 }
 if(command==='workflow_model_status')return {configured:true,model:'deepseek-flash',modelConfigVersion:testCloudModelVersion,deliveryEnabled:false};
 if(command==='workflow_pending')return {jobId:null};
 if(command==='workflow_save_diagnostic'){if(testCloudKeyPresent)throw 'key_not_cleared';return;}
 if(command==='workflow_begin'){testCloudKeyPresent=true;return {jobId:'00000000-0000-4000-8000-000000000002',state:'reserved',leaseUntil:Date.now()+90000,expiresAt:Date.now()+7200000};}
 if(command==='workflow_end'){testCloudKeyPresent=false;return {charged:false};}
 if(command==='workflow_abort'){testCloudKeyPresent=false;if(testCloudReject)testCloudReject('workflow_cancelled');return;}
 if(command==='workflow_heartbeat')return {continue:true,leaseUntil:Date.now()+90000};
 if(command==='workflow_call_model'){
  if(testCloudHang)return new Promise((_,reject)=>{testCloudReject=reject;});
  const r=args.request,d=r.data;let value;
  if(r.stage==='recognize')value={questions:[{number:'1',stem:'说明光合作用的能量转化。',confidence:'high'}],warnings:[]};
  if(r.stage==='recognize'&&testCloudRecognitionMismatch)value.questions[0].stem+='条件'+testCloudCalls.length+'mg。';
  if(r.stage==='extract')value={facts:[{knowledgePoint:'光合作用',context:'本条讨论植物叶肉细胞的能量转化。',completeStatement:'光合作用将光能转化为化学能。',conditions:[],candidateAnswers:['化学能']}]};
  if(r.stage==='verifyFact')value={checks:[{accurate:true,supported:true,inScope:true}]};
  if(r.stage==='verifyFact'&&testCloudFactReject)value={checks:[{accurate:false,supported:false,inScope:false}]};
  if(r.stage==='cloze')value={parts:[{type:'text',text:'光合作用将光能转化为'},{type:'blank',blankId:'b1',answer:'化学能',acceptedAnswers:['化学能']},{type:'text',text:'。'}],correction:'注意能量转化。'};
  if(r.stage==='blindFill')value={answers:[{blankId:'b1',value:'化学能'}],ambiguous:false,missingConditions:false};
  if(r.stage==='exercise')value={type:'single_choice',stem:'下列哪项描述光合作用的能量变化？',material:'',options:[{id:'A',text:'光能转化为化学能'},{id:'B',text:'能量不变'}],answer:['A'],rubric:['说明能量转化'],explanation:'光合作用储存能量。',estimatedMinutes:2};
  if(r.stage==='solve')value={answer:['A'],complete:true,inScope:true,tooSimilar:false};
  if(r.stage==='guidance')value={advice:d.evidence.map(e=>({evidenceIds:[e.evidenceId],focus:e.knowledgePoint+'相关题表现需核实。',classroomAction:'对照原题梳理能量转化过程。',followUp:'用短练习观察解释依据。'}))};
  if(r.stage==='cloze'&&testCloudBadCloze)value.parts[0].text+='额外字符';
  if(r.stage==='blindFill'&&testCloudBadCloze)value.ambiguous=true;
  return {value,usage:{totalTokens:10}};
 }
 throw 'unexpected_cloud_command';
};
"""

def main():
    server=ThreadingHTTPServer(('127.0.0.1',0),partial(QuietHandler,directory=str(ROOT/'app/apps/desktop/dist')))
    Thread(target=server.serve_forever,daemon=True).start()
    try:
        with sync_playwright() as p:
            browser=p.chromium.launch(channel='msedge',headless=True)
            page=browser.new_page(viewport={'width':1060,'height':900});errors=[]
            page.on('pageerror',lambda e:errors.append(str(e)))
            initial=json.dumps({'revision':1,'snapshot':workspace()})
            page.add_init_script(MOCK+'\nwindow.testStored='+initial+';'+EXTRA+CLOUD)
            page.goto(f'http://127.0.0.1:{server.server_port}/')
            page.get_by_role('navigation',name='功能入口').get_by_role('button',name='生成报告').click();open_workflow_tools(page)
            panel=page.get_by_role('region',name='云端模型双模式测试',exact=True)
            expect(panel).to_be_visible()
            expect(panel.get_by_text('只读取题干与各小问正文。图示、表格及其中的标签和数据不读取；依赖图表的小问跳过，其余文字知识点仍可生成。',exact=True)).to_be_visible()
            expect(panel.get_by_label('云端模型 Key',exact=True)).to_have_count(0)
            panel.get_by_role('button',name='检查本机试卷文件',exact=True).click()
            expect(panel.get_by_test_id('workflow-cloud-message')).to_contain_text('没有调用模型、领取 Key 或预占次数')
            assert not page.evaluate("testCloudCalls.some(c=>['workflow_begin','workflow_call_model'].includes(c.command))")
            panel.get_by_label('测试空白卷无学生姓名',exact=True).check()
            for mode in ['dictation','exercise']:
                panel.get_by_label('双模式生成内容',exact=True).select_option(mode)
                panel.get_by_role('button',name='开始真实内容测试',exact=True).click()
                expect(panel.get_by_test_id('workflow-cloud-message')).to_contain_text('本机 Key 已清理')
                if mode=='dictation':
                    expect(panel.get_by_text('背景与适用条件：本条讨论植物叶肉细胞的能量转化。',exact=True)).to_be_visible()
                    blind=page.evaluate('testCloudCalls.filter(c=>c.command==="workflow_call_model"&&c.args.request.stage==="blindFill").at(-1).args.request.data')
                    assert blind['context']=='本条讨论植物叶肉细胞的能量转化。'
                    assert '化学能' not in json.dumps(blind,ensure_ascii=False)
                expect(panel.get_by_role('heading',name='教师建议',exact=True)).to_have_count(0)
                expect(panel.get_by_text('本次为局部内容测试，未调用教师建议模型。',exact=False)).to_be_visible()
                panel.get_by_text('全班逐题正确率与知识点依据',exact=True).click()
                expect(panel.get_by_role('table').first).to_contain_text('光合作用')
                expect(panel.get_by_role('table').first).to_contain_text('1/2')
                expect(panel.get_by_role('table').first).to_contain_text('50.0%')
                panel.get_by_text('全班逐题正确率与知识点依据',exact=True).click()
                assert not page.evaluate('testCloudKeyPresent')
                assert page.evaluate('testCloudCalls.filter(c=>c.command==="workflow_begin").at(-1).args.request.mode')==mode
                assert page.evaluate('testAccount.credits')==10
            assert '模拟学生甲' not in page.evaluate('JSON.stringify(testCloudCalls.filter(c=>c.command!=="workflow_store"))')
            page.reload();open_workflow_tools(page)
            page.get_by_role('navigation',name='功能入口').get_by_role('button',name='生成报告').click();open_workflow_tools(page)
            panel=page.get_by_role('region',name='云端模型双模式测试',exact=True)
            panel.get_by_text('本机已保存任务',exact=False).click()
            expect(panel.get_by_role('button',name='查看保存结果',exact=True)).to_have_count(2)
            panel.get_by_role('button',name='查看保存结果',exact=True).first.click()
            expect(panel.get_by_test_id('workflow-cloud-message')).to_contain_text('没有领取 Key 或调用模型')
            assert page.evaluate('testCloudCalls.filter(c=>c.command==="workflow_call_model").length')==0
            panel.get_by_label('测试空白卷无学生姓名',exact=True).check()
            assert page.evaluate('testCommands.filter(c=>c==="account_generation_begin").length')==0
            assert page.evaluate('testCloudCalls.filter(c=>c.command==="workflow_call_model"&&c.args.request.stage==="guidance").length')==0
            panel.get_by_label('双模式生成内容',exact=True).select_option('dictation')
            page.evaluate('testCloudBadCloze=true')
            panel.get_by_role('button',name='开始真实内容测试',exact=True).click()
            expect(panel.get_by_test_id('workflow-cloud-message')).to_contain_text('部分个人目标未覆盖')
            expect(panel.get_by_text('填回答案后无法逐字还原完整知识句',exact=False).first).to_be_visible()
            audit=page.evaluate('testCloudCalls.filter(c=>c.command==="workflow_save_diagnostic").at(-1).args.report')
            assert any(v['reason']=='statement_not_restored' for v in audit['validations'])
            assert any(v['reason']=='blind_fill_ambiguous' for v in audit['validations'])
            assert '模拟学生甲' not in json.dumps(audit,ensure_ascii=False)
            page.evaluate('testCloudBadCloze=false')
            page.evaluate("testCloudFactReject=true;testCloudModelVersion='0123456789abcdff'")
            panel.get_by_role('button',name='开始真实内容测试',exact=True).click()
            expect(panel.get_by_test_id('workflow-cloud-message')).to_contain_text('部分个人目标未覆盖')
            expect(panel.get_by_text('独立核验认为知识句存在事实错误',exact=False).first).to_be_visible()
            expect(panel.get_by_text('独立核验未找到足够的文字或学科依据',exact=False).first).to_be_visible()
            expect(panel.get_by_text('独立核验认为背景、限定条件或适用范围不完整',exact=False).first).to_be_visible()
            audit=page.evaluate('testCloudCalls.filter(c=>c.command==="workflow_save_diagnostic").at(-1).args.report')
            assert {v['reason'] for v in audit['validations']}=={'fact_inaccurate','fact_unsupported','fact_context_incomplete'}
            assert not page.evaluate('testCloudKeyPresent')
            page.evaluate('testCloudFactReject=false')
            page.evaluate("testCloudRecognitionMismatch=true;testCloudModelVersion='0123456789abcdea'")
            panel.get_by_role('button',name='开始真实内容测试',exact=True).click()
            expect(panel.get_by_test_id('workflow-cloud-message')).to_contain_text('部分个人目标未覆盖')
            expect(panel.get_by_text('多次识题的实质内容仍不一致',exact=False).first).to_be_visible()
            expect(panel).to_contain_text('未建立知识目标的原题 1 道')
            audit=page.evaluate('testCloudCalls.filter(c=>c.command==="workflow_save_diagnostic").at(-1).args.report')
            assert audit['recognitions'][0]['reason']=='content_mismatch'
            assert audit['skipped'][0]['reason']=='recognition_ambiguous'
            assert audit['callCount']==3
            page.evaluate('testCloudRecognitionMismatch=false')
            page.evaluate('testCloudHang=true')
            panel.get_by_role('button',name='开始真实内容测试',exact=True).click()
            page.wait_for_function('testCloudReject!==null')
            panel.get_by_role('button',name='停止内容测试',exact=True).click()
            expect(panel.get_by_test_id('workflow-cloud-message')).to_contain_text('已停止内容测试')
            assert not page.evaluate('testCloudKeyPresent')
            expect(panel.get_by_role('button',name='继续已保存任务',exact=True)).to_be_visible()
            page.reload();open_workflow_tools(page)
            page.get_by_role('navigation',name='功能入口').get_by_role('button',name='生成报告').click();open_workflow_tools(page)
            panel=page.get_by_role('region',name='云端模型双模式测试',exact=True)
            panel.get_by_text('本机已保存任务',exact=False).click()
            panel.get_by_role('button',name='查看保存结果',exact=True).first.click()
            expect(panel.get_by_role('button',name='继续已保存任务',exact=True)).to_be_visible()
            panel.get_by_role('button',name='继续已保存任务',exact=True).click()
            expect(panel.get_by_test_id('workflow-cloud-message')).to_contain_text('模型配置不同')
            page.evaluate("testCloudModelVersion='0123456789abcdea'")
            panel.get_by_role('button',name='继续已保存任务',exact=True).click()
            expect(panel.get_by_test_id('workflow-cloud-message')).to_contain_text('有请求结果未知')
            assert page.evaluate('testCloudCalls.filter(c=>c.command==="workflow_call_model").length')==0
            assert not errors,errors
            print('PASS: local file check, both modes, SQLite IPC persistence, reload/view without model calls, unknown request gate and cancellation key cleanup.')
            browser.close()
    finally:
        server.shutdown();server.server_close()

if __name__=='__main__':main()
