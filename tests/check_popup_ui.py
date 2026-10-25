"""Local popup interaction checks. All Zhixue responses are synthetic."""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread

from playwright.sync_api import sync_playwright, expect


ROOT = Path(__file__).resolve().parents[1]
MOCK = r"""
window.testDownloads=[];
window.testCalls=[];
window.testScenario='single';
window.chrome={tabs:{query:async()=>[{id:1,url:'https://www.zhixue.com/htm-container-web/index.html'}],get:async id=>({id,url:'https://www.zhixue.com/htm-container-web/index.html'})},scripting:{executeScript:async({args})=>{
  const c=args[0];window.testCalls.push(c);let result;
  const multi=window.testScenario==='multi';
  const classes=[{id:'c1',name:'模拟三班',subjects:[{code:'bio',name:'生物'}]},
    ...(multi?[{id:'c2',name:'模拟四班',subjects:[{code:'bio',name:'生物'}]},
      {id:'c3',name:'模拟五班',subjects:[{code:'math',name:'数学'}]}]:[])];
  const base={status:'running',authentication:'verified_teacher_session',exams:'not_verified',endpoints:[]};
  if(c.action==='connect')result={ok:true,summary:{...base,status:'connected',exams:{status:'passed_live',count:multi?2:1}},
    options:[{id:'e1',name:'模拟考试（界面测试）'},...(multi?[{id:'e2',name:'第二场模拟考试'}]:[])],teachingClasses:classes};
  else if(c.action==='subjects') {
    if(window.testScenario==='subject_error')result={ok:false,summary:{...base,status:'failed',error:'no_authorized_exam_subjects'}};
    else result={ok:true,summary:{...base,status:'subjects_received'},teachingClasses:classes,
      subjects:[{id:'p1',name:'生物',code:'bio'},...(multi?[{id:'p2',name:'数学',code:'math'}]:[])]};
  } else if(c.action==='classes')throw new Error('Popup must use returned teaching scope, not another class request');
  else result={ok:true,summary:{...base,status:'passed_live_full_class_export',roster:{student_count:47},question_records:{exported_students:45,question_count:900,not_scanned_students:1,no_original_paper_students:1},result_counts:{correct:600,incorrect:200,partial_credit:100,not_scored:0}},data:{students:[]}};
  return [{result}];
}},downloads:{download:async({url,filename})=>{
  const body=await(await fetch(url)).json();window.testDownloads.push({filename,body});return window.testDownloads.length;
},search:async({id})=>[{id,state:window.testScenario==='download_error'?'interrupted':'complete'}]}};
"""


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_):
        pass


def main():
    handler = partial(QuietHandler, directory=str(ROOT / "browser-probe"))
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    Thread(target=server.serve_forever, daemon=True).start()
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(channel="msedge", headless=True)
            page = browser.new_page(viewport={"width": 440, "height": 900})
            page.add_init_script(MOCK)
            url = f"http://127.0.0.1:{server.server_port}/popup.html"

            page.goto(url + "?sourceTab=1")
            page.locator("#connect").click()
            expect(page.locator("#export")).to_be_enabled()
            expect(page.locator("#subject")).to_have_value("p1")
            expect(page.locator("#class")).to_have_value("c1")
            expect(page.locator("#class")).to_be_disabled()
            assert [c["action"] for c in page.evaluate("testCalls")] == ["connect", "subjects"]
            page.locator("#export").click()
            expect(page.locator("#result")).to_be_visible()
            downloads = page.evaluate("testDownloads")
            assert [d["filename"] for d in downloads] == [
                "zhixue-auto-export/verification-full.json", "zhixue-auto-export/student-class.json"
            ]
            assert downloads[0]["body"]["summary"]["exams"]["status"] == "passed_live"
            assert downloads[0]["body"]["summary"]["authentication"] == "verified_teacher_session"
            assert page.evaluate("testCalls.find(c=>c.action==='export').fullClass") is True
            expect(page.locator("#result")).to_contain_text("45 人 / 900")
            expect(page.locator("#result")).to_contain_text("没扫：1 人，无原卷：1 人")
            print("PASS: single class/subject selected automatically; download preserves earlier evidence; unscanned count shown.")

            page.evaluate("testScenario='download_error'")
            page.locator("#export").click()
            expect(page.locator("#status")).to_contain_text("文件下载未完成")
            expect(page.locator("#result")).to_be_hidden()
            print("PASS: interrupted download cannot be reported as a successful export.")

            page.goto(url)
            page.evaluate("testScenario='multi'")
            page.locator("#connect").click()
            expect(page.locator("#exam")).to_be_enabled()
            page.locator("#exam").select_option("e1")
            expect(page.locator("#subject")).to_be_enabled()
            page.locator("#subject").select_option("p1")
            expect(page.locator("#class")).to_be_enabled()
            assert page.locator("#class option").evaluate_all("nodes=>nodes.map(n=>n.value)") == ["", "c1", "c2"]
            page.locator("#class").select_option("c2")
            expect(page.locator("#export")).to_be_enabled()
            page.locator("#subject").select_option("p2")
            expect(page.locator("#class")).to_have_value("c3")
            expect(page.locator("#class")).to_be_disabled()
            print("PASS: multiple assignments keep subject/class pairs together.")

            page.evaluate("testScenario='subject_error'")
            page.locator("#exam").select_option("e2")
            expect(page.locator("#diagnostic")).to_be_visible()
            expect(page.locator("#export")).to_be_disabled()
            expect(page.locator("#class")).to_have_value("")
            expect(page.locator("#subject")).to_have_value("")
            page.locator("#diagnostic").click()
            page.wait_for_function("testDownloads.length===1")
            diagnostic = page.evaluate("testDownloads[0].body.summary")
            assert diagnostic["exams"]["status"] == "passed_live"
            assert diagnostic["error"] == "no_authorized_exam_subjects"
            print("PASS: failed exam switch clears stale choices and preserves connection evidence.")
            browser.close()
    finally:
        server.shutdown()
    print("All popup checks used synthetic responses; live account retest is still required.")


if __name__ == "__main__":
    main()
