// Deployment audit: compare existing rows inside SQLite; never print credentials or user rows.
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/database.mjs';

const [path,before,mode]=process.argv.slice(2);
if(!path)throw new Error('database_path_required');
const db=mode==='migrate'?openDatabase(path):new DatabaseSync(path,{readOnly:true});
try{
  const integrity=db.prepare('PRAGMA integrity_check').get().integrity_check;
  const foreignKeyErrors=db.prepare('PRAGMA foreign_key_check').all().length;
  const version=db.prepare('PRAGMA user_version').get().user_version;
  const counts={users:db.prepare('SELECT COUNT(*) AS n FROM users').get().n,
    admins:db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin'").get().n,
    credits:db.prepare('SELECT COALESCE(SUM(credits),0) AS n FROM users').get().n,
    ledger:db.prepare('SELECT COUNT(*) AS n FROM credit_ledger').get().n};
  const differences={};
  if(before){
    db.prepare('ATTACH DATABASE ? AS previous').run(before);
    for(const table of ['users','sessions','generations','credit_ledger','account_audit']){
      differences[table]=db.prepare(`SELECT COUNT(*) AS n FROM (SELECT * FROM main.${table} EXCEPT SELECT * FROM previous.${table})`).get().n
        +db.prepare(`SELECT COUNT(*) AS n FROM (SELECT * FROM previous.${table} EXCEPT SELECT * FROM main.${table})`).get().n;
    }
  }
  const passed=integrity==='ok'&&foreignKeyErrors===0&&Object.values(differences).every(n=>n===0);
  console.log(JSON.stringify({passed,version,integrity,foreignKeyErrors,counts,differences}));
  if(!passed)process.exitCode=1;
}finally{db.close();}
