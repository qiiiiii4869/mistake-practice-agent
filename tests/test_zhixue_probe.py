import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
from verify_zhixue import ParseFailure, shape, summarize_paper
from zhixuewang.teacher.teacher import TeacherAccount


def fixture(keyword="var", tail="var sheetImages = [];", score=0):
    data = {"userAnswerRecordDTO": {"answerRecordDetails": [
        {"topicNumber": 3, "answer": "D", "score": score, "standardScore": 2,
         "answerType": "s01Text", "isCorrect": False, "subTopics": []},
        {"topicNumber": 21, "answer": "", "score": 4, "standardScore": 6,
         "answerType": "s02Image", "subTopics": [{"score": 2, "subTopicIndex": 1}]},
    ]}}
    return f"<script>var totalScore = 4; {keyword} sheetDatas = {json.dumps(data)}; {tail}</script>"


class ProbeTests(unittest.TestCase):
    def test_actual_fields_and_upstream_baseline(self):
        html = fixture()
        result = summarize_paper(html)
        original = TeacherAccount._parse_original_paper_html(None, html, "", "")
        self.assertEqual(result["question_count"], len(original.answer_details))
        self.assertEqual(result["lost_score_question_count"], 2)
        self.assertEqual(result["objective_answer_present_count"], 1)
        self.assertEqual(result["subquestion_score_count"], 1)
        self.assertEqual(result["question_text_and_standard_answers"], "not_verified")

    def test_changed_javascript_does_not_silently_discard_records(self):
        html = fixture("const", "var unrelated = 1; const sheetImages = [];")
        self.assertEqual(len(TeacherAccount._parse_original_paper_html(None, html, "", "").answer_details), 0)
        self.assertEqual(summarize_paper(html)["question_count"], 2)

    def test_login_page_is_failure_not_no_mistakes(self):
        with self.assertRaises(ParseFailure):
            summarize_paper("<html>Please log in</html>")

    def test_empty_and_malformed_records_do_not_pass(self):
        for html in ('var sheetDatas = {};', 'var sheetDatas = {bad};',
                     'var sheetDatas = {"userAnswerRecordDTO":{"answerRecordDetails":[]}};'):
            with self.subTest(html=html), self.assertRaises(ParseFailure):
                summarize_paper(html)

    def test_invalid_scores_do_not_pass(self):
        for score in (None, "0", -1, 99, True, float("nan"), float("inf")):
            with self.subTest(score=score), self.assertRaises(ParseFailure):
                summarize_paper(fixture(score=score))

    def test_shape_never_contains_values(self):
        result = json.dumps(shape({"name": "Private Student", "id": "secret123", "rows": [{"answer": "D"}]}))
        self.assertNotIn("Private Student", result)
        self.assertNotIn("secret123", result)
        self.assertEqual(shape([{"score": 1}])["count"], 1)
        self.assertNotIn("private-student-id", json.dumps(shape({"private-student-id": {"score": 1}})))


if __name__ == "__main__":
    unittest.main()
