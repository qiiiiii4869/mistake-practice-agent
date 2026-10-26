"""Desktop UI checks with synthetic Tauri responses; never a live-login claim."""
import json
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
MOCK = r"""
window.testScenario = 'success';
window.testOpened = false;
window.testCommands = [];
window.testStored = JSON.parse(sessionStorage.getItem('synthetic-workspace') ?? '{"revision":0,"snapshot":null}');
window.testSaveFailure = false;
window.__TAURI_INTERNALS__ = {invoke: async (command, args) => {
  window.testCommands.push(command);
  if (command === 'load_workspace') return structuredClone(window.testStored);
  if (command === 'save_workspace') {
    if (window.testSaveFailure) throw 'storage_failed';
    if (args.expectedRevision !== window.testStored.revision) throw 'storage_conflict';
    window.testStored = {revision: window.testStored.revision + 1, snapshot: structuredClone(args.snapshot)};
    sessionStorage.setItem('synthetic-workspace', JSON.stringify(window.testStored));
    return structuredClone(window.testStored);
  }
  if (command === 'read_subjects') {
    if (window.testScenario === 'subject_error') return {ok:false,summary:{error:'no_authorized_exam_subjects'}};
    return {ok:true,summary:{},subjects:[{id:'p-test',name:'模拟生物',code:'bio'},
      ...(window.testScenario === 'multi' ? [{id:'math-paper',name:'模拟数学',code:'math'}] : [])],
      teachingClasses:[{id:'c-test',name:'模拟三班',subjects:[{code:'bio',name:'模拟生物'}]},
      ...(window.testScenario === 'multi' ? [{id:'math-class',name:'模拟四班',subjects:[{code:'math',name:'模拟数学'}]}] : [])]};
  }
  if (command === 'probe_progress') return null;
  if (command === 'read_class_scores') {
    await new Promise(resolve => setTimeout(resolve, 150));
    if (window.testScenario === 'partial_export') return {ok:false,summary:{...window.testExport.summary,status:'incomplete_live_export'},data:window.testExport.data};
    return structuredClone(window.testExport);
  }
  if (command === 'login_status') return {open: window.testOpened,
    host: window.testOpened ? 'www.zhixue.com' : null, captcha_60500: false};
  if (command === 'open_login') { window.testOpened = true; return; }
  if (command === 'save_diagnostic') return 'C:/LOCAL-TEST/diagnostics/tauri-login-verification.json';
  if (command !== 'read_exam_list') throw 'unexpected_command';
  await new Promise(resolve => setTimeout(resolve, 150));
  if (window.testScenario === 'transport_error') throw 'probe_page_changed';
  if (window.testScenario === 'failed' || window.testScenario === 'captcha') return {ok: false,
    summary: {status: 'failed', authentication: 'not_verified', endpoints: [],
      error: window.testScenario === 'captcha' ? 'business_error_60500' : 'teacher_session_required'},
    options: [], teachingClasses: []};
  return {ok: true, summary: {status: 'connected', authentication: 'verified_teacher_session',
    exams: {status: 'passed_live', count: 1, scope: 'latest_term_first_page'},
    endpoints: [{host: 'ali-bg.zhixue.com', path: '/api-teacher/newContainer/getClassReportList',
      status: 'received_json', http_status: 200}]},
    options: [{id: 'e-test', name: '模拟考试 · 仅供界面验证'}, ...(window.testScenario === 'multi' ? [{id:'e-other',name:'第二场模拟考试'}] : [])],
    teachingClasses: [{id: 'c-test', name: '模拟班级', subjects: [{code: 'bio', name: '生物'}]}]};
}};
"""


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_):
        pass


