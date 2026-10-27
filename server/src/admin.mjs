import { openDatabase, transaction } from './database.mjs';
const [command, username] = process.argv.slice(2);
if (command !== 'promote' || !/^[a-zA-Z0-9_]{3,32}$/.test(username ?? '')) {
  console.error('用法：先正常注册账号，然后 npm run admin -- promote 用户名'); process.exit(1);
}
const db = openDatabase(process.env.DATABASE_PATH ?? './data/accounts.sqlite');
try {
  transaction(db, () => {
    const user = db.prepare('SELECT id,status FROM users WHERE username=?').get(username.toLowerCase());
    if (!user) throw new Error('账号不存在，请先注册。');
    if (user.status !== 'active') throw new Error('已注销账号不能被设为管理员。');
    db.prepare("UPDATE users SET role='admin' WHERE id=?").run(user.id);
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);
  });
  console.log('已设为管理员，请重新登录。');
} finally { db.close(); }
