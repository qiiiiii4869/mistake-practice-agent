import { readFileSync,writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID,createHash } from 'node:crypto';
import { openDatabase,transaction } from './database.mjs';

export function exportAdmin(db,username){
  return transaction(db,()=>{
    const user=db.prepare('SELECT id,username,password_hash,role,status,credits,created_at,last_login_at FROM users WHERE username=?').get(username.toLowerCase());
    if(!user||user.role!=='admin'||user.status!=='active')throw new Error('active_admin_required');
    if(db.prepare("SELECT COUNT(*) AS n FROM generations WHERE user_id=? AND state='reserved' AND expires_at>?").get(user.id,Date.now()).n)throw new Error('generation_in_progress');
    const ledger=db.prepare('SELECT * FROM credit_ledger WHERE user_id=? ORDER BY rowid').all(user.id);
    return {schemaVersion:1,user,ledger};
  });
}

export function importAdmin(db,document){
  const uuid=/^[a-f0-9-]{36}$/;
  const u=document?.user;
  if(document?.schemaVersion!==1||!u||!uuid.test(u.id)||!/^[a-z0-9_]{3,32}$/.test(u.username)
    ||!/^scrypt-v1\$[a-f0-9]{32}\$[a-f0-9]{128}$/.test(u.password_hash)||u.role!=='admin'||u.status!=='active'
    ||!Number.isSafeInteger(u.credits)||u.credits<0||u.credits>1000000||!Number.isSafeInteger(u.created_at)
    ||(u.last_login_at!==null&&!Number.isSafeInteger(u.last_login_at))||!Array.isArray(document.ledger)||document.ledger.length>10000)
    throw new Error('invalid_admin_transfer');
  let balance=0;const ids=new Set(),references=new Set();
  for(const row of document.ledger){
    if(!uuid.test(row.id)||row.user_id!==u.id||!(row.actor_id===null||row.actor_id===u.id)||!['admin_grant','generation'].includes(row.kind)
      ||!Number.isSafeInteger(row.delta)||!Number.isSafeInteger(row.balance_after)||row.balance_after<0||row.balance_after>1000000
      ||typeof row.reference!=='string'||row.reference.length>200||typeof row.reason!=='string'||!row.reason.trim()||row.reason.length>200
      ||!Number.isSafeInteger(row.created_at)||ids.has(row.id)||references.has(row.kind+':'+row.reference))throw new Error('invalid_admin_transfer');
    balance+=row.delta;if(balance!==row.balance_after)throw new Error('ledger_balance_mismatch');
    ids.add(row.id);references.add(row.kind+':'+row.reference);
  }
  if(balance!==u.credits)throw new Error('ledger_balance_mismatch');
  return transaction(db,()=>{
    const existing=db.prepare('SELECT * FROM users WHERE id=? OR username=?').all(u.id,u.username);
    if(existing.length){
      const old=existing[0];
      if(existing.length!==1||old.id!==u.id||old.username!==u.username||old.password_hash!==u.password_hash||old.role!=='admin'||old.status!=='active'||old.credits!==u.credits)
        throw new Error('existing_account_conflict');
      const oldLedger=db.prepare('SELECT * FROM credit_ledger WHERE user_id=? ORDER BY rowid').all(u.id);
      if(JSON.stringify(oldLedger)!==JSON.stringify(document.ledger))throw new Error('existing_ledger_conflict');
      return {username:u.username,id:u.id,credits:u.credits,role:'admin',duplicate:true};
    }
    db.prepare("INSERT INTO users(id,username,password_hash,role,status,credits,created_at,last_login_at) VALUES(?,?,?,'admin','active',?,?,?)")
      .run(u.id,u.username,u.password_hash,u.credits,u.created_at,u.last_login_at);
    const insert=db.prepare('INSERT INTO credit_ledger VALUES(?,?,?,?,?,?,?,?,?)');
    for(const row of document.ledger)insert.run(row.id,row.user_id,row.delta,row.balance_after,row.kind,row.actor_id,row.reference,row.reason,row.created_at);
    db.prepare("INSERT INTO account_audit VALUES(?,?,?,'import_admin',?,?,?)").run(randomUUID(),u.id,u.id,'admin-import:'+u.id,'从本机迁移管理员账号与次数流水',Date.now());
    return {username:u.username,id:u.id,credits:u.credits,role:'admin',duplicate:false};
  });
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [mode,value,destination]=process.argv.slice(2);
  let db;
  try{
    if(!['export','import'].includes(mode)||!value||(mode==='export'&&!destination))throw new Error('invalid_transfer_command');
    const path=process.env.DATABASE_PATH??'./data/accounts.sqlite';db=openDatabase(path);
    if(mode==='export'){
      const document=exportAdmin(db,value),content=JSON.stringify(document);
      writeFileSync(destination,content,{flag:'wx',mode:0o600});
      console.log(JSON.stringify({username:document.user.username,id:document.user.id,credits:document.user.credits,ledgerRows:document.ledger.length,sha256:createHash('sha256').update(content).digest('hex')}));
    }else{
      const content=readFileSync(value);if(content.length>8*1024*1024)throw new Error('invalid_admin_transfer');
      const document=JSON.parse(content.toString('utf8'));
      if(path!==':memory:')db.prepare('VACUUM INTO ?').run(resolve(path)+'.before-admin-import-'+Date.now()+'.sqlite3');
      console.log(JSON.stringify(importAdmin(db,document)));
    }
  }catch(error){
    const allowed=['invalid_transfer_command','active_admin_required','generation_in_progress','invalid_admin_transfer','ledger_balance_mismatch','existing_account_conflict','existing_ledger_conflict'];
    console.error(allowed.includes(error.message)?error.message:'admin_transfer_failed');process.exitCode=1;
  }finally{db?.close();}
}
