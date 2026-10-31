"""Real local PDF.js parsing with synthetic Tauri storage; no accounts or textbooks."""
import json
import subprocess
from functools import partial
from http.server import ThreadingHTTPServer
from threading import Thread
from pathlib import Path
from playwright.sync_api import expect, sync_playwright
from check_desktop_ui import MOCK, QuietHandler, ROOT

KNOWLEDGE_MOCK = r"""
window.testLibrary = JSON.parse(sessionStorage.getItem('synthetic-library') ?? '{"revision":0,"documents":[]}');
window.testKnowledgeFailure = false;
const originalInvoke = window.__TAURI_INTERNALS__.invoke;
window.__TAURI_INTERNALS__.invoke = async (command,args) => {
  if (!['list_knowledge','import_knowledge','remove_knowledge','search_knowledge'].includes(command)) return originalInvoke(command,args);
  window.testCommands.push(command);
  if(command === 'list_knowledge') return structuredClone(testLibrary);
  if(testKnowledgeFailure) throw 'storage_failed';
  if(command === 'search_knowledge') return (testLibrary.content ?? []).flatMap(doc => doc.pages.filter(p=>p.text.includes(args.query)).map(p=>({documentId:doc.id,name:doc.name,page:p.number,ordinal:1,text:p.text})));
  if(args.expectedRevision !== testLibrary.revision) throw 'knowledge_conflict';
  if(command === 'import_knowledge') {
    testLibrary.content ??= [];
    testLibrary.content.push(args.document);
    const d=args.document;
    testLibrary.documents.push({id:d.id,name:d.name,pageCount:d.pages.length,chunkCount:d.pages.filter(p=>p.text).length,emptyPages:d.pages.filter(p=>!p.text).map(p=>p.number)});
  } else {
    testLibrary.documents = testLibrary.documents.filter(d=>d.id!==args.documentId);
    testLibrary.content = testLibrary.content.filter(d=>d.id!==args.documentId);
  }
  testLibrary.revision++;
  sessionStorage.setItem('synthetic-library',JSON.stringify(testLibrary));
  return structuredClone(testLibrary);
};
"""

class CspHandler(QuietHandler):
    extensions_map = {**QuietHandler.extensions_map, ".mjs": "text/javascript"}
    def end_headers(self):
        self.send_header('Content-Security-Policy', "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; base-uri 'self'; frame-src 'none'; worker-src 'self' blob:")
        super().end_headers()

def fixture(empty=False):
    return subprocess.check_output(['node','--input-type=module','-e',f"import {{pdfFixture}} from './tests/pdf_fixture.mjs'; process.stdout.write(pdfFixture({{empty:{str(empty).lower()}}}));"],cwd=ROOT)