def main():
    dist = ROOT / "app/apps/desktop/dist"
    if not (dist / "index.html").exists():
        raise SystemExit("Run npm run build from app/ first")
    server = ThreadingHTTPServer(("127.0.0.1", 0), partial(QuietHandler, directory=str(dist)))
    Thread(target=server.serve_forever, daemon=True).start()
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(channel="msedge", headless=True)
            page = browser.new_page(viewport={"width": 1060, "height": 860})
            errors = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            from test_full_class_audit import fixture
            synthetic = fixture()
            synthetic["data"].update(exam_id="e-test", subject_id="p-test", class_id="c-test")
            for index, student in enumerate(synthetic["data"]["students"]):
                student["student_name"] = f"模拟学生{index + 1}"
            synthetic["summary"]["roster"]["student_count"] = 3
            synthetic["summary"]["question_records"]["no_original_paper_students"] = 1
            synthetic["data"]["unavailable_students"] = [{"student_id":"SYNTHETIC_3", "student_name":"模拟学生3",
                "availability":"no_original_paper", "reason_source":"roster_rank_code", "questions":[]}]
            page.add_init_script(MOCK + "\nwindow.testExport = " + json.dumps(synthetic) + ";")
            page.goto(f"http://127.0.0.1:{server.server_port}/")
            read = page.get_by_role("button", name="读取考试列表", exact=True)
            expect(read).to_be_disabled()
            page.get_by_role("button", name="登录智学网", exact=True).click()
            expect(read).to_be_enabled()
            read.click()
            expect(page.get_by_role("button", name="正在读取…", exact=True)).to_be_disabled()
            expect(page.get_by_text("验证通过", exact=True)).to_be_visible()
            expect(page.get_by_role("heading", name="当前学期考试", exact=True)).to_have_count(0)
            expect(page.get_by_role("region", name="读取结果", exact=True)).to_have_count(0)
            expect(page.get_by_label("选择考试", exact=True)).to_be_enabled()
            print("PASS: login gate and successful read keep exam selection without a duplicate exam-list card.")
            (ROOT / "tmp").mkdir(exist_ok=True)
            page.screenshot(path=str(ROOT / "tmp/desktop-ui-mock.png"), full_page=True)

            page.evaluate("testScenario = 'failed'")
            read.click()
            expect(page.get_by_role("status")).to_contain_text("还未确认教师登录")
            expect(page.get_by_text("验证通过", exact=True)).to_have_count(0)
            expect(page.get_by_text("模拟考试 · 仅供界面验证", exact=True)).to_have_count(0)
            expect(page.get_by_text("诊断已保存：", exact=False)).to_have_count(0)
            page.get_by_role("button", name="保存匿名诊断").click()
            expect(page.get_by_text("诊断已保存：", exact=False)).to_contain_text("LOCAL-TEST")
            print("PASS: failed authentication clears prior success and exams, and still allows diagnostic save.")

            page.evaluate("testScenario = 'captcha'")
            read.click()
            expect(page.get_by_role("status")).to_contain_text("60500")
            expect(page.get_by_text("验证通过", exact=True)).to_have_count(0)
            print("PASS: 60500 remains a failure and explains the fallback.")

            page.evaluate("testScenario = 'transport_error'")
            read.click()
            expect(page.get_by_role("status")).to_contain_text("页面发生了跳转")
            expect(page.get_by_role("button", name="保存匿名诊断")).to_have_count(0)
            expect(read).to_be_enabled()
            page.evaluate("testScenario = 'success'")
            read.click()
            class_read = page.get_by_role("button", name="读取全班逐题得分", exact=True)
            expect(class_read).to_be_enabled()
            class_read.click()
            current = page.get_by_role("region", name="本机当前考试", exact=True)
            expect(current).to_be_visible()
            assert page.evaluate("testStored.snapshot.source.kind") == "zhixue_webview"
            assert page.evaluate("testStored.snapshot.students.length") == 3
            expect(current.get_by_text("模拟三班 · 模拟生物", exact=False)).to_be_visible()
            expect(current.locator("table").first.locator("tbody tr").nth(1).locator("td").last).to_have_text("2")
            print("PASS: live-class command is audited, saved and analyzed with unavailable student excluded.")
            roster=current.get_by_label("学生名单与逐题得分",exact=True)
            expect(roster).to_be_visible()
            expect(roster.locator("tbody tr").first.locator("td").nth(2)).to_have_text("3")
            roster.get_by_text("查看逐题得分",exact=True).first.click()
            expect(roster).to_contain_text("第 1 题：2 / 2")
            expect(roster.locator("tbody tr").last).to_contain_text("无逐题记录")
            print("PASS: student roster is visible by default, per-question sums and score details are available, unavailable pupils remain unjudged.")

            current.get_by_text("本场教师设置", exact=True).click()
            current.get_by_label("部分得分纳入", exact=True).select_option("false")
            current.get_by_role("button", name="保存设置并重算").click()
            expect(current.locator("table").first.locator("tbody tr").nth(1).locator("td").last).to_have_text("0")
            assert page.evaluate("testStored.snapshot.settings.includePartialCredit") is False
            print("PASS: teacher settings persist and recompute the partial-credit selection.")

            paper = page.get_by_role("region", name="试卷题干核对", exact=True)
            import base64
            png = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=")
            paper.get_by_label("添加试卷照片", exact=True).set_input_files({"name":"synthetic.png", "mimeType":"image/png", "buffer":png})
            expect(page.get_by_test_id("workspace-message")).to_contain_text("已校验并保存")
            paper.get_by_text("手动查看或修正题干（可选）", exact=True).click()
            expect(paper.get_by_label("题干", exact=True)).to_be_enabled()
            paper.get_by_label("题干", exact=True).fill("模拟题干及选项")
            paper.get_by_label("已核对题干", exact=True).check()
            paper.get_by_label("题干", exact=True).fill("修改后的模拟题干及选项")
            expect(paper.get_by_label("已核对题干", exact=True)).not_to_be_checked()
            paper.get_by_label("已核对题干", exact=True).check()
            paper.get_by_role("button", name="保存试卷与核对结果", exact=True).click()
            expect(page.get_by_test_id("workspace-message")).to_contain_text("已校验并保存")
            assert page.evaluate("testStored.snapshot.paper.questions[0].confirmed") is True
            page.reload()
            paper.get_by_text("手动查看或修正题干（可选）", exact=True).click()
            expect(paper.get_by_label("题干", exact=True)).to_have_value("修改后的模拟题干及选项")
            expect(paper.get_by_label("已核对题干", exact=True)).to_be_checked()
            page.screenshot(path=str(ROOT / "tmp/desktop-paper-ui-mock.png"), full_page=True)
            page.get_by_role("button", name="登录智学网", exact=True).click()
            read.click()
            expect(class_read).to_be_enabled()
            print("PASS: paper import, confirmation invalidation, save and restart recovery.")

            old_revision = page.evaluate("testStored.revision")
            page.evaluate("testScenario = 'partial_export'")
            class_read.click()
            expect(page.get_by_test_id("workspace-message")).to_contain_text("导出记录包含失败")
            assert page.evaluate("testStored.revision") == old_revision
            expect(current).to_be_visible()
            page.evaluate("testScenario = 'success'")
            print("PASS: incomplete reads preserve the saved exam.")

            upload = page.get_by_label("导入扩展导出文件", exact=True)
            def import_pair(mismatch=False):
                verification = {"ok":True, "summary":json.loads(json.dumps(synthetic["summary"]))}
                if mismatch:
                    verification["summary"]["finished_at"] = "OTHER_TIME"
                upload.set_input_files([
                    {"name":"student-class.json", "mimeType":"application/json", "buffer":json.dumps(synthetic).encode()},
                    {"name":"verification-full.json", "mimeType":"application/json", "buffer":json.dumps(verification).encode()},
                ])
            import_pair(True)
            expect(page.get_by_test_id("workspace-message")).to_contain_text("不是同一次导出")
            assert page.evaluate("testStored.revision") == old_revision
            import_pair()
            confirm = page.get_by_role("region", name="确认替换考试", exact=True)
            expect(confirm).to_be_visible()
            assert page.evaluate("testStored.revision") == old_revision
            confirm.get_by_role("button", name="保留当前考试").click()
            expect(confirm).to_have_count(0)
            assert page.evaluate("testStored.revision") == old_revision
            import_pair()
            confirm.get_by_role("button", name="确认替换并保存").click()
            expect(current.get_by_text("Chrome 扩展导入", exact=False)).to_be_visible()
            assert page.evaluate("testStored.snapshot.source.kind") == "chrome_extension"
            assert page.evaluate("testStored.snapshot.paper === undefined") is True
            print("PASS: import requires matching paired files; replacement waits for explicit confirmation.")

            page.reload()
            expect(current).to_be_visible()
            expect(current.get_by_text("Chrome 扩展导入", exact=False)).to_be_visible()
            page.evaluate("testSaveFailure = true")
            current.get_by_text("本场教师设置", exact=True).click()
            current.get_by_label("每人题数上限", exact=True).fill("9")
            current.get_by_role("button", name="保存设置并重算").click()
            expect(page.get_by_test_id("workspace-message")).to_contain_text("本地存储未能确认完成")
            assert page.evaluate("testStored.snapshot.settings.maxQuestionsPerStudent") == 5
            page.evaluate("testSaveFailure = false")
            print("PASS: persisted data restores and failed saves do not report success.")

            page.screenshot(path=str(ROOT / "tmp/desktop-workspace-ui-mock.png"), full_page=True)
            current.get_by_role("button", name="清除当前考试", exact=True).click()
            clear = page.get_by_role("region", name="确认清除考试", exact=True)
            clear.get_by_role("button", name="取消清除", exact=True).click()
            expect(current).to_be_visible()
            current.get_by_role("button", name="清除当前考试", exact=True).click()
            clear.get_by_role("button", name="确认清除", exact=True).click()
            expect(current).to_have_count(0)
            assert page.evaluate("testStored.snapshot") is None
            page.reload()
            expect(page.get_by_test_id("workspace-message")).to_contain_text("本机暂无考试")
            expect(current).to_have_count(0)
            print("PASS: clear requires confirmation and remains cleared after reopening.")

            page.evaluate("testScenario = 'multi'")
            page.get_by_role("button", name="登录智学网", exact=True).click()
            read.click()
            exam_select = page.get_by_label("选择考试", exact=True)
            expect(exam_select).to_be_enabled()
            exam_select.select_option("e-test")
            subject_select = page.get_by_label("选择学科", exact=True)
            expect(subject_select).to_be_enabled()
            subject_select.select_option("p-test")
            expect(page.get_by_label("选择班级", exact=True)).to_have_value("c-test")
            subject_select.select_option("math-paper")
            expect(page.get_by_label("选择班级", exact=True)).to_have_value("math-class")
            expect(page.get_by_label("选择班级", exact=True).locator("option[value=c-test]")).to_have_count(0)
            page.evaluate("testScenario = 'subject_error'")
            exam_select.select_option("e-other")
            expect(page.get_by_label("选择学科", exact=True)).to_have_value("")
            expect(page.get_by_label("选择班级", exact=True)).to_have_value("")
            expect(class_read).to_be_disabled()
            print("PASS: class/subject pairs stay bound; failed exam switches clear stale selections.")
            assert not errors, errors
            browser.close()
            print("PASS: navigation/transport failure clears result and permits retry.")
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
