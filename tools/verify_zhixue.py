"""Read-only Zhixue integration probe. Credentials and raw student data stay in memory."""
from __future__ import annotations

import argparse
import json
import math
import re
import time
from datetime import datetime
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "tmp" / "zhixue-verification.json"
LOGIN = "https://www.zhixue.com/wap_login.html"
SCHEMA_KEYS = frozenset("""
errorCode errorInfo result role id name loginName userId userName schoolId schoolName
classId className gradeCode gradeName subjectCode subjectName topicSetId examId examName
data classPaperSummaryList pageInfo allPages pageIndex pageSize total totalCount count list
rows students studentList userList classList examSubjectList zxSubjects termTeachingCycleMap
termId teachingCycleId circlesYear beginTime endTime createDateTime isFinal isMultiSubject
answerRecordDetails topicNumber dispTitle answer score standardScore isCorrect answerType
subTopics subTopicIndex teacherMarkingRecords userAnswerRecordDTO sheetImages roles
teacher classes clazzs code items records status message success
""".split())


class ParseFailure(ValueError):
    pass


def extract_json_variable(html: str, variable: str):
    match = re.search(r"\b(?:var|let|const)\s+" + re.escape(variable) + r"\s*=\s*", html)
    if not match:
        raise ParseFailure(f"missing_{variable}")
    try:
        return json.JSONDecoder().raw_decode(html[match.end():])[0]
    except json.JSONDecodeError:
        raise ParseFailure(f"invalid_{variable}") from None


def summarize_paper(html: str) -> dict:
    """Require actual score fields; an empty or changed page must never pass."""
    sheet = extract_json_variable(html, "sheetDatas")
    if not isinstance(sheet, dict):
        raise ParseFailure("invalid_sheetDatas_type")
    record = sheet.get("userAnswerRecordDTO")
    if not isinstance(record, dict):
        raise ParseFailure("missing_userAnswerRecordDTO")
    details = record.get("answerRecordDetails")
    if not isinstance(details, list) or not details:
        raise ParseFailure("missing_or_empty_answerRecordDetails")
    required = {"topicNumber", "score", "standardScore", "answerType"}
    if any(not isinstance(d, dict) or not required.issubset(d) for d in details):
        raise ParseFailure("missing_question_fields")
    if any(type(d[k]) not in (int, float) for d in details for k in ("score", "standardScore")):
        raise ParseFailure("invalid_score_type")
    if any(not math.isfinite(d[k]) for d in details for k in ("score", "standardScore")):
        raise ParseFailure("nonfinite_score")
    if any(d["score"] < 0 or d["standardScore"] < 0 or d["score"] > d["standardScore"] for d in details):
        raise ParseFailure("invalid_score_range")
    objective = [d for d in details if d["answerType"] == "s01Text"]
    subjective = [d for d in details if d["answerType"] == "s02Image"]
    subtopics = [s for d in details for s in d.get("subTopics", []) if isinstance(s, dict)]
    try:
        images = extract_json_variable(html, "sheetImages")
    except ParseFailure:
        images = []
    return {
        "status": "passed_live",
        "question_count": len(details),
        "objective_count": len(objective),
        "subjective_count": len(subjective),
        "lost_score_question_count": sum(d["score"] < d["standardScore"] for d in details),
        "objective_answer_present_count": sum(bool(d.get("answer")) for d in objective),
        "explicit_correctness_count": sum(type(d.get("isCorrect")) is bool for d in details),
        "subquestion_score_count": sum(type(s.get("score")) in (int, float) for s in subtopics),
        "answer_sheet_image_count": len(images) if isinstance(images, list) else 0,
        "question_text_and_standard_answers": "not_verified",
        "note": "Lost points identify questions for review; they do not establish a specific misconception.",
    }


def shape(value, depth=0):
    """Return structure only; never persist names, identifiers, cookies, or answers."""
    if depth >= 3:
        return type(value).__name__
    if isinstance(value, dict):
        result = {k: shape(v, depth + 1) for k, v in value.items() if k in SCHEMA_KEYS}
        unknown_count = sum(k not in SCHEMA_KEYS for k in value)
        if unknown_count:
            result["unlisted_field_count"] = unknown_count
        return result
    if isinstance(value, list):
        return {"type": "list", "count": len(value), "item": shape(value[0], depth + 1) if value else None}
    return type(value).__name__


def save(report):
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    report["updated_at"] = datetime.now().astimezone().isoformat(timespec="seconds")
    temporary = REPORT.with_suffix(".tmp")
    temporary.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(REPORT)


