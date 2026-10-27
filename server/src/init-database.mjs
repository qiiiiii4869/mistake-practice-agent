import { openDatabase } from './database.mjs';
const db=openDatabase(process.env.DATABASE_PATH??'./data/accounts.sqlite');
try{
  console.log(JSON.stringify({version:db.prepare('PRAGMA user_version').get().user_version,
    integrity:db.prepare('PRAGMA quick_check').get().quick_check,
    tables:db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row=>row.name),
    users:db.prepare('SELECT COUNT(*) AS n FROM users').get().n}));
}finally{db.close();}
