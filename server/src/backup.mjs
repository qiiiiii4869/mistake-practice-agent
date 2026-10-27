import { DatabaseSync, backup } from 'node:sqlite';
const destination=process.argv[2];
if(!destination){console.error('Usage: node src/backup.mjs /private/path/backup.sqlite');process.exit(1);}
const db=new DatabaseSync(process.env.DATABASE_PATH??'./data/accounts.sqlite',{readOnly:true});
try{await backup(db,destination);console.log('Backup completed.');}finally{db.close();}
