use rusqlite::{params, Connection, TransactionBehavior};
use serde::{Deserialize, Serialize};
use sha2::{Digest,Sha256};

#[derive(Debug, Deserialize,Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Document { id: String, name: String, pages: Vec<Page>,#[serde(default,skip_serializing_if="Option::is_none")] processed:Option<Processed> }
#[derive(Debug, Deserialize,Serialize)]
#[serde(deny_unknown_fields)]
struct Page { number: u32, text: String }
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Summary { id: String, name: String, page_count: u32, chunk_count: u32, empty_pages: Vec<u32>,processing:Option<ProcessingSummary> }
#[derive(Debug, Serialize)]
pub(crate) struct Library { revision: i64, documents: Vec<Summary> }
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Hit { document_id: String, name: String, page: u32, ordinal: u32, text: String,kind:String,question_id:Option<String>,question_number:Option<String> }

#[derive(Debug,Deserialize,Serialize,Clone)]#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct Processed {version:String,kind:String,questions:Vec<BankQuestion>,warnings:Vec<String>}
#[derive(Debug,Deserialize,Serialize,Clone)]#[serde(rename_all="camelCase",deny_unknown_fields)]
struct BankQuestion {id:String,number:String,page_start:u32,page_end:u32,stem:String,options:Vec<Choice>,answer:String,explanation:String,#[serde(default)]answer_pages:Vec<u32>,knowledge_points:Vec<String>,#[serde(default)]knowledge_notes:Vec<String>,#[serde(default)]task_patterns:Vec<String>,#[serde(rename="type")]question_type:String,difficulty:String,warnings:Vec<String>}
#[derive(Debug,Deserialize,Serialize,Clone)]#[serde(deny_unknown_fields)]struct Choice{label:String,text:String}
#[derive(Debug,Serialize)]#[serde(rename_all="camelCase")]
struct ProcessingSummary{version:String,kind:String,question_count:u32,answer_count:u32,explanation_count:u32,warnings:Vec<String>}
const PROCESSOR:&str="knowledge-processor-v1";
fn checksum(text:&str)->String{format!("{:x}",Sha256::digest(text.as_bytes()))}

pub(crate) fn init(conn: &Connection) -> Result<(), String> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS knowledge_state(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL);
        INSERT OR IGNORE INTO knowledge_state VALUES(1,0);
        CREATE TABLE IF NOT EXISTS knowledge_documents(id TEXT PRIMARY KEY, name TEXT NOT NULL, page_count INTEGER NOT NULL, empty_pages TEXT NOT NULL);
        CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_chunks USING fts5(document_id UNINDEXED, page UNINDEXED, ordinal UNINDEXED, text, tokenize='trigram');
        INSERT INTO knowledge_chunks(knowledge_chunks, rank) VALUES('secure-delete', 1);
        CREATE TABLE IF NOT EXISTS knowledge_pages(document_id TEXT NOT NULL,page INTEGER NOT NULL,text TEXT NOT NULL,PRIMARY KEY(document_id,page));
        CREATE TABLE IF NOT EXISTS knowledge_processing(document_id TEXT PRIMARY KEY,version TEXT NOT NULL,kind TEXT NOT NULL,warnings_json TEXT NOT NULL,question_count INTEGER NOT NULL,answer_count INTEGER NOT NULL,explanation_count INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS knowledge_questions(document_id TEXT NOT NULL,qid TEXT NOT NULL,number TEXT NOT NULL,page_start INTEGER NOT NULL,ordinal INTEGER NOT NULL,record_json TEXT NOT NULL,checksum TEXT NOT NULL,PRIMARY KEY(document_id,qid));
        CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_question_index USING fts5(document_id UNINDEXED,question_id UNINDEXED,text,tokenize='trigram');
        INSERT INTO knowledge_question_index(knowledge_question_index, rank) VALUES('secure-delete', 1);")
        .map_err(|_| "storage_failed".to_string())
}

pub(crate) fn list(conn: &Connection) -> Result<Library, String> {
    // One read transaction prevents a concurrent import from mixing revisions and metadata.
    let tx = conn.unchecked_transaction().map_err(|_| "storage_failed")?;
    let revision = tx.query_row("SELECT revision FROM knowledge_state WHERE id=1", [], |r| r.get(0)).map_err(|_| "storage_failed")?;
    let documents = {
        let mut stmt = tx.prepare("SELECT d.id,d.name,d.page_count,d.empty_pages,(SELECT count(*) FROM knowledge_chunks WHERE document_id=d.id) FROM knowledge_documents d ORDER BY d.rowid")
            .map_err(|_| "storage_failed")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, u32>(2)?, r.get::<_, String>(3)?, r.get::<_, u32>(4)?)))
            .map_err(|_| "storage_failed")?;
        let mut documents = Vec::new();
        for row in rows {
            let (id,name,page_count,empty,chunk_count) = row.map_err(|_| "storage_failed")?;
            use rusqlite::OptionalExtension;
            let processing=tx.query_row("SELECT version,kind,warnings_json,question_count,answer_count,explanation_count FROM knowledge_processing WHERE document_id=?1",[&id],|r|Ok((r.get(0)?,r.get(1)?,r.get::<_,String>(2)?,r.get(3)?,r.get(4)?,r.get(5)?))).optional().map_err(|_|"storage_failed")?
              .map(|(version,kind,warnings,question_count,answer_count,explanation_count)|Ok::<_,String>(ProcessingSummary{version,kind,warnings:serde_json::from_str(&warnings).map_err(|_|"knowledge_cache_corrupt")?,question_count,answer_count,explanation_count})).transpose()?;
            documents.push(Summary { id,name,page_count,chunk_count,empty_pages: serde_json::from_str(&empty).map_err(|_| "storage_failed")?,processing });
        }
        documents
    };
    tx.commit().map_err(|_| "storage_failed")?;
    Ok(Library { revision, documents })
}