def main():
    server=ThreadingHTTPServer(('127.0.0.1',0),partial(CspHandler,directory=str(ROOT/'app/apps/desktop/dist')))
    Thread(target=server.serve_forever,daemon=True).start()
    try:
        with sync_playwright() as playwright:
            browser=playwright.chromium.launch(channel='msedge',headless=True)
            page=browser.new_page(viewport={'width':1060,'height':900})
            errors=[]; remote=[]
            page.on('pageerror',lambda e:errors.append(str(e)))
            page.on('request',lambda req: remote.append(req.url) if not req.url.startswith(f'http://127.0.0.1:{server.server_port}/') and not req.url.startswith(('blob:','data:')) else None)
            page.add_init_script(MOCK+KNOWLEDGE_MOCK)
            page.goto(f'http://127.0.0.1:{server.server_port}/')
            page.get_by_role('navigation',name='功能入口').get_by_role('button',name='生成报告').click()
            library=page.get_by_role('region',name='本机知识库',exact=True)
            expect(library).to_contain_text('86 张内置卡')
            library.get_by_text('基础填空与情景出题方法（12 条）',exact=True).click()
            expect(library).to_contain_text('先定知识目标，再选情景')
            expect(library).to_contain_text('原对话的每专题至少12空')
            library.get_by_label('知识库检索词',exact=True).fill('遗传概率分母')
            library.get_by_role('button',name='检索知识库',exact=True).click()
            expect(library.get_by_label('生物出题方法检索结果',exact=True)).to_contain_text('遗传先建模型，再算分母')
            assert page.evaluate('testLibrary.documents.length')==0
            library.get_by_label('知识库检索词',exact=True).fill('PCR引物')
            library.get_by_role('button',name='检索知识库',exact=True).click()
            expect(library.get_by_text('引物定位与扩增片段',exact=True)).to_be_visible()
            expect(library.get_by_text('非教材原文或原题逐字摘录',exact=False).first).to_be_visible()
            assert page.evaluate('testLibrary.documents.length')==0
            upload=library.get_by_label('导入知识库 PDF',exact=True)
            expect(upload).to_be_enabled()
            upload.set_input_files({'name':'synthetic-textbook.pdf','mimeType':'application/pdf','buffer':fixture()})
            confirm=library.get_by_role('region',name='确认导入知识库',exact=True)
            expect(confirm).to_be_visible()
            expect(confirm).to_contain_text('Photosynthesis and DNA replication.')
            expect(confirm).to_contain_text('光合作用')
            expect(confirm).to_contain_text('1 页无文字层')
            assert page.evaluate('testLibrary.documents.length')==0
            confirm.get_by_role('button',name='取消导入',exact=True).click()
            expect(confirm).to_have_count(0)
            assert page.evaluate('testLibrary.documents.length')==0
            upload.set_input_files({'name':'synthetic-textbook.pdf','mimeType':'application/pdf','buffer':fixture()})
            expect(confirm).to_be_visible()
            page.evaluate('testKnowledgeFailure=true')
            confirm.get_by_role('button',name='确认导入知识库',exact=True).click()
            expect(library).to_contain_text('本机知识库存储失败')
            assert page.evaluate('testLibrary.documents.length')==0
            page.evaluate('testKnowledgeFailure=false')
            confirm.get_by_role('button',name='确认导入知识库',exact=True).click()
            expect(confirm).to_have_count(0)
            assert page.evaluate('testLibrary.content[0].pages[1].text')==''
            assert page.evaluate('testLibrary.documents[0].emptyPages')==[2]
            print('PASS: actual PDF parsing under CSP, page provenance, empty-page warning, cancel and failed import preservation.')
            page.reload()
            expect(library).to_contain_text('synthetic-textbook.pdf')
            library.get_by_label('知识库检索词',exact=True).fill('DNA')
            library.get_by_role('button',name='检索知识库',exact=True).click()
            results=library.get_by_label('知识库检索结果',exact=True)
            expect(results).to_contain_text('第 1 页')
            expect(results).to_contain_text('Photosynthesis and DNA replication.')
            page.screenshot(path=str(ROOT/'tmp/desktop-knowledge-ui-mock.png'),full_page=True)
            upload.set_input_files({'name':'renamed.pdf','mimeType':'application/pdf','buffer':fixture()})
            expect(library).to_contain_text('相同 PDF 已在知识库中')
            assert page.evaluate('testLibrary.revision')==1
            upload.set_input_files({'name':'empty.pdf','mimeType':'application/pdf','buffer':fixture(True)})
            expect(library).to_contain_text('没有可提取的文字')
            upload.set_input_files({'name':'broken.pdf','mimeType':'application/pdf','buffer':b'broken PDF'})
            expect(library).to_contain_text('PDF 文字提取失败')
            assert page.evaluate('testLibrary.revision')==1
            print('PASS: restart, source-bearing search, content-based duplicate detection, empty and malformed PDF rejection.')
            library.get_by_role('button',name='删除文档 synthetic-textbook.pdf',exact=True).click()
            delete=library.get_by_role('region',name='确认删除知识库文档',exact=True)
            delete.get_by_role('button',name='取消删除',exact=True).click()
            assert page.evaluate('testLibrary.documents.length')==1
            library.get_by_role('button',name='删除文档 synthetic-textbook.pdf',exact=True).click()
            delete.get_by_role('button',name='确认删除文档',exact=True).click()
            expect(delete).to_have_count(0)
            assert page.evaluate('testLibrary.documents.length')==0
            page.reload()
            expect(library.get_by_role('button',name='检索知识库',exact=True)).to_be_disabled()
            assert not errors,errors
            assert not remote,remote
            print('PASS: confirmed deletion and reopen, local-only PDF resources, no JavaScript errors.')
            browser.close()
    finally: server.shutdown();server.server_close()

if __name__=='__main__':main()
