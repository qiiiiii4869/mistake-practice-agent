"""Export button and native IPC contract with synthetic saved batches only."""
import json
from functools import partial
from http.server import ThreadingHTTPServer
from threading import Thread
from playwright.sync_api import sync_playwright,expect
from check_desktop_ui import open_workflow_tools
from check_desktop_ui import MOCK,QuietHandler,ROOT
from check_agent_ui import EXTRA
EXPORT=r"""
window.testExports=[];window.testExportCancelled=false;window.testExportError=false;
const beforeExport=window.__TAURI_INTERNALS__.invoke;
window.__TAURI_INTERNALS__.invoke=async(command,args)=>{
 if(command==='deepseek_status')return {configured:false,quotaExhausted:false,model:'deepseek-flash',usage:{totalTokens:0}};
 if(command!=='export_practice_pdf')return beforeExport(command,args);
 testExports.push(structuredClone(args));if(testExportError)throw 'pdf_compile_failed';if(testExportCancelled)return null;
 return {folder:'C:/SYNTHETIC/错题补练',fileCount:args.layout==='individual'?3:1,complete:true};
};
"""
def main():
 server=ThreadingHTTPServer(('127.0.0.1',0),partial(QuietHandler,directory=str(ROOT/'app/apps/desktop/dist')));Thread(target=server.serve_forever,daemon=True).start()
 try:
  with sync_playwright() as p:
   browser=p.chromium.launch(channel='msedge',headless=True);page=browser.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
   snapshot=json.loads((ROOT/'tests/fixtures/practice-workspace-synthetic.json').read_text(encoding='utf-8'));snapshot['practice']['mode']='real'
   page.add_init_script(MOCK+'\nwindow.testStored='+json.dumps({'revision':7,'snapshot':snapshot})+';'+EXTRA+EXPORT)
   page.goto(f'http://127.0.0.1:{server.server_port}/');page.get_by_role('navigation',name='功能入口').get_by_role('button',name='生成报告').click();open_workflow_tools(page);agent=page.get_by_role('region',name='出题流程演示',exact=True)
   export=agent.get_by_role('button',name='导出 PDF',exact=True);expect(export).to_be_enabled();export.click()
   expect(agent.get_by_test_id('agent-message')).to_contain_text('已导出 1 份 PDF')
   assert page.evaluate('testExports[0]')=={'expectedRevision':7,'layout':'class','includeAnswers':True}
   agent.get_by_label('PDF 文件组织',exact=True).select_option('individual');agent.get_by_label('PDF 包含答案解析',exact=True).uncheck();export.click()
   expect(agent.get_by_test_id('agent-message')).to_contain_text('已导出 3 份 PDF');assert page.evaluate('testExports[1].includeAnswers') is False
   page.evaluate('testExportCancelled=true');export.click();expect(agent.get_by_test_id('agent-message')).to_contain_text('已取消导出')
   page.evaluate('testExportCancelled=false;testExportError=true');export.click();expect(agent.get_by_test_id('agent-message')).to_contain_text('PDF 编译未完成')
   assert page.evaluate('testStored.revision')==7
   print('PASS: saved approved real batch exports with revision/layout/answer controls, no model key, native cancellation and failure preserve exam.')
   agent.get_by_text('修改题目（修改后需重新自检与审核）',exact=True).first.click();agent.get_by_label('修改解析 q2-v1',exact=True).fill('未保存修改')
   expect(export).to_be_disabled();expect(agent).to_contain_text('当前修改尚未保存')
   assert not errors,errors;browser.close();print('PASS: edits invalidate export readiness until recheck, approval and save.')
 finally:server.shutdown();server.server_close()
if __name__=='__main__':main()