// Check actual indexed text, rather than only whether a PDF has been imported.
// No source text, filenames or student information leaves this local check.
pub(crate) fn require_searchable(conn: &Connection) -> Result<(), String> {
    let ready: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM knowledge_documents d JOIN knowledge_chunks c ON c.document_id=d.id WHERE length(trim(c.text))>0 LIMIT 1)",
        [], |row| row.get(0),
    ).map_err(|_| "storage_failed")?;
    if ready { Ok(()) } else { Err("knowledge_required".into()) }
}

// Character boundaries preserve UTF-8. Overlap retains context; chunks never cross pages.
fn chunks(text: &str) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    let mut out = Vec::new();
    let mut start = 0;
    while start < chars.len() {
        let end = (start + 800).min(chars.len());
        let chunk: String = chars[start..end].iter().collect();
        if !chunk.trim().is_empty() { out.push(chunk); }
        if end == chars.len() { break; }
        start = end - 80;
    }
    out
}

fn advance(conn: &Connection, expected: i64) -> Result<(), String> {
    let changed = conn.execute("UPDATE knowledge_state SET revision=revision+1 WHERE id=1 AND revision=?1", [expected]).map_err(|_| "storage_failed")?;
    if changed != 1 { return Err("knowledge_conflict".into()); }
    Ok(())
}

