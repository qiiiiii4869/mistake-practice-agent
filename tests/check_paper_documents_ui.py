"""Actual PDF/DOCX local rasterization under production CSP; synthetic model IPC."""
import io,json,zipfile,subprocess
from functools import partial
from http.server import ThreadingHTTPServer
from threading import Thread
from playwright.sync_api import sync_playwright,expect
from check_desktop_ui import open_workflow_tools
from check_desktop_ui import MOCK,ROOT
from check_knowledge_ui import CspHandler
from check_agent_ui import workspace,EXTRA
from check_deepseek_ui import DEEPSEEK_MOCK

def word(external=False):
 out=io.BytesIO()
 with zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED) as z:
  z.writestr('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
  z.writestr('_rels/.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
  z.writestr('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>合成空白卷 1. Explain photosynthesis.</w:t></w:r></w:p><w:tbl><w:tblPr><w:tblW w:w="8000" w:type="dxa"/></w:tblPr><w:tblGrid><w:gridCol w:w="4000"/><w:gridCol w:w="4000"/></w:tblGrid><w:tr><w:tc><w:p><w:r><w:t>A. Light</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B. Water</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>')
  if external:z.writestr('word/_rels/document.xml.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Type="image" Target="https://example.invalid/image.png" TargetMode="External"/></Relationships>')
 return out.getvalue()

def main():
 server=ThreadingHTTPServer(('127.0.0.1',0),partial(CspHandler,directory=str(ROOT/'app/apps/desktop/dist')));Thread(target=server.serve_forever,daemon=True).start()
 try:
  pdf=subprocess.check_output(['node','--input-type=module','-e',"import {pdfFixture} from './tests/pdf_fixture.mjs';process.stdout.write(pdfFixture());"],cwd=ROOT)
  with sync_playwright() as p:
   browser=p.chromium.launch(channel='msedge',headless=True)
   for name,mime,data in [('synthetic.pdf','application/pdf',pdf),('synthetic.docx','application/vnd.openxmlformats-officedocument.wordprocessingml.document',word()),('external.docx','application/vnd.openxmlformats-officedocument.wordprocessingml.document',word(True))]:
    page=browser.new_page();errors=[];network=[];page.on('pageerror',lambda e:errors.append(str(e)));page.on('request',lambda r:network.append(r.url))
    initial=workspace();initial['paper']={'pages':[],'questions':[]}
    page.add_init_script(MOCK+'\nwindow.testStored='+json.dumps({'revision':1,'snapshot':initial})+';'+EXTRA+DEEPSEEK_MOCK)
    page.goto(f'http://127.0.0.1:{server.server_port}/');paper=page.get_by_role('region',name='试卷题干核对',exact=True);agent=page.get_by_role('region',name='出题流程演示',exact=True)
    upload=paper.get_by_label('添加 PDF 试卷' if mime=='application/pdf' else '添加试卷照片',exact=True)
    if mime=='application/pdf':expect(upload).to_have_attribute('accept','.pdf,application/pdf')
    upload.set_input_files({'name':name,'mimeType':mime,'buffer':data});expect(paper.get_by_role('status')).to_contain_text('空白卷已保存到本机')
    assert page.evaluate('testStored.snapshot.paper.pages[0].data').startswith('data:application/');assert page.evaluate('testDeepseekCalls.length')==0
    page.get_by_role('navigation',name='功能入口').get_by_role('button',name='生成报告',exact=True).click();open_workflow_tools(page)
    agent.get_by_text('DeepSeek 模型设置',exact=True).click();agent.get_by_label('DeepSeek API Key',exact=True).fill('sk-synthetic-document-key');agent.get_by_role('button',name='启用 DeepSeek',exact=True).click();agent.get_by_label('确认空白卷不含学生姓名',exact=True).check();agent.get_by_role('button',name='生成结果',exact=True).click()
    if name=='external.docx':
     expect(agent.get_by_test_id('agent-message')).to_contain_text('请另存为 PDF');assert page.evaluate('testDeepseekCalls.length')==0
    else:
     expect(agent.get_by_test_id('agent-message')).to_contain_text('生成完成：2 道题',timeout=30000)
     pages=page.evaluate('testStored.snapshot.paper.pages');assert all(x['data'].startswith('data:image/jpeg;base64,') for x in pages)
     from pathlib import Path
     import base64
     (ROOT/'tmp').mkdir(exist_ok=True);(ROOT/'tmp'/f'paper-{name}.jpg').write_bytes(base64.b64decode(pages[0]['data'].split(',')[1]))
     assert page.evaluate('testDeepseekCalls.filter(r=>r.stage==="recognize_paper").length')==len(pages)*2
    assert not errors,errors
    assert not [url for url in network if url.startswith('http') and not url.startswith(f'http://127.0.0.1:{server.server_port}/')],network
    print('PASS:',name,'upload is deferred; production CSP, local conversion and model boundary verified.');page.close()
   browser.close()
 finally:server.shutdown();server.server_close()
if __name__=='__main__':main()
