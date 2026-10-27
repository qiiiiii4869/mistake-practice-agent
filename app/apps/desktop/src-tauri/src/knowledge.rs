use rusqlite::{params, Connection, TransactionBehavior};
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Document { id: String, name: String, pages: Vec<Page> }
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Page { number: u32, text: String }
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Summary { id: String, name: String, page_count: u32, chunk_count: u32, empty_pages: Vec<u32> }
#[derive(Debug, Serialize)]
pub(crate) struct Library { revision: i64, documents: Vec<Summary> }
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Hit { document_id: String, name: String, page: u32, ordinal: u32, text: String }

pub(crate) fn init(conn: &Connection) -> Result<(), String> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS knowledge_state(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL);
        INSERT OR IGNORE INTO knowledge_state VALUES(1,0);
        CREATE TABLE IF NOT EXISTS knowledge_documents(id TEXT PRIMARY KEY, name TEXT NOT NULL, page_count INTEGER NOT NULL, empty_pages TEXT NOT NULL);
        CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_chunks USING fts5(document_id UNINDEXED, page UNINDEXED, ordinal UNINDEXED, text, tokenize='trigram');
        INSERT INTO knowledge_chunks(knowledge_chunks, rank) VALUES('secure-delete', 1);")
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
            documents.push(Summary { id,name,page_count,chunk_count,empty_pages: serde_json::from_str(&empty).map_err(|_| "storage_failed")? });
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
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|_| "storage_failed")?;
    advance(&tx, expected)?;
    let exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM knowledge_documents WHERE id=?1)", [&doc.id], |r| r.get(0)).map_err(|_| "storage_failed")?;
    if exists { return Err("knowledge_duplicate".into()); }
    let (documents, bytes): (i64,i64) = tx.query_row("SELECT (SELECT count(*) FROM knowledge_documents), coalesce(sum(length(cast(text AS blob))),0) FROM knowledge_chunks", [], |r| Ok((r.get(0)?,r.get(1)?))).map_err(|_| "storage_failed")?;
    let added: usize = prepared.iter().map(|(_,_,t)| t.len()).sum();
    if documents >= 100 || bytes + added as i64 > 100*1024*1024 { return Err("knowledge_limit".into()); }
    tx.execute("INSERT INTO knowledge_documents VALUES(?1,?2,?3,?4)", params![doc.id, doc.name.trim(), doc.pages.len() as u32, serde_json::to_string(&empty).map_err(|_| bad())?]).map_err(|_| "storage_failed")?;
    {
        let mut stmt = tx.prepare("INSERT INTO knowledge_chunks(document_id,page,ordinal,text) VALUES(?1,?2,?3,?4)").map_err(|_| "storage_failed")?;
        for (page,ordinal,text) in prepared { stmt.execute(params![doc.id,page,ordinal,text]).map_err(|_| "storage_failed")?; }
    }
    tx.commit().map_err(|_| "storage_failed")?;
    list(conn)
}

pub(crate) fn remove(conn: &mut Connection, expected: i64, id: &str) -> Result<Library, String> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|_| "storage_failed")?;
    advance(&tx, expected)?;
    let changed = tx.execute("DELETE FROM knowledge_documents WHERE id=?1", [id]).map_err(|_| "storage_failed")?;
    if changed != 1 { return Err("knowledge_conflict".into()); }
    tx.execute("DELETE FROM knowledge_chunks WHERE document_id=?1", [id]).map_err(|_| "storage_failed")?;
    tx.commit().map_err(|_| "storage_failed")?;
    list(conn)
}

pub(crate) fn search(conn: &Connection, query: &str) -> Result<Vec<Hit>, String> {
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
    let rows = stmt.query_map([value], |r| Ok(Hit { document_id:r.get(0)?, name:r.get(1)?, page:r.get(2)?, ordinal:r.get(3)?, text:r.get(4)? })).map_err(|_| "storage_failed")?;
    rows.collect::<Result<Vec<_>,_>>().map_err(|_| "storage_failed".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn db() -> Connection { let c = Connection::open_in_memory().unwrap(); init(&c).unwrap(); c }
    fn sample() -> Document { Document {id: "a".repeat(64),name:"模拟课本.pdf".into(),pages:vec![Page{number:1,text:"光合作用与细胞呼吸的关系。DNA replication.".into()},Page{number:2,text:"".into()}]} }
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