pub(crate) fn import(conn: &mut Connection, expected: i64, doc: Document) -> Result<Library, String> {
    let bad = || "invalid_knowledge_document".to_string();
    if doc.id.len() != 64 || !doc.id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        || doc.name.trim().is_empty() || doc.name.chars().count() > 300 || doc.pages.is_empty() || doc.pages.len() > 1000 { return Err(bad()); }
    let mut total = 0;
    let mut empty = Vec::new();
    let mut prepared = Vec::new();
    for (i, page) in doc.pages.iter().enumerate() {
        total += page.text.len();
        if page.number as usize != i+1 || page.text.chars().count() > 100000 || page.text.contains('\0') || total > 20*1024*1024 { return Err(bad()); }
        if page.text.trim().is_empty() { empty.push(page.number); }
        else { for (j,text) in chunks(page.text.trim()).into_iter().enumerate() { prepared.push((page.number, j as u32 + 1, text)); } }
    }
    if prepared.is_empty() { return Err("knowledge_no_text".into()); }
    if let Some(p)=&doc.processed{validate_processed(p,doc.pages.len()as u32)?;}
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|_| "storage_failed")?;
    advance(&tx, expected)?;
    let exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM knowledge_documents WHERE id=?1)", [&doc.id], |r| r.get(0)).map_err(|_| "storage_failed")?;
    if exists { return Err("knowledge_duplicate".into()); }
    let (documents, bytes): (i64,i64) = tx.query_row("SELECT (SELECT count(*) FROM knowledge_documents), coalesce(sum(length(cast(text AS blob))),0) FROM knowledge_chunks", [], |r| Ok((r.get(0)?,r.get(1)?))).map_err(|_| "storage_failed")?;
    let added: usize = prepared.iter().map(|(_,_,t)| t.len()).sum();
    if documents >= 100 || bytes + added as i64 > 100*1024*1024||total_bytes(&tx)?+added as i64+total as i64>100*1024*1024 { return Err("knowledge_limit".into()); }
    tx.execute("INSERT INTO knowledge_documents VALUES(?1,?2,?3,?4)", params![doc.id, doc.name.trim(), doc.pages.len() as u32, serde_json::to_string(&empty).map_err(|_| bad())?]).map_err(|_| "storage_failed")?;
    for page in &doc.pages{tx.execute("INSERT INTO knowledge_pages VALUES(?1,?2,?3)",params![doc.id,page.number,page.text]).map_err(|_|"storage_failed")?;}
    {
        let mut stmt = tx.prepare("INSERT INTO knowledge_chunks(document_id,page,ordinal,text) VALUES(?1,?2,?3,?4)").map_err(|_| "storage_failed")?;
        for (page,ordinal,text) in prepared { stmt.execute(params![doc.id,page,ordinal,text]).map_err(|_| "storage_failed")?; }
    }
    if let Some(p)=&doc.processed{save_processed(&tx,&doc.id,p)?;}
    tx.commit().map_err(|_| "storage_failed")?;
    list(conn)
}

pub(crate) fn remove(conn: &mut Connection, expected: i64, id: &str) -> Result<Library, String> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|_| "storage_failed")?;
    advance(&tx, expected)?;
    let changed = tx.execute("DELETE FROM knowledge_documents WHERE id=?1", [id]).map_err(|_| "storage_failed")?;
    if changed != 1 { return Err("knowledge_conflict".into()); }
    tx.execute("DELETE FROM knowledge_chunks WHERE document_id=?1", [id]).map_err(|_| "storage_failed")?;
    for table in ["knowledge_pages","knowledge_processing","knowledge_questions","knowledge_question_index"]{tx.execute(&format!("DELETE FROM {table} WHERE document_id=?1"),[id]).map_err(|_|"storage_failed")?;}
    tx.commit().map_err(|_| "storage_failed")?;
    list(conn)
}

