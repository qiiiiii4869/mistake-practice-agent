use rusqlite::{params, Connection, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    path::Path,
};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Snapshot {
    schema_version: u32,
    source: Source,
    exam: Exam,
    students: Vec<Student>,
    settings: Settings,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Source {
    kind: String,
    finished_at: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Exam {
    id: String,
    name: String,
    subject_id: String,
    subject_name: String,
    class_id: String,
    class_name: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Student {
    id: String,
    name: String,
    availability: String,
    reason_source: Option<String>,
    roster_score: Option<f64>,
    rank_code: Option<f64>,
    questions: Vec<Question>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Question {
    number: String,
    label: String,
    score: f64,
    full_score: f64,
    result: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Settings {
    variants_per_question: u32,
    max_questions_per_student: u32,
    include_partial_credit: bool,
    partial_credit_threshold: u32,
    difficulty: String,
}
#[derive(Debug, Serialize)]
pub(crate) struct Stored {
    revision: i64,
    snapshot: Option<Snapshot>,
}

impl Snapshot {
    pub(crate) fn validate(&self) -> Result<(), String> {
        let bad = || "invalid_workspace".to_string();
        let valid_text = |s: &str| {
            s.chars().count() <= 300
                && !s.to_lowercase().contains("http://")
                && !s.to_lowercase().contains("https://")
        };
        if self.schema_version != 1
            || !["zhixue_webview", "chrome_extension"].contains(&self.source.kind.as_str())
            || self.source.finished_at.is_empty()
            || !valid_text(&self.source.finished_at)
            || [&self.exam.id, &self.exam.subject_id, &self.exam.class_id]
                .iter()
                .any(|s| s.trim().is_empty() || !valid_text(s))
            || [
                &self.exam.name,
                &self.exam.subject_name,
                &self.exam.class_name,
            ]
            .iter()
            .any(|s| !valid_text(s))
            || self.students.is_empty()
            || self.students.len() > 2000
        {
            return Err(bad());
        }
        let settings = &self.settings;
        if !(1..=10).contains(&settings.variants_per_question)
            || !(1..=100).contains(&settings.max_questions_per_student)
            || settings.partial_credit_threshold > 100
            || !["basic", "same", "advanced"].contains(&settings.difficulty.as_str())
        {
            return Err(bad());
        }
        let mut ids = HashSet::new();
        let mut schema: Option<HashMap<&str, f64>> = None;
        for s in &self.students {
            if s.id.trim().is_empty()
                || !valid_text(&s.id)
                || !valid_text(&s.name)
                || !ids.insert(&s.id)
                || s.roster_score.is_some_and(|n| !n.is_finite())
                || s.rank_code.is_some_and(|n| !n.is_finite())
            {
                return Err(bad());
            }
            if s.availability != "scored" {
                let reason = s.reason_source.as_deref().unwrap_or("");
                if !s.questions.is_empty()
                    || !match s.availability.as_str() {
                        "not_scanned" => reason == "roster_score_column",
                        "no_original_paper" => {
                            ["roster_has_origin_paper", "roster_rank_code"].contains(&reason)
                        }
                        _ => false,
                    }
                {
                    return Err(bad());
                }
                continue;
            }
            if s.reason_source.is_some() || s.questions.is_empty() || s.questions.len() > 1000 {
                return Err(bad());
            }
            let mut current = HashMap::new();
            for q in &s.questions {
                let parts = q.number.split(['.', '．']).collect::<Vec<_>>();
                if q.number.len() > 40
                    || parts
                        .iter()
                        .any(|s| s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()))
                    || !valid_text(&q.label)
                    || !q.score.is_finite()
                    || !q.full_score.is_finite()
                    || q.score < 0.0
                    || q.full_score < q.score
                    || current.insert(q.number.as_str(), q.full_score).is_some()
                {
                    return Err(bad());
                }
                let expected = if q.full_score == 0.0 {
                    "not_scored"
                } else if q.score == q.full_score {
                    "correct"
                } else if q.score == 0.0 {
                    "incorrect"
                } else {
                    "partial_credit"
                };
                if q.result != expected {
                    return Err(bad());
                }
            }
            if schema.as_ref().is_some_and(|expected| expected != &current) {
                return Err(bad());
            }
            schema = Some(current);
        }
        if schema.is_none() {
            return Err(bad());
        }
        Ok(())
    }
    pub(crate) fn anonymous_audit(&self) -> serde_json::Value {
        let mut results = HashMap::from([
            ("correct", 0),
            ("incorrect", 0),
            ("partial_credit", 0),
            ("not_scored", 0),
        ]);
        let mut record_count = 0;
        for s in &self.students {
            for q in &s.questions {
                *results.get_mut(q.result.as_str()).unwrap() += 1;
                record_count += 1;
            }
        }
        serde_json::json!({"schema_version":1, "stage":"desktop_full_class_workspace", "source":self.source.kind,
            "source_finished_at":if self.source.finished_at.chars().all(|c| c.is_ascii_digit() || "-:.TZ+".contains(c)) { &self.source.finished_at } else { "not_recorded" }, "validated_workspace":true,
            "roster_student_count":self.students.len(),
            "exported_student_count":self.students.iter().filter(|s| s.availability == "scored").count(),
            "not_scanned_student_count":self.students.iter().filter(|s| s.availability == "not_scanned").count(),
            "no_original_paper_student_count":self.students.iter().filter(|s| s.availability == "no_original_paper").count(),
            "total_question_records":record_count, "result_counts":results,
            "live_full_class_scores_verified":self.source.kind == "zhixue_webview"})
    }
}

pub(crate) fn open(path: &Path) -> Result<Connection, String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|_| "storage_failed")?;
    }
    let conn = Connection::open(path).map_err(|_| "storage_failed")?;
    init(&conn)?;
    Ok(conn)
}
fn init(conn: &Connection) -> Result<(), String> {
    conn.execute_batch("PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE; PRAGMA secure_delete=ON;
        CREATE TABLE IF NOT EXISTS active_workspace (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, payload TEXT);
        INSERT OR IGNORE INTO active_workspace(id, revision, payload) VALUES(1, 0, NULL);")
        .map_err(|_| "storage_failed".to_string())
}
pub(crate) fn load(conn: &Connection) -> Result<Stored, String> {
    let (revision, raw): (i64, Option<String>) = conn
        .query_row(
            "SELECT revision, payload FROM active_workspace WHERE id=1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|_| "storage_failed")?;
    let snapshot = raw
        .map(|raw| serde_json::from_str::<Snapshot>(&raw).map_err(|_| "invalid_workspace"))
        .transpose()?;
    if let Some(snapshot) = &snapshot {
        snapshot.validate()?;
    }
    Ok(Stored { revision, snapshot })
}
pub(crate) fn save(
    conn: &mut Connection,
    expected: i64,
    snapshot: Option<Snapshot>,
) -> Result<Stored, String> {
    if let Some(snapshot) = &snapshot {
        snapshot.validate()?;
    }
    let payload = snapshot
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(|_| "invalid_workspace")?;
    if payload.as_ref().is_some_and(|s| s.len() > 16 * 1024 * 1024) {
        return Err("file_too_large".into());
    }
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| "storage_failed")?;
    let changed = tx.execute("UPDATE active_workspace SET payload=?1, revision=revision+1 WHERE id=1 AND revision=?2", params![payload, expected])
        .map_err(|_| "storage_failed")?;
    if changed != 1 {
        return Err("storage_conflict".into());
    }
    tx.commit().map_err(|_| "storage_failed")?;
    load(conn)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn sample() -> Snapshot {
        serde_json::from_value(serde_json::json!({"schemaVersion":1,"source":{"kind":"chrome_extension","finishedAt":"SYNTHETIC"},
          "exam":{"id":"e","name":"模拟考试","classId":"c","className":"班级","subjectId":"p","subjectName":"学科"},
          "students":[{"id":"s","name":"SYNTHETIC_STUDENT","availability":"scored","reasonSource":null,"rosterScore":null,"rankCode":null,
            "questions":[{"number":"1","label":"1","score":0,"fullScore":2,"result":"incorrect"}]}],
          "settings":{"variantsPerQuestion":1,"maxQuestionsPerStudent":5,"includePartialCredit":true,"partialCreditThreshold":100,"difficulty":"same"}})).unwrap()
    }
    #[test]
    fn single_exam_roundtrip_replace_clear_and_conflict() {
        let mut conn = Connection::open_in_memory().unwrap();
        init(&conn).unwrap();
        assert!(load(&conn).unwrap().snapshot.is_none());
        let first = save(&mut conn, 0, Some(sample())).unwrap();
        assert_eq!(first.revision, 1);
        assert_eq!(
            first.snapshot.unwrap().students[0].name,
            "SYNTHETIC_STUDENT"
        );
        assert_eq!(
            save(&mut conn, 0, Some(sample())).unwrap_err(),
            "storage_conflict"
        );
        let mut replacement = sample();
        replacement.exam.id = "next".into();
        save(&mut conn, 1, Some(replacement)).unwrap();
        assert_eq!(
            conn.query_row::<i64, _, _>("SELECT count(*) FROM active_workspace", [], |r| r.get(0))
                .unwrap(),
            1
        );
        assert!(save(&mut conn, 2, None).unwrap().snapshot.is_none());
        assert_eq!(load(&conn).unwrap().revision, 3);
    }
    #[test]
    fn invalid_replacement_preserves_original_and_audit_is_anonymous() {
        let mut conn = Connection::open_in_memory().unwrap();
        init(&conn).unwrap();
        save(&mut conn, 0, Some(sample())).unwrap();
        let mut invalid = sample();
        invalid.students[0].questions[0].score = 3.0;
        assert!(save(&mut conn, 1, Some(invalid)).is_err());
        assert_eq!(load(&conn).unwrap().revision, 1);
        assert!(!sample()
            .anonymous_audit()
            .to_string()
            .contains("SYNTHETIC_STUDENT"));
    }
    #[test]
    fn persisted_file_reopens_and_clear_removes_student_text() {
        let path = std::env::temp_dir().join(format!(
            "synthetic-agent-storage-{}-{}.sqlite",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        {
            let mut conn = open(&path).unwrap();
            save(&mut conn, 0, Some(sample())).unwrap();
        }
        {
            let mut conn = open(&path).unwrap();
            assert!(load(&conn).unwrap().snapshot.is_some());
            save(&mut conn, 1, None).unwrap();
        }
        let raw = std::fs::read(&path).unwrap();
        assert!(!raw
            .windows(b"SYNTHETIC_STUDENT".len())
            .any(|s| s == b"SYNTHETIC_STUDENT"));
        std::fs::remove_file(path).unwrap();
    }
}
