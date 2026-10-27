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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    overview: Option<Overview>,
    settings: Settings,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    paper: Option<Paper>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    practice: Option<crate::practice::Batch>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Overview {
    status: String,
    class_max: Option<f64>,
    class_avg: Option<f64>,
    grade_max: Option<f64>,
    grade_avg: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    top_class_avg: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    top_class_name: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExamHistory {
    exam_id: String, exam_name: String, class_id: String, class_name: String,
    subject_name: String, finished_at: String, students: Vec<HistoryStudent>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    class_avg: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    grade_avg: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    top_class_avg: Option<f64>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HistoryStudent { id: String, name: String, score: f64, full_score: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    class_rank: Option<u32> }
impl From<&Snapshot> for ExamHistory {
    fn from(s: &Snapshot) -> Self {
        let full_score:f64 = s.students.iter().find(|s| s.availability == "scored")
            .map(|s| s.questions.iter().map(|q|q.full_score).sum()).unwrap_or(0.0);
        Self { exam_id:s.exam.id.clone(), exam_name:s.exam.name.clone(), class_id:s.exam.class_id.clone(),
            class_name:s.exam.class_name.clone(), subject_name:s.exam.subject_name.clone(), finished_at:s.source.finished_at.clone(),
            class_avg:s.overview.as_ref().and_then(|o|o.class_avg), grade_avg:s.overview.as_ref().and_then(|o|o.grade_avg),
            top_class_avg:s.overview.as_ref().and_then(|o|o.top_class_avg),
            students:s.students.iter().filter(|s| s.availability != "not_scanned" && full_score > 0.0).filter_map(|s| {
                let score = s.roster_score.filter(|score| *score >= 0.0 && *score <= full_score)
                    .or_else(|| (s.availability == "scored").then(|| s.questions.iter().map(|q|q.score).sum()))?;
                Some(HistoryStudent {id:s.id.clone(),name:s.name.clone(),score,full_score,class_rank:s.class_rank})
            }).collect() }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Paper { pages: Vec<PaperPage>, questions: Vec<PaperQuestion> }
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PaperPage { id: String, name: String, data: String }
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PaperQuestion { number: String, page_id: String, stem: String, confirmed: bool }
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    class_rank: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    grade_rank: Option<u32>,
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
        if self.overview.as_ref().is_some_and(|o| {
            !["received", "unavailable"].contains(&o.status.as_str()) ||
            o.top_class_name.as_ref().is_some_and(|name| !valid_text(name)) ||
            [o.class_max, o.class_avg, o.grade_max, o.grade_avg, o.top_class_avg].iter().flatten().any(|n| !n.is_finite() || *n < 0.0)
        }) { return Err(bad()); }
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
                || s.class_rank == Some(0) || s.grade_rank == Some(0)
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
        if let Some(paper) = &self.paper {
            let mut ids = HashSet::new();
            let mut total = 0usize;
            if paper.pages.len() > 30 { return Err(bad()); }
            for page in &paper.pages {
                if page.id.is_empty() || page.id.len() > 80 || !page.id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
                    || !ids.insert(&page.id) || page.name.trim().is_empty() || page.name.chars().count() > 300 { return Err(bad()); }
                let data = ["data:image/png;base64,", "data:image/jpeg;base64,", "data:image/webp;base64,", "data:application/pdf;base64,", "data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,"]
                    .iter().find_map(|prefix| page.data.strip_prefix(prefix)).ok_or_else(bad)?;
                let body = data.trim_end_matches('=');
                if body.is_empty() || data.len() - body.len() > 2 || !body.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'+' || c == b'/') { return Err(bad()); }
                total += page.data.len();
                if total > 8 * 1024 * 1024 { return Err(bad()); }
            }
            let mut used = HashSet::new();
            let numbers = schema.as_ref().unwrap();
            for q in &paper.questions {
                if !numbers.contains_key(q.number.as_str()) || !used.insert(&q.number) || !ids.contains(&q.page_id)
                    || q.stem.chars().count() > 20000 || (q.confirmed && q.stem.trim().is_empty()) { return Err(bad()); }
            }
        }
        if let Some(practice) = &self.practice {
            let numbers=schema.as_ref().unwrap().keys().copied().collect();
            let confirmed=self.paper.as_ref().map(|paper|paper.questions.iter().filter(|q|q.confirmed).map(|q|(q.number.as_str(),q.stem.as_str())).collect()).unwrap_or_default();
            practice.validate(&self.exam.subject_name,&self.practice_key()?,&numbers,&confirmed)?;
        }
        Ok(())
    }
    fn practice_key(&self)->Result<String,String> {
        #[derive(Serialize)]
        struct InputKey<'a> {
            exam:Vec<&'a str>, source:Vec<&'a str>, settings:Vec<serde_json::Value>,
            paper:Vec<(&'a str,&'a str,&'a str,bool)>, students:Vec<(&'a str,&'a str,Vec<&'a str>)>,
        }
        let e=&self.exam;let s=&self.settings;
        let value=InputKey {exam:vec![&e.id,&e.name,&e.subject_id,&e.subject_name,&e.class_id,&e.class_name],source:vec![&self.source.kind,&self.source.finished_at],
            settings:vec![s.variants_per_question.into(),s.max_questions_per_student.into(),s.include_partial_credit.into(),s.partial_credit_threshold.into(),s.difficulty.clone().into()],
            paper:self.paper.as_ref().map(|p|p.questions.iter().map(|q|(q.number.as_str(),q.page_id.as_str(),q.stem.as_str(),q.confirmed)).collect()).unwrap_or_default(),
            students:self.students.iter().map(|student|(student.id.as_str(),student.availability.as_str(),student.questions.iter().filter(|q|q.result=="incorrect"||(q.result=="partial_credit"&&s.include_partial_credit&&q.score/q.full_score*100.0<(s.partial_credit_threshold as f64))).map(|q|q.number.as_str()).collect())).collect(),
        };
        serde_json::to_string(&value).map_err(|_|"invalid_practice".into())
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
        CREATE TABLE IF NOT EXISTS exam_history (exam_id TEXT NOT NULL, class_id TEXT NOT NULL, subject_name TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(exam_id,class_id,subject_name));
        INSERT OR IGNORE INTO active_workspace(id, revision, payload) VALUES(1, 0, NULL);")
        .map_err(|_| "storage_failed".to_string())
}
pub(crate) fn history(conn: &Connection) -> Result<Vec<ExamHistory>, String> {
    let mut stmt = conn.prepare("SELECT payload FROM exam_history ORDER BY rowid DESC").map_err(|_| "storage_failed")?;
    let rows = stmt.query_map([], |row| row.get::<_,String>(0)).map_err(|_| "storage_failed")?;
    rows.map(|row| serde_json::from_str(&row.map_err(|_| "storage_failed")?).map_err(|_| "invalid_workspace".to_string())).collect()
}
fn save_history(tx: &rusqlite::Transaction<'_>, snapshot: &Snapshot) -> Result<(), String> {
    let record = ExamHistory::from(snapshot);
    let payload = serde_json::to_string(&record).map_err(|_| "invalid_workspace")?;
    tx.execute("INSERT INTO exam_history(exam_id,class_id,subject_name,payload) VALUES (?1,?2,?3,?4) ON CONFLICT(exam_id,class_id,subject_name) DO UPDATE SET payload=excluded.payload WHERE json_extract(excluded.payload,'$.finishedAt') >= json_extract(exam_history.payload,'$.finishedAt')",
        params![record.exam_id,record.class_id,record.subject_name,payload]).map_err(|_| "storage_failed")?;
    Ok(())
}
pub(crate) fn archive_exam(conn: &mut Connection, expected: i64, snapshot: &Snapshot) -> Result<Vec<ExamHistory>, String> {
    snapshot.validate()?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|_| "storage_failed")?;
    let (revision, raw): (i64, Option<String>) = tx.query_row("SELECT revision,payload FROM active_workspace WHERE id=1", [],
        |row| Ok((row.get(0)?,row.get(1)?))).map_err(|_| "storage_failed")?;
    if revision != expected { return Err("storage_conflict".into()); }
    if let Some(raw) = raw {
        let current: Snapshot = serde_json::from_str(&raw).map_err(|_| "invalid_workspace")?;
        current.validate()?;
        save_history(&tx, &current)?;
    }
    save_history(&tx, snapshot)?;
    tx.commit().map_err(|_| "storage_failed")?;
    history(conn)
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LegacySummary {
    revision: i64, exam_name: String, subject_name: String,
    student_count: usize, question_records: usize, paper_files: usize,
}
fn legacy_connection(path: &Path) -> Result<Connection, String> {
    Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|_| "legacy_read_failed".into())
}
pub(crate) fn legacy_summary(path: &Path) -> Result<Option<LegacySummary>, String> {
    if !path.is_file() { return Ok(None); }
    let stored = load(&legacy_connection(path)?)?;
    Ok(stored.snapshot.map(|s| LegacySummary {
        revision: stored.revision, exam_name: s.exam.name, subject_name: s.exam.subject_name,
        student_count: s.students.len(), question_records: s.students.iter().map(|s| s.questions.len()).sum(),
        paper_files: s.paper.as_ref().map_or(0, |p| p.pages.len()),
    }))
}
pub(crate) fn import_legacy(source: &Path, destination: &Path, source_revision: i64, target_revision: i64) -> Result<Stored, String> {
    let source = legacy_connection(source)?;
    let snapshot = load(&source)?;
    if snapshot.revision != source_revision { return Err("legacy_source_changed".into()); }
    let snapshot = snapshot.snapshot.ok_or("legacy_not_found")?;
    let mut target = open(destination)?;
    let current = load(&target)?;
    if current.snapshot.is_some() { return Err("legacy_target_not_empty".into()); }
    if current.revision != target_revision { return Err("storage_conflict".into()); }
    // save uses a revision-checked transaction; the source is opened read-only.
    save(&mut target, target_revision, Some(snapshot))
}
pub(crate) fn model_names(conn:&Connection)->Result<Vec<String>,String>{
    Ok(load(conn)?.snapshot.ok_or("model_no_workspace")?.students.into_iter().map(|s|s.name).collect())
}
pub(crate) fn export_snapshot(conn:&Connection,expected:i64)->Result<serde_json::Value,String>{
    let stored=load(conn)?;if stored.revision!=expected{return Err("storage_conflict".into());}
    serde_json::to_value(stored.snapshot.ok_or("pdf_no_batch")?).map_err(|_|"pdf_invalid_data".into())
}
pub(crate) fn vision_context(conn:&Connection,page_id:&str)->Result<(String,Vec<String>,Vec<String>),String>{
    let snapshot=load(conn)?.snapshot.ok_or("model_no_workspace")?;
    let image=snapshot.paper.as_ref().and_then(|p|p.pages.iter().find(|p|p.id==page_id)).ok_or("paper_page_not_saved")?.data.clone();
    let numbers=snapshot.students.iter().find(|s|s.availability=="scored").ok_or("invalid_workspace")?.questions.iter().map(|q|q.number.clone()).collect();
    Ok((image,numbers,snapshot.students.into_iter().map(|s|s.name).collect()))
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
    let previous = tx.query_row("SELECT payload FROM active_workspace WHERE id=1", [], |row| row.get::<_,Option<String>>(0))
        .map_err(|_| "storage_failed")?.map(|raw| serde_json::from_str::<Snapshot>(&raw).map_err(|_| "invalid_workspace"))
        .transpose()?;
    let changed = tx.execute("UPDATE active_workspace SET payload=?1, revision=revision+1 WHERE id=1 AND revision=?2", params![payload, expected])
        .map_err(|_| "storage_failed")?;
    if changed != 1 {
        return Err("storage_conflict".into());
    }
    if let Some(old) = &previous {
        if snapshot.is_some() { save_history(&tx, old)?; }
        else { tx.execute("DELETE FROM exam_history WHERE exam_id=?1 AND class_id=?2 AND subject_name=?3",
            params![old.exam.id,old.exam.class_id,old.exam.subject_name]).map_err(|_| "storage_failed")?; }
    }
    if let Some(current) = &snapshot { save_history(&tx, current)?; }
    tx.commit().map_err(|_| "storage_failed")?;
    load(conn)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn archive_without_replacing_keeps_all_reads_and_rolls_back_on_failure() {
        let mut conn=Connection::open_in_memory().unwrap();init(&conn).unwrap();
        let current=sample();save(&mut conn,0,Some(current)).unwrap();
        for id in ["week2","week3","week5"] {
            let mut exam=sample();exam.exam.id=id.into();exam.exam.name=id.into();
            let records=archive_exam(&mut conn,1,&exam).unwrap();
            assert!(records.iter().any(|r|r.exam_id==id));
            let active=load(&conn).unwrap();assert_eq!(active.revision,1);assert_eq!(active.snapshot.unwrap().exam.id,"e");
        }
        assert_eq!(history(&conn).unwrap().len(),4);
        let mut exam=sample();exam.exam.id="week3".into();exam.students[0].class_rank=Some(9);
        archive_exam(&mut conn,1,&exam).unwrap();
        assert_eq!(history(&conn).unwrap().len(),4);
        assert_eq!(history(&conn).unwrap().iter().find(|r|r.exam_id=="week3").unwrap().students[0].class_rank,Some(9));
        exam.exam.id="invalid".into();exam.students[0].questions[0].score=-1.0;
        assert!(archive_exam(&mut conn,1,&exam).is_err());
        exam.students[0].questions[0].score=0.0;
        assert_eq!(archive_exam(&mut conn,0,&exam).unwrap_err(),"storage_conflict");
        assert_eq!(history(&conn).unwrap().len(),4);
    }
    #[test]
    fn later_active_saves_cannot_revert_a_refreshed_history() {
        let mut conn=Connection::open_in_memory().unwrap();init(&conn).unwrap();
        let mut active=sample();active.source.finished_at="2026-10-27T10:00:00Z".into();
        save(&mut conn,0,Some(active.clone())).unwrap();
        let mut refreshed=active.clone();refreshed.source.finished_at="2026-10-27T11:00:00Z".into();refreshed.students[0].class_rank=Some(5);
        archive_exam(&mut conn,1,&refreshed).unwrap();
        let mut other=sample();other.exam.id="other".into();archive_exam(&mut conn,1,&other).unwrap();
        save(&mut conn,1,Some(active)).unwrap();
        let history=history(&conn).unwrap();let record=history.iter().find(|r|r.exam_id=="e").unwrap();
        assert_eq!(record.students[0].class_rank,Some(5));assert_eq!(record.finished_at,"2026-10-27T11:00:00Z");
    }
    #[test]
    fn history_archives_previous_exam_transactionally_and_clears_current_only() {
        let mut conn=Connection::open_in_memory().unwrap();init(&conn).unwrap();
        let mut first=sample();first.students[0].class_rank=Some(3);
        first.overview=Some(Overview {status:"received".into(),class_max:Some(2.0),class_avg:Some(1.0),
            grade_max:Some(2.0),grade_avg:Some(1.2),top_class_avg:Some(1.5),top_class_name:None});
        // Existing installations may have an active workspace before history existed.
        conn.execute("UPDATE active_workspace SET revision=1,payload=?1",params![serde_json::to_string(&first).unwrap()]).unwrap();
        let mut next=first.clone();next.exam.id="e2".into();next.exam.name="Second".into();
        assert!(save(&mut conn,0,Some(next.clone())).is_err());
        assert!(history(&conn).unwrap().is_empty());
        save(&mut conn,1,Some(next)).unwrap();
        let records=history(&conn).unwrap();assert_eq!(records.len(),2);
        let old=records.iter().find(|r|r.exam_id=="e").unwrap();
        assert_eq!(old.students[0].score,0.0);assert_eq!(old.students[0].full_score,2.0);
        assert_eq!(old.students[0].class_rank,Some(3));
        assert_eq!(old.class_avg,Some(1.0));assert_eq!(old.grade_avg,Some(1.2));assert_eq!(old.top_class_avg,Some(1.5));
        let mut old_json=serde_json::to_value(old).unwrap();old_json["students"][0].as_object_mut().unwrap().remove("classRank");
        for key in ["classAvg","gradeAvg","topClassAvg"] {old_json.as_object_mut().unwrap().remove(key);}
        assert_eq!(serde_json::from_value::<ExamHistory>(old_json).unwrap().students[0].class_rank,None);
        assert!(!serde_json::to_string(old).unwrap().contains("questions"));
        save(&mut conn,2,None).unwrap();
        assert_eq!(history(&conn).unwrap().len(),1);
        assert_eq!(history(&conn).unwrap()[0].exam_id,"e");
    }
    fn sample() -> Snapshot {
        serde_json::from_value(serde_json::json!({"schemaVersion":1,"source":{"kind":"chrome_extension","finishedAt":"SYNTHETIC"},
          "exam":{"id":"e","name":"模拟考试","classId":"c","className":"班级","subjectId":"p","subjectName":"学科"},
          "students":[{"id":"s","name":"SYNTHETIC_STUDENT","availability":"scored","reasonSource":null,"rosterScore":null,"rankCode":null,
            "questions":[{"number":"1","label":"1","score":0,"fullScore":2,"result":"incorrect"}]}],
          "settings":{"variantsPerQuestion":1,"maxQuestionsPerStudent":5,"includePartialCredit":true,"partialCreditThreshold":100,"difficulty":"same"}})).unwrap()
    }
    #[test]
    fn practice_js_fixture_roundtrip_and_stale_validation() {
        let raw=include_str!("../../../../../tests/fixtures/practice-workspace-synthetic.json");
        let snapshot:Snapshot=serde_json::from_str(raw).unwrap();
        let mut conn=Connection::open_in_memory().unwrap();init(&conn).unwrap();
        save(&mut conn,0,Some(snapshot.clone())).unwrap();
        assert!(load(&conn).unwrap().snapshot.unwrap().practice.is_some());
        let mut changed=snapshot.clone();changed.settings.variants_per_question=3;
        assert_eq!(save(&mut conn,1,Some(changed)).unwrap_err(),"invalid_practice");
        let mut changed=snapshot;changed.paper.as_mut().unwrap().questions[0].stem.push_str("条件变更");
        assert_eq!(save(&mut conn,1,Some(changed)).unwrap_err(),"invalid_practice");
        assert_eq!(load(&conn).unwrap().revision,1);
        save(&mut conn,1,None).unwrap();assert!(load(&conn).unwrap().snapshot.is_none());
    }
    #[test]
    fn persisted_practice_reopens_and_clear_removes_generated_text() {
        let snapshot:Snapshot=serde_json::from_str(include_str!("../../../../../tests/fixtures/practice-workspace-synthetic.json")).unwrap();
        let path=std::env::temp_dir().join(format!("synthetic-practice-{}-{}.sqlite",std::process::id(),std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        {let mut conn=open(&path).unwrap();save(&mut conn,0,Some(snapshot)).unwrap();}
        {let mut conn=open(&path).unwrap();assert!(load(&conn).unwrap().snapshot.unwrap().practice.is_some());save(&mut conn,1,None).unwrap();}
        let bytes=std::fs::read(&path).unwrap();
        for needle in ["演示答案","模拟学生甲","合成课本.pdf"] {assert!(!bytes.windows(needle.len()).any(|w|w==needle.as_bytes()),"{needle}");}
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn practice_rejects_forged_passes_citations_and_sources() {
        let original:serde_json::Value=serde_json::from_str(include_str!("../../../../../tests/fixtures/practice-workspace-synthetic.json")).unwrap();
        for (field,value) in [("answer",serde_json::json!("wrong answer")),("passed",serde_json::json!(false)),("sourceIndexes",serde_json::json!([99])),("sourceNumbers",serde_json::json!(["999"]))] {
            let mut raw=original.clone();raw["practice"]["variants"][0][field]=value;
            let snapshot:Snapshot=serde_json::from_value(raw).unwrap();assert!(snapshot.validate().is_err(),"{field}");
        }
    }
    #[test]
    fn uploaded_documents_roundtrip_without_recognition() {
        for mime in ["application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"] {
            let mut conn=Connection::open_in_memory().unwrap();init(&conn).unwrap();
            let mut snapshot=sample();snapshot.paper=Some(Paper{pages:vec![PaperPage{id:"file-1".into(),name:"synthetic document".into(),data:format!("data:{mime};base64,aGVsbG8=")}],questions:vec![]});
            save(&mut conn,0,Some(snapshot)).unwrap();let restored=load(&conn).unwrap().snapshot.unwrap().paper.unwrap();
            assert!(restored.pages[0].data.contains(mime));assert!(restored.questions.is_empty());
            save(&mut conn,1,None).unwrap();assert!(load(&conn).unwrap().snapshot.is_none());
        }
    }
    #[test]
    fn paper_roundtrip_validation_and_clear() {
        let mut conn = Connection::open_in_memory().unwrap();
        init(&conn).unwrap();
        let mut snapshot = sample();
        snapshot.paper = Some(Paper {
            pages: vec![PaperPage { id: "page-1".into(), name: "synthetic.png".into(), data: "data:image/png;base64,aGVsbG8=".into() }],
            questions: vec![PaperQuestion { number: "1".into(), page_id: "page-1".into(), stem: "synthetic stem".into(), confirmed: true }],
        });
        save(&mut conn, 0, Some(snapshot.clone())).unwrap();
        assert!(load(&conn).unwrap().snapshot.unwrap().paper.unwrap().questions[0].confirmed);
        snapshot.paper.as_mut().unwrap().questions[0].number = "999".into();
        assert!(save(&mut conn, 1, Some(snapshot)).is_err());
        assert_eq!(load(&conn).unwrap().revision, 1);
        save(&mut conn, 1, None).unwrap();
        assert!(load(&conn).unwrap().snapshot.is_none());
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
