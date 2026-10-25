import copy
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
from audit_full_class import audit


def fixture():
    summary = {
        "status": "passed_live_full_class_export", "export_scope": "full_class_scores_only",
        "authentication": "verified_teacher_session", "finished_at": "SYNTHETIC_TEST_TIME",
        "roster": {"student_count": 2},
        "question_records": {"exported_students": 2, "question_count": 4, "failures": [], "unprocessed_students": 0},
        "result_counts": {"correct": 2, "incorrect": 0, "partial_credit": 2, "not_scored": 0},
    }
    questions = [
        {"question_number": 1, "score": 2, "full_score": 2, "result": "correct", "lost_points": False},
        {"question_number": 2, "score": 1, "full_score": 3, "result": "partial_credit", "lost_points": True},
    ]
    return {"ok": True, "summary": summary, "data": {"students": [
        {"student_id": "SYNTHETIC_1", "questions": copy.deepcopy(questions)},
        {"student_id": "SYNTHETIC_2", "questions": copy.deepcopy(questions)},
    ]}}


class FullClassAuditTests(unittest.TestCase):
    def run_audit(self, data):
        with tempfile.TemporaryDirectory(prefix="synthetic-zhixue-audit-") as folder:
            path = Path(folder)
            (path / "student-class.json").write_text(json.dumps(data), encoding="utf-8")
            (path / "verification-full.json").write_text(json.dumps({"ok": True, "summary": data["summary"]}), encoding="utf-8")
            return audit(path, path / "synthetic-audit-output.json")

    def test_full_scores_and_labels_are_independently_recomputed(self):
        report = self.run_audit(fixture())
        self.assertEqual(report["exported_student_count"], 2)
        self.assertEqual(report["total_question_records"], 4)
        self.assertEqual(report["result_counts"]["partial_credit"], 2)
        self.assertNotIn("SYNTHETIC_1", json.dumps(report))

    def test_partial_and_mislabeled_data_never_pass(self):
        for mutation in (
            lambda data: data["data"]["students"].pop(),
            lambda data: data["data"]["students"][0]["questions"][0].update(result="incorrect"),
            lambda data: data["data"]["students"][1]["questions"][0].update(question_number=99),
            lambda data: data["summary"]["question_records"].update(failures=[{"code": "missing_sheet_data"}]),
        ):
            data = fixture()
            mutation(data)
            with self.assertRaises(ValueError):
                self.run_audit(data)

    def test_not_scanned_students_are_counted_separately(self):
        data = fixture()
        data["summary"]["roster"]["student_count"] = 3
        data["summary"]["question_records"]["not_scanned_students"] = 1
        data["data"]["unavailable_students"] = [{"student_id": "SYNTHETIC_3", "availability": "not_scanned",
                                                 "reason_source": "roster_score_column", "questions": []}]
        report = self.run_audit(data)
        self.assertEqual(report["roster_student_count"], 3)
        self.assertEqual(report["not_scanned_student_count"], 1)
        self.assertEqual(report["total_question_records"], 4)

    def test_no_original_paper_students_are_counted_separately(self):
        data = fixture()
        data["summary"]["roster"]["student_count"] = 3
        data["summary"]["question_records"]["no_original_paper_students"] = 1
        data["data"]["unavailable_students"] = [{"student_id": "SYNTHETIC_3", "availability": "no_original_paper",
                                                 "reason_source": "roster_has_origin_paper", "roster_score": 12,
                                                 "rank_code": -1, "questions": []}]
        report = self.run_audit(data)
        self.assertEqual(report["no_original_paper_student_count"], 1)
        self.assertEqual(report["not_scanned_student_count"], 0)

    def test_unscanned_records_cannot_hide_missing_or_judged_students(self):
        for mutation in (
            lambda student: student.update(reason_source="request_failed"),
            lambda student: student.update(questions=[{"question_number": 1}]),
            lambda student: student.update(student_id="SYNTHETIC_1"),
        ):
            data = fixture()
            data["summary"]["roster"]["student_count"] = 3
            data["summary"]["question_records"]["not_scanned_students"] = 1
            student = {"student_id": "SYNTHETIC_3", "availability": "not_scanned",
                       "reason_source": "roster_score_column", "questions": []}
            mutation(student)
            data["data"]["unavailable_students"] = [student]
            with self.assertRaises(ValueError):
                self.run_audit(data)

    def test_roster_gap_is_not_explained_without_unscanned_records(self):
        data = fixture()
        data["summary"]["roster"]["student_count"] = 3
        with self.assertRaisesRegex(ValueError, "student_count_mismatch"):
            self.run_audit(data)

    def test_sample_export_is_not_a_full_class_pass(self):
        data = fixture()
        data["summary"]["status"] = "passed_live_sample_export"
        with self.assertRaisesRegex(ValueError, "not_a_full_class_export"):
            self.run_audit(data)


if __name__ == "__main__":
    unittest.main()
