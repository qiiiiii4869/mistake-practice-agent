"""Paper recognition IPC is simulated; this test sends no images to any service."""
import json
from functools import partial
from http.server import ThreadingHTTPServer
from threading import Thread
from playwright.sync_api import expect,sync_playwright
from check_desktop_ui import MOCK,QuietHandler,ROOT
from check_agent_ui import workspace,EXTRA

VISION=r"""
window.testVisionCalls=[];window.testVisionError=false;
const priorVision=window.__TAURI_INTERNALS__.invoke;
window.__TAURI_INTERNALS__.invoke=async(command,args)=>{
 if(command==='call_deepseek'&&args.request.stage==='recognize_paper'){
  testVisionCalls.push(structuredClone(args.request));if(testVisionError)throw 'model_quota_exhausted';
  return {questions:[{number:'1',stem:'图片识别的新题干及选项',confidence:'low'}],warnings:['图形部分需要教师核对']};
 }
 return priorVision(command,args);
};
"""
def main():
 server=ThreadingHTTPServer(('127.0.0.1',0),partial(QuietHandler,directory=str(ROOT/'app/apps/desktop/dist')));Thread(target=server.serve_forever,daemon=True).start()
 try:
  with sync_playwright() as p:
   browser=p.chromium.launch(channel='msedge',headless=True);page=browser.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
   page.add_init_script(MOCK+'\nwindow.testStored='+json.dumps({'revision':1,'snapshot':workspace()})+';'+EXTRA+VISION)
   page.goto(f'http://127.0.0.1:{server.server_port}/');paper=page.get_by_role('region',name='试卷题干核对',exact=True)
   paper.get_by_text('DeepSeek 识别当前照片',exact=True).click();button=paper.get_by_role('button',name='识别当前已保存照片',exact=True)
   expect(button).to_be_disabled();paper.get_by_label('确认照片不含学生姓名',exact=True).check();button.click()
   preview=paper.get_by_role('region',name='照片识别结果预览',exact=True);expect(preview).to_be_visible();expect(preview).to_contain_text('识别不确定')
   expect(paper.get_by_label('题干',exact=True)).to_have_value('说明光合作用的意义。');assert page.evaluate('testVisionCalls[0].data')=={'pageId':'page-1'}
   preview.get_by_role('button',name='放弃识别结果',exact=True).click();expect(paper.get_by_label('已核对题干',exact=True)).to_be_checked()
   button.click();preview.get_by_role('button',name='采用识别草稿',exact=True).click();expect(paper.get_by_label('题干',exact=True)).to_have_value('图片识别的新题干及选项');expect(paper.get_by_label('已核对题干',exact=True)).not_to_be_checked()
   assert page.evaluate('testStored.snapshot.paper.questions[0].stem')=='说明光合作用的意义。'
   paper.get_by_role('button',name='保存试卷与核对结果',exact=True).click();expect(page.get_by_test_id('workspace-message')).to_contain_text('已校验并保存')
   assert page.evaluate('testStored.snapshot.paper.questions[0].confirmed') is False
   print('PASS: blank-paper confirmation, saved-page-only request, preview/discard, uncertain results and no automatic approval or save.')
   page.evaluate('testVisionError=true');button.click();expect(paper.get_by_role('status')).to_contain_text('额度已耗尽');expect(preview).to_have_count(0)
   expect(paper.get_by_label('题干',exact=True)).to_have_value('图片识别的新题干及选项');assert not errors,errors
   print('PASS: quota failure preserves paper draft and cannot silently replace teacher text.')
   browser.close()
 finally:server.shutdown();server.server_close()
if __name__=='__main__':main()