def run(minutes: int, channel: str):
    from playwright.sync_api import sync_playwright

    report = {
        "mode": "live_read_only_probe",
        "status": "starting",
        "authentication": "waiting_for_user_login",
        "teacher_exams": "not_verified",
        "class_student_roster": "not_verified",
        "student_question_records": "not_verified",
        "observed_read_endpoints": [],
        "saves_raw_student_data": False,
        "saves_credentials": False,
    }
    save(report)
    print("Probe starting; sign in yourself in the dedicated browser. No password is requested by this tool.", flush=True)
    with sync_playwright() as playwright:
        # This site is reachable directly; the host's local HTTP proxy times out.
        # Apply direct routing only to this dedicated test browser.
        browser = playwright.chromium.launch(channel=channel, headless=False, args=["--no-proxy-server"])
        context = browser.new_context(no_viewport=True)

        def observe(response):
            parsed = urlsplit(response.url)
            if parsed.hostname != "www.zhixue.com":
                return
            path = parsed.path
            # Observe only known read endpoints. Login requests and payloads are ignored.
            if not any(marker in path for marker in (
                "/container/getCurrentUser", "/classReportList", "/examInfo",
                "/getExportStudentInfo", "/getStudentStatus", "/student/checksheet",
            )):
                return
            event = {"path": path, "http_status": response.status}
            try:
                body = response.text()
                if "/student/checksheet" in path:
                    summary = summarize_paper(body)
                    report["student_question_records"] = summary
                    # Compare the unchanged upstream parser with the strict probe.
                    from zhixuewang.teacher.teacher import TeacherAccount
                    original = TeacherAccount._parse_original_paper_html(None, body, "", "")
                    event["upstream_question_count"] = len(original.answer_details)
                    event["strict_question_count"] = summary["question_count"]
                    event["parsers_agree_on_count"] = len(original.answer_details) == summary["question_count"]
                    report["status"] = "student_records_verified"
                else:
                    data = json.loads(body)
                    event["response_shape"] = shape(data)
                    if "/container/getCurrentUser" in path:
                        result = data.get("result") if isinstance(data, dict) else None
                        role = result.get("role") if isinstance(result, dict) else None
                        if role in ("teacher", "student", "parent"):
                            report["authentication"] = f"verified_{role}_session"
                        elif result:
                            report["authentication"] = "session_present_role_unconfirmed"
                    # Shape is evidence for follow-up, never automatically a passed data test.
                    if "/classReportList" in path:
                        report["teacher_exams"] = {"status": "response_observed_needs_review", "shape": shape(data)}
                    if "/getExportStudentInfo" in path or "/getStudentStatus" in path:
                        report["class_student_roster"] = {"status": "response_observed_needs_review", "shape": shape(data)}
            except ParseFailure as exc:
                event["parse_failure"] = str(exc)
                report["student_question_records"] = {"status": "failed_parse", "reason": str(exc)}
            except Exception as exc:
                event["error_type"] = type(exc).__name__
            report["observed_read_endpoints"].append(event)
            report["observed_read_endpoints"] = report["observed_read_endpoints"][-30:]
            save(report)

        context.on("response", observe)
        page = context.new_page()
        report["status"] = "waiting_for_login"
        save(report)
        try:
            page.goto(LOGIN, wait_until="domcontentloaded", timeout=45000)
            report["login_page"] = {"status": "opened", "title": page.title()}
        except Exception as exc:
            report["login_page"] = {"status": "navigation_failed", "error_type": type(exc).__name__, "error": str(exc)[:400]}
        save(report)
        print("Browser ready. After login, open an exam, a class, and one student's answer-sheet/detail page.", flush=True)
        deadline = time.monotonic() + minutes * 60
        next_check = time.monotonic() + 15
        try:
            while time.monotonic() < deadline and context.pages:
                context.pages[0].wait_for_timeout(1000)
                if time.monotonic() >= next_check and any("/htm-vessel/" in p.url or "/container/" in p.url for p in context.pages):
                    next_check = time.monotonic() + 30
                    try:
                        response = context.request.get("https://www.zhixue.com/container/getCurrentUser", timeout=10000)
                        data = response.json()
                        result = data.get("result") if isinstance(data, dict) else None
                        role = result.get("role") if isinstance(result, dict) else None
                        if role in ("teacher", "student", "parent"):
                            report["authentication"] = f"verified_{role}_session"
                            save(report)
                    except Exception:
                        pass
        except Exception as exc:
            report["browser_end_reason"] = type(exc).__name__
        finally:
            if report["status"] != "student_records_verified":
                report["status"] = "incomplete"
            save(report)
            browser.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--minutes", type=int, default=30)
    parser.add_argument("--channel", choices=("msedge", "chrome"), default="msedge")
    args = parser.parse_args()
    run(args.minutes, args.channel)
