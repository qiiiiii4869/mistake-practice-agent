"""Audit locally downloaded full-class files without printing student identifiers."""
import argparse
import hashlib
import json
import math
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def load(path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def audit(folder: Path, output: Path):
    candidates = sorted(folder.glob("student-class*.json"), key=lambda path: path.stat().st_mtime, reverse=True)
    if not candidates:
        raise ValueError("full_class_download_not_found")
    data_path = candidates[0]
    data = load(data_path)
    summary = data["summary"]
    verification_path = next((path for path in sorted(folder.glob("verification-full*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
                              if load(path).get("summary", {}).get("finished_at") == summary.get("finished_at")), None)
    if verification_path is None:
        raise ValueError("matching_verification_not_found")
    verification = load(verification_path)
    if not data.get("ok") or not verification.get("ok"):
        raise ValueError("export_reported_failure")
    if summary.get("status") != "passed_live_full_class_export" or summary.get("export_scope") != "full_class_scores_only":
        raise ValueError("not_a_full_class_export")
    if verification["summary"] != summary:
        raise ValueError("verification_summary_mismatch")
    if summary.get("authentication") != "verified_teacher_session":
        raise ValueError("teacher_session_not_verified")
    students = data["data"]["students"]
    unavailable = data["data"].get("unavailable_students", [])
    expected = summary["roster"]["student_count"]
    records = summary["question_records"]
    if (len(students) + len(unavailable) != expected or len(students) != records["exported_students"]
            or len(unavailable) != records.get("not_scanned_students", 0) + records.get("no_original_paper_students", 0)):
        raise ValueError("student_count_mismatch")
    if not students:
        raise ValueError("no_scanned_students")
    if records.get("failures") or records.get("unprocessed_students"):
        raise ValueError("incomplete_student_processing")
    # Only roster signals (没扫, or the official no-original-paper rule) may exclude a student; never a failed request.
    allowed_reasons = {"not_scanned": {"roster_score_column"},
                       "no_original_paper": {"roster_has_origin_paper", "roster_rank_code"}}
    for student in unavailable:
        if (student.get("reason_source") not in allowed_reasons.get(student.get("availability"), set())
                or student.get("questions") != []):
            raise ValueError("invalid_unavailable_student")
    if sum(student["availability"] == "not_scanned" for student in unavailable) != records.get("not_scanned_students", 0):
        raise ValueError("student_count_mismatch")
    identifiers = [student["student_id"] for student in students + unavailable]
    if len(set(identifiers)) != len(identifiers):
        raise ValueError("duplicate_student_identifiers")
    counts = dict(correct=0, incorrect=0, partial_credit=0, not_scored=0)
    expected_schema = None
    question_counts = []
    for student in students:
        questions = student["questions"]
        if not questions:
            raise ValueError("empty_question_list")
        numbers = [str(question["question_number"]) for question in questions]
        if len(numbers) != len(set(numbers)):
            raise ValueError("duplicate_question_numbers")
        schema = {str(question["question_number"]): question["full_score"] for question in questions}
        if expected_schema is not None and schema != expected_schema:
            raise ValueError("question_number_or_full_score_mismatch")
        expected_schema = schema
        for question in questions:
            score, full_score = question["score"], question["full_score"]
            if not all(type(value) in (int, float) and math.isfinite(value) for value in (score, full_score)) or not 0 <= score <= full_score:
                raise ValueError("invalid_score")
            result = "not_scored" if full_score == 0 else "correct" if score == full_score else "incorrect" if score == 0 else "partial_credit"
            if question.get("result") != result or question.get("lost_points") != (score < full_score):
                raise ValueError("incorrect_result_label")
            if any(key in question for key in ("student_answer", "subjective_answer_present", "image_url")):
                raise ValueError("unexpected_answer_or_image_field")
            counts[result] += 1
        question_counts.append(len(questions))
    if counts != summary.get("result_counts") or sum(question_counts) != records["question_count"]:
        raise ValueError("question_totals_mismatch")
    raw = data_path.read_text(encoding="utf-8-sig")
    if any(key in raw for key in ('"token":', '"Cookie":', '"cookie":', 'https://')):
        raise ValueError("unexpected_credentials_or_remote_media")
    report = {
        "checked_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "source_finished_at": summary["finished_at"],
        "live_full_class_scores_verified": True,
        "roster_student_count": expected,
        "exported_student_count": len(students),
        "not_scanned_student_count": sum(student["availability"] == "not_scanned" for student in unavailable),
        "no_original_paper_student_count": sum(student["availability"] == "no_original_paper" for student in unavailable),
        "total_question_records": sum(question_counts),
        "questions_per_student_min": min(question_counts),
        "questions_per_student_max": max(question_counts),
        "question_numbers": list(expected_schema),
        "result_counts": counts,
        "question_numbers_and_full_scores_consistent": True,
        "answer_card_images_required": False,
        "teacher_uploaded_paper_match": "not_verified",
        "data_file_sha256": hashlib.sha256(data_path.read_bytes()).hexdigest(),
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--folder", type=Path, default=Path.home() / "Downloads" / "zhixue-auto-export")
    parser.add_argument("--output", type=Path, default=ROOT / "output" / "full-class-verification-audit.json")
    args = parser.parse_args()
    try:
        print(json.dumps(audit(args.folder, args.output), ensure_ascii=False, indent=2))
    except (ValueError, KeyError, TypeError, OSError) as error:
        print(json.dumps({"verified": False, "reason": str(error)}, ensure_ascii=False))
        raise SystemExit(1)