fn search_raw(conn: &Connection, query: &str) -> Result<Vec<Hit>, String> {
    let query = query.trim();
    let len = query.chars().count();
    if len == 0 || len > 100 || query.contains('\0') { return Err("knowledge_invalid_query".into()); }
    // Short Chinese keywords are common. Trigram MATCH requires 3 characters;
    // use escaped LIKE for 1-2 characters. All queries are literal, never FTS syntax.
    let (sql, value) = if len < 3 {
        ("SELECT c.document_id,d.name,c.page,c.ordinal,c.text FROM knowledge_chunks c JOIN knowledge_documents d ON d.id=c.document_id WHERE c.text LIKE ?1 ESCAPE '\\' ORDER BY d.rowid,c.page,c.ordinal LIMIT 20",
         format!("%{}%", query.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")))
    } else {
        ("SELECT c.document_id,d.name,c.page,c.ordinal,c.text FROM knowledge_chunks c JOIN knowledge_documents d ON d.id=c.document_id WHERE knowledge_chunks MATCH ?1 ORDER BY bm25(knowledge_chunks),d.rowid,c.page,c.ordinal LIMIT 20",
         format!("\"{}\"", query.replace('"', "\"\"")))
    };
    let mut stmt = conn.prepare(sql).map_err(|_| "storage_failed")?;
    let rows = stmt.query_map([value], |r| Ok(Hit { document_id:r.get(0)?, name:r.get(1)?, page:r.get(2)?, ordinal:r.get(3)?, text:r.get(4)?,kind:"passage".into(),question_id:None,question_number:None })).map_err(|_| "storage_failed")?;
    rows.collect::<Result<Vec<_>,_>>().map_err(|_| "storage_failed".into())
}

fn validate_processed(p:&Processed,pages:u32)->Result<(),String>{
    let bad=||"knowledge_processing_invalid".to_string();
    let text=|s:&str,n:usize|s.chars().count()<=n&&!s.contains('\0');
    if p.version!=PROCESSOR||!["question_bank","reference"].contains(&p.kind.as_str())||p.questions.len()>10000||p.warnings.len()>100
      ||p.warnings.iter().any(|s|!text(s,1000))||p.kind=="reference"&&!p.questions.is_empty(){return Err(bad());}
    let mut ids=std::collections::HashSet::new();
    for q in &p.questions{
      if q.id.is_empty()||q.id.len()>100||!q.id.bytes().all(|c|c.is_ascii_alphanumeric()||c==b'-')||!ids.insert(&q.id)
        ||q.number.trim().is_empty()||!text(&q.number,80)||q.page_start<1||q.page_end<q.page_start||q.page_end>pages||q.stem.trim().is_empty()||!text(&q.stem,20000)
        ||!text(&q.answer,10000)||!text(&q.explanation,30000)||q.options.len()>10||q.options.iter().any(|o|!text(&o.label,4)||!text(&o.text,10000))
        ||q.answer_pages.len()>1000||q.answer_pages.iter().any(|p|*p<1||*p>pages)
        ||q.knowledge_notes.len()>12||q.knowledge_notes.iter().any(|s|!text(s,1000))||q.task_patterns.len()>8||q.task_patterns.iter().any(|s|!text(s,100))
        ||q.knowledge_points.len()>12||q.knowledge_points.iter().any(|s|!text(s,300))||q.warnings.len()>20||q.warnings.iter().any(|s|!text(s,1000))
        ||!["choice","non_choice","unknown"].contains(&q.question_type.as_str())||q.difficulty!="unrated"{return Err(bad());}
    }
    if serde_json::to_vec(p).map_err(|_|bad())?.len()>30*1024*1024{return Err("knowledge_limit".into());}Ok(())
}
fn snippet(text:&str,limit:usize)->String{let mut value:String=text.chars().take(limit).collect();if text.chars().count()>limit{value.push_str("［后文略，检索摘录］");}value}
fn question_text(q:&BankQuestion)->String{
    let value=format!("【题库结构记录｜未核验｜原题{}｜来源第{}至{}页｜答案解析页{}】\n考点标签（自动匹配待核对）：{}\n题干：{}\n选项（可能含错误陈述）：{}\n参考答案（来源资料，未经科学核验）：{}\n解析（来源资料）：{}\n解析知识候选（未核验）：{}\n设问任务标签：{}\n这些是可追溯的题库记录，不是已核验教材知识；不得把干扰项直接当事实。",
      q.number,q.page_start,q.page_end,q.answer_pages.iter().take(15).map(u32::to_string).collect::<Vec<_>>().join("、"),snippet(&q.knowledge_points.join("、"),100),snippet(&q.stem,350),snippet(&q.options.iter().map(|o|format!("{}. {}",o.label,o.text)).collect::<Vec<_>>().join("\n"),200),snippet(&q.answer,150),snippet(&q.explanation,700),snippet(&q.knowledge_notes.join("\n"),150),q.task_patterns.join("、"));
    let mut out=String::new();let mut size=0;for c in value.chars(){size+=c.len_utf8();if size>6000{out.push_str("［检索摘录］");break;}out.push(c);}out
}
fn question_index_text(q:&BankQuestion)->String{format!("{}\n{}\n{}\n{}\n{}\n{}",q.knowledge_points.join(" "),q.stem,q.options.iter().map(|o|format!("{}. {}",o.label,o.text)).collect::<Vec<_>>().join("\n"),q.answer,q.explanation,q.task_patterns.join(" "))}
fn save_processed(conn:&Connection,id:&str,p:&Processed)->Result<(),String>{
    let old:i64=conn.query_row("SELECT coalesce((SELECT sum(length(cast(record_json AS BLOB))) FROM knowledge_questions WHERE document_id=?1),0)+coalesce((SELECT sum(length(cast(text AS BLOB))) FROM knowledge_question_index WHERE document_id=?1),0)",[id],|r|r.get(0)).map_err(|_|"storage_failed")?;
    let added=p.questions.iter().map(|q|serde_json::to_vec(q).map(|j|j.len()+question_index_text(q).len()).map_err(|_|"storage_failed")).collect::<Result<Vec<_>,_>>()?.iter().sum::<usize>();
    if total_bytes(conn)?-old+added as i64>100*1024*1024{return Err("knowledge_limit".into());}
    for table in ["knowledge_questions","knowledge_question_index","knowledge_processing"]{conn.execute(&format!("DELETE FROM {table} WHERE document_id=?1"),[id]).map_err(|_|"storage_failed")?;}
    conn.execute("INSERT INTO knowledge_processing VALUES(?1,?2,?3,?4,?5,?6,?7)",params![id,p.version,p.kind,serde_json::to_string(&p.warnings).map_err(|_|"storage_failed")?,p.questions.len()as u32,p.questions.iter().filter(|q|!q.answer.is_empty()).count()as u32,p.questions.iter().filter(|q|!q.explanation.is_empty()).count()as u32]).map_err(|_|"storage_failed")?;
    let mut records=conn.prepare("INSERT INTO knowledge_questions VALUES(?1,?2,?3,?4,?5,?6,?7)").map_err(|_|"storage_failed")?;
    let mut index=conn.prepare("INSERT INTO knowledge_question_index(document_id,question_id,text) VALUES(?1,?2,?3)").map_err(|_|"storage_failed")?;
    for(i,q)in p.questions.iter().enumerate(){let json=serde_json::to_string(q).map_err(|_|"storage_failed")?;
      records.execute(params![id,q.id,q.number,q.page_start,(i+1)as u32,json,checksum(&json)]).map_err(|_|"storage_failed")?;
      index.execute(params![id,q.id,question_index_text(q)]).map_err(|_|"storage_failed")?;
    }Ok(())
}
fn total_bytes(conn:&Connection)->Result<i64,String>{
    conn.query_row("SELECT coalesce((SELECT sum(length(cast(text AS BLOB))) FROM knowledge_chunks),0)+coalesce((SELECT sum(length(cast(text AS BLOB))) FROM knowledge_pages),0)+coalesce((SELECT sum(length(cast(record_json AS BLOB))) FROM knowledge_questions),0)+coalesce((SELECT sum(length(cast(text AS BLOB))) FROM knowledge_question_index),0)",[],|r|r.get(0)).map_err(|_|"storage_failed".into())
}
pub(crate) fn load_processed(conn:&Connection,id:&str)->Result<Option<Processed>,String>{
    use rusqlite::OptionalExtension;
    let meta:Option<(String,String,String)>=conn.query_row("SELECT version,kind,warnings_json FROM knowledge_processing WHERE document_id=?1",[id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(|_|"storage_failed")?;
    let Some((version,kind,warnings))=meta else{return Ok(None)};
    let mut stmt=conn.prepare("SELECT record_json,checksum FROM knowledge_questions WHERE document_id=?1 ORDER BY ordinal").map_err(|_|"storage_failed")?;
    let rows=stmt.query_map([id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).map_err(|_|"storage_failed")?;
    let mut questions=Vec::new();for row in rows{let(json,hash)=row.map_err(|_|"storage_failed")?;if checksum(&json)!=hash{return Err("knowledge_cache_corrupt".into());}questions.push(serde_json::from_str(&json).map_err(|_|"knowledge_cache_corrupt")?);}
    Ok(Some(Processed{version,kind,questions,warnings:serde_json::from_str(&warnings).map_err(|_|"knowledge_cache_corrupt")?}))
}
// Return cached source text for explicit processing of legacy imports. This
// function has no filesystem path argument and never opens an original PDF.
pub(crate) fn read_document(conn:&Connection,id:&str)->Result<Document,String>{
    let(name,count):(String,u32)=conn.query_row("SELECT name,page_count FROM knowledge_documents WHERE id=?1",[id],|r|Ok((r.get(0)?,r.get(1)?))).map_err(|_|"knowledge_conflict")?;
    let mut pages=Vec::new();
    for number in 1..=count{
      use rusqlite::OptionalExtension;
      let cached:Option<String>=conn.query_row("SELECT text FROM knowledge_pages WHERE document_id=?1 AND page=?2",params![id,number],|r|r.get(0)).optional().map_err(|_|"storage_failed")?;
      let text=if let Some(text)=cached{text}else{
        // Old imports saved overlapping chunks; reconstruct them once in memory.
        let mut stmt=conn.prepare("SELECT text FROM knowledge_chunks WHERE document_id=?1 AND page=?2 ORDER BY ordinal").map_err(|_|"storage_failed")?;
        let rows=stmt.query_map(params![id,number],|r|r.get::<_,String>(0)).map_err(|_|"storage_failed")?;
        let mut text=String::new();for(i,row)in rows.enumerate(){let chunk=row.map_err(|_|"storage_failed")?;text.push_str(&if i==0{chunk}else{chunk.chars().skip(80).collect()});}text
      };pages.push(Page{number,text});
    }Ok(Document{id:id.to_owned(),name,pages,processed:None})
}
pub(crate) fn process_existing(conn:&mut Connection,expected:i64,id:&str,p:Processed)->Result<Library,String>{
    let tx=conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|_|"storage_failed")?;
    advance(&tx,expected)?;
    let pages:u32=tx.query_row("SELECT page_count FROM knowledge_documents WHERE id=?1",[id],|r|r.get(0)).map_err(|_|"knowledge_conflict")?;
    validate_processed(&p,pages)?;save_processed(&tx,id,&p)?;tx.commit().map_err(|_|"storage_failed")?;list(conn)
}
fn question_hits(conn:&Connection,expression:&str,short:bool)->Result<Vec<Hit>,String>{
    let condition=if short{"i.text LIKE ?1 ESCAPE '\\'"}else{"knowledge_question_index MATCH ?1"};
    let order=if short{"d.rowid,q.ordinal"}else{"bm25(knowledge_question_index),d.rowid,q.ordinal"};
    let mut stmt=conn.prepare(&format!("SELECT i.document_id,d.name,q.page_start,q.ordinal,i.text,q.qid,q.number,q.record_json,q.checksum FROM knowledge_question_index i JOIN knowledge_questions q ON q.document_id=i.document_id AND q.qid=i.question_id JOIN knowledge_documents d ON d.id=i.document_id WHERE {condition} ORDER BY {order} LIMIT 20")).map_err(|_|"storage_failed")?;
    let rows=stmt.query_map([expression],|r|Ok((Hit{document_id:r.get(0)?,name:r.get(1)?,page:r.get(2)?,ordinal:r.get(3)?,text:r.get(4)?,kind:"question".into(),question_id:Some(r.get(5)?),question_number:Some(r.get(6)?)},r.get::<_,String>(7)?,r.get::<_,String>(8)?))).map_err(|_|"storage_failed")?;
    let mut hits=Vec::new();for row in rows{let(mut hit,json,hash)=row.map_err(|_|"storage_failed")?;if checksum(&json)!=hash{return Err("knowledge_cache_corrupt".into());}
      // Reconstruct excerpts from the checked structured record, not an altered
      // or stale FTS display value. The source PDF is never consulted.
      let q:BankQuestion=serde_json::from_str(&json).map_err(|_|"knowledge_cache_corrupt")?;hit.text=question_text(&q);hits.push(hit);
    }Ok(hits)
}
pub(crate) fn search(conn:&Connection,query:&str)->Result<Vec<Hit>,String>{
    let raw=search_raw(conn,query)?;let query=query.trim();
    let mut hits=if query.chars().count()>=3{question_hits(conn,&format!("\"{}\"",query.replace('"',"\"\"")),false)?}else{question_hits(conn,&format!("%{}%",query.replace('\\',"\\\\").replace('%',"\\%").replace('_',"\\_")),true)?};
    let docs:std::collections::HashSet<String>=hits.iter().map(|h|h.document_id.clone()).collect();
    hits.extend(raw.into_iter().filter(|h|!docs.contains(&h.document_id)));hits.truncate(20);Ok(hits)
}
pub(crate) fn search_related(conn:&Connection,text:&str)->Result<Vec<Hit>,String>{
    if text.trim().is_empty()||text.chars().count()>20000||text.contains('\0'){return Err("knowledge_invalid_query".into());}
    let mut topic=text.to_owned();for boilerplate in ["下列叙述","下列说法","相关叙述","相关说法","正确的是","错误的是","请回答","据图回答","下列问题","回答问题"]{topic=topic.replace(boilerplate," ");}
    let re=regex::Regex::new(r"[A-Za-z][A-Za-z0-9_-]{2,30}|[\p{Han}]{3,}").map_err(|_|"storage_failed")?;
    let mut terms=Vec::new();for m in re.find_iter(&topic){let s=m.as_str();if s.is_ascii(){terms.push(s.to_owned());}else{
      let chars:Vec<_>=s.chars().collect();for c in chars.windows(3).step_by(2){terms.push(c.iter().collect());if terms.len()>=64{break;}}
    }if terms.len()>=64{break;}}
    let mut seen=std::collections::HashSet::new();terms.retain(|t|seen.insert(t.clone()));if terms.is_empty(){return Ok(Vec::new());}
    let expression=terms.iter().map(|t|format!("\"{}\"",t.replace('"',"\"\""))).collect::<Vec<_>>().join(" OR ");
    let mut hits=question_hits(conn,&expression,false)?;
    let docs:std::collections::HashSet<String>=hits.iter().map(|h|h.document_id.clone()).collect();
    let mut stmt=conn.prepare("SELECT c.document_id,d.name,c.page,c.ordinal,c.text FROM knowledge_chunks c JOIN knowledge_documents d ON d.id=c.document_id WHERE knowledge_chunks MATCH ?1 ORDER BY bm25(knowledge_chunks),d.rowid,c.page,c.ordinal LIMIT 20").map_err(|_|"storage_failed")?;
    let raw=stmt.query_map([expression],|r|Ok(Hit{document_id:r.get(0)?,name:r.get(1)?,page:r.get(2)?,ordinal:r.get(3)?,text:r.get(4)?,kind:"passage".into(),question_id:None,question_number:None})).map_err(|_|"storage_failed")?;
    for row in raw{let h=row.map_err(|_|"storage_failed")?;if !docs.contains(&h.document_id){hits.push(h);}}hits.truncate(6);Ok(hits)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn db() -> Connection { let c = Connection::open_in_memory().unwrap(); init(&c).unwrap(); c }
    fn sample() -> Document { Document {id: "a".repeat(64),name:"模拟课本.pdf".into(),pages:vec![Page{number:1,text:"光合作用与细胞呼吸的关系。DNA replication.".into()},Page{number:2,text:"".into()}],processed:None} }
    fn processed()->Processed{serde_json::from_value(serde_json::json!({"version":PROCESSOR,"kind":"question_bank","warnings":[],"questions":[{"id":"q-1","number":"14","pageStart":1,"pageEnd":2,"stem":"光合作用中光反应产生什么物质？","options":[{"label":"A","text":"ATP"},{"label":"B","text":"其他"}],"answer":"A","explanation":"光反应合成ATP并产生NADPH。","knowledgePoints":["光反应"],"type":"choice","difficulty":"unrated","warnings":[]}]})).unwrap()}
    #[test]fn processed_import_is_atomic_persisted_and_returns_complete_question_sources(){
      let mut conn=db();let mut doc=sample();doc.processed=Some(processed());let lib=import(&mut conn,0,doc).unwrap();
      let meta=lib.documents[0].processing.as_ref().unwrap();assert_eq!(meta.question_count,1);assert_eq!(meta.answer_count,1);
      for query in ["光反应","ATP"]{let hits=search(&conn,query).unwrap();assert_eq!(hits[0].kind,"question");assert!(hits[0].text.contains("参考答案"));assert_eq!(hits[0].question_number.as_deref(),Some("14"));}
      assert_eq!(load_processed(&conn,&"a".repeat(64)).unwrap().unwrap().questions[0].answer,"A");
      assert!(!search_related(&conn,"请说明绿色植物光反应的ATP来源。").unwrap().is_empty());
      let mut invalid=processed();invalid.questions[0].page_end=3;
      assert_eq!(process_existing(&mut conn,1,&"a".repeat(64),invalid).unwrap_err(),"knowledge_processing_invalid");assert_eq!(list(&conn).unwrap().revision,1);
      remove(&mut conn,1,&"a".repeat(64)).unwrap();assert!(search(&conn,"ATP").unwrap().is_empty());
      assert_eq!(conn.query_row::<i64,_,_>("SELECT count(*) FROM knowledge_pages",[],|r|r.get(0)).unwrap(),0);
    }
    #[test]fn legacy_chunk_import_can_be_processed_without_a_source_path_or_pdf(){
      let mut conn=db();let mut doc=sample();doc.pages[0].text="光".repeat(1701);let original=doc.pages[0].text.clone();import(&mut conn,0,doc).unwrap();
      conn.execute("DELETE FROM knowledge_pages",[]).unwrap();
      let restored=read_document(&conn,&"a".repeat(64)).unwrap();assert_eq!(restored.pages[0].text,original);assert_eq!(restored.pages.len(),2);
      process_existing(&mut conn,1,&"a".repeat(64),processed()).unwrap();assert_eq!(list(&conn).unwrap().revision,2);assert_eq!(load_processed(&conn,&"a".repeat(64)).unwrap().unwrap().questions.len(),1);
    }
    #[test]fn corrupt_question_cache_is_rejected_and_saved_source_can_repair_it(){
      let mut conn=db();let mut doc=sample();doc.processed=Some(processed());import(&mut conn,0,doc).unwrap();
      conn.execute("UPDATE knowledge_questions SET record_json='{}'",[]).unwrap();
      assert_eq!(load_processed(&conn,&"a".repeat(64)).unwrap_err(),"knowledge_cache_corrupt");assert_eq!(search(&conn,"ATP").unwrap_err(),"knowledge_cache_corrupt");
      assert!(read_document(&conn,&"a".repeat(64)).unwrap().pages[0].text.contains("光合作用"));
      process_existing(&mut conn,1,&"a".repeat(64),processed()).unwrap();assert_eq!(load_processed(&conn,&"a".repeat(64)).unwrap().unwrap().questions.len(),1);
    }
    #[test]
    fn import_search_sources_duplicate_conflict_remove() {
        let mut conn = db();
        let library = import(&mut conn,0,sample()).unwrap();
        assert_eq!(library.documents[0].empty_pages,vec![2]);
        assert_eq!(library.documents[0].chunk_count,1);
        for query in ["光合作用","呼吸","DNA", "replication"] {
            let hit = search(&conn,query).unwrap(); assert_eq!(hit.len(),1); assert_eq!(hit[0].page,1); assert_eq!(hit[0].name,"模拟课本.pdf");
        }
        assert_eq!(import(&mut conn,1,sample()).unwrap_err(),"knowledge_duplicate");
        assert_eq!(remove(&mut conn,0,&"a".repeat(64)).unwrap_err(),"knowledge_conflict");
        assert_eq!(list(&conn).unwrap().revision,1);
        remove(&mut conn,1,&"a".repeat(64)).unwrap();
        assert!(search(&conn,"光合作用").unwrap().is_empty());
    }
    #[test]
    fn rejects_missing_pages_empty_and_query_operators_are_literal() {
        let mut conn = db();
        let mut invalid = sample(); invalid.pages[0].number=3;
        assert!(import(&mut conn,0,invalid).is_err());
        let mut empty = sample(); empty.pages[0].text.clear();
        assert_eq!(import(&mut conn,0,empty).unwrap_err(),"knowledge_no_text");
        import(&mut conn,0,sample()).unwrap();
        for q in ["%","_","*", "OR", "\" OR DNA", "' OR 1=1--"] { assert!(search(&conn,q).unwrap().is_empty(),"{q}"); }
        assert!(search(&conn,"").is_err());
        assert!(search(&conn,&"中".repeat(101)).is_err());
    }
    #[test]
    fn chinese_chunks_preserve_content_and_overlap() {
        let text = "光".repeat(1701); let result = chunks(&text);
        assert_eq!(result.iter().map(|s|s.chars().count()).collect::<Vec<_>>(),vec![800,800,261]);
        assert_eq!(result.concat().chars().count()-160,1701);
    }
    #[test]
    fn persists_after_reopen_and_removes_index_text() {
        let path = std::env::temp_dir().join(format!("synthetic-knowledge-{}-{}.sqlite",std::process::id(),std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        { let mut conn = crate::storage::open(&path).unwrap(); init(&conn).unwrap(); import(&mut conn,0,sample()).unwrap(); }
        { let mut conn = crate::storage::open(&path).unwrap(); init(&conn).unwrap(); assert_eq!(search(&conn,"光合作用").unwrap().len(),1); remove(&mut conn,1,&"a".repeat(64)).unwrap(); }
        let bytes=std::fs::read(&path).unwrap();
        assert!(!bytes.windows("光合作用".len()).any(|w|w=="光合作用".as_bytes()));
        std::fs::remove_file(path).unwrap();
    }
}
