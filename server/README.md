# 软件账号与次数服务

支持用户名密码注册/登录、退出、服务器端登录会话、剩余次数查询、管理员加次和次数流水。适用于 Ubuntu 单机部署，数据库为服务器上的 SQLite，不需要另装数据库服务。学生名单、成绩、试卷、知识库和补练正文不会上传到账号服务。

## 规则

- 用户名为 3～32 位英文字母、数字、下划线，不区分大小写；密码 10～128 位。密码用带随机盐的 scrypt 派生后存储，不保存明文。
- 新注册账号默认普通用户、0 次。管理员只能在服务器命令行授权，不能通过注册参数获取权限。
- 公共注册接口只接受用户名和密码，角色、状态和余额由服务器固定为普通用户、正常、0 次；伪造管理员或余额字段会被拒绝。服务器授权命令也不能把已注销账号改成管理员。
- 管理员可冻结普通用户（原“注销”，界面现统一使用“冻结”）：输入目标用户名并填写原因，撤销全部会话、取消未完成预占，余额与历史保留；被冻结用户不能登录、加次或重新注册同名账号。
- 被冻结的普通用户可“恢复用户”：输入用户名和恢复原因，保留原密码、次数和流水，需要重新登录。恢复不重建旧会话或生成预占；重复的旧冻结/恢复请求不会覆盖后续状态。
- 普通用户可“删除用户”：输入目标用户名并勾选永久删除确认，事务删除当前云端库中的账号、密码摘要、会话、生成任务、次数流水和关联账号审计，不保留含用户 ID 的墓碑记录。删除后不能通过恢复功能找回，同名可重新注册为新 UUID、普通用户和 0 次；旧删除请求不会误删新账号。历史数据库备份及用户电脑上的本地资料不在这一操作范围。
- 管理员及操作者本人不能被冻结、恢复或删除；注册仍只生成普通用户。数据库启用 `secure_delete`，删除后尝试截断 WAL，但这不是对磁盘、历史备份或快照的物理擦除承诺。
- 管理员在桌面软件登录一次后，服务器返回管理员身份，软件默认进入“管理用户与次数”；顶部可切换教学工作台。列表、加次及流水通过 Rust 复用当前登录会话，不需要再次登录，不向网页界面传递会话令牌。服务器仍对每个管理请求检查管理员权限。
- 独立浏览器入口仍为 `/admin`，从浏览器直接访问时在该入口登录一次。可以搜索用户、添加次数并填写备注，查看操作人、时间、余额流水。每笔添加有唯一操作编号，重试不会重复入账。
- 真实出题开始前预占 1 次，同一账号同时只允许一批生成。生成至少一题自检通过的补练后确认扣 1 次；未生成可用题或失败则释放。预占最多 2 小时，超时不扣费。
- 服务器事务校验余额不为负，完成请求可重复提交但只扣一次。离线演示、修改后自检、同批次单题重出、审核及已有结果 PDF 下载不另外扣次。
- 桌面端的已生成结果先保存在账号专属恢复文件，次数确认超时可重试。确认后自动保存考试与补练；恢复文件在成功保存相同结果后清理。开始后直接关闭程序的未完成任务，重新登录可释放预占。
- 账号会话最长 12 小时，桌面每 45 秒重新核对，断网暂停工作区访问。令牌只在当前内存中保存，服务器只存令牌摘要，重启需登录。
- 当前计次由官方桌面客户端报告成功，模型仍沿用用户本机 API Key。这是首版账号与用量管理，不是防篡改授权：正式对不可信客户端计费前，应将模型执行与完成判定放到服务端，避免修改客户端后绕开计次；支付回调尚未接入，管理员依据线下收款手动加次。

## 本机运行

安装 Node.js 24.16 或更新的 24 系列，在 `server` 目录运行：

```powershell
npm ci
npm start
```

默认仅监听 `127.0.0.1:8787`，数据库在 `server/data/accounts.sqlite`。用桌面注册自己的账号后，在另一个终端进入 `server`：

```powershell
npm run admin -- promote 你的用户名
```

此命令撤销这个账号已有会话。在桌面软件重新登录后会直接进入管理工作台，不再打开另一个需要登录的窗口。也可独立访问 `http://127.0.0.1:8787/admin`。没有预置账号或默认密码。

桌面端的服务地址在编译时指定，不让登录表单或外部页面改变密码发送目标：

```powershell
$env:MISTAKE_ACCOUNT_API_URL='http://127.0.0.1:8787'
npm --prefix app run desktop:build:debug
```

上面的编译命令从项目根目录执行。公网必须使用 HTTPS；明文 HTTP 只接受本机回环地址。未配置地址的构建只显示登录页，不绕过登录。

## Ubuntu 部署

### 已有 Ubuntu 与 Caddy 的部署（2026-10-27）

负责人指定的基础库为 `/var/lib/user-store/users.sqlite3`，原表只有 `username/password_hash/remaining_uses`，检查时为空库。现已备份并升级到版本 3，包含 `users/sessions/generations/credit_ledger/account_audit`；`remaining_uses` 映射到当前 API 的 `credits`。保留 STRICT 约束，增加账号角色、唯一 ID、账号状态、会话摘要、并发预占、次数流水及冻结/恢复审计。版本 2 的审计表在事务中迁移并保留既有记录。数据库文件权限 0600，目录 0700，归独立系统账号 `mistake-agent` 所有。

迁移器只自动处理已知的三字段基础结构。非空库要求用户名合法且不发生大小写冲突、余额为非负整数、密码为当前支持的 scrypt 摘要；不满足则停止，不猜测或重置密码。迁移前以 SQLite 完整快照保留备份，测试已验证哈希及余额保留和失败时原表不变。

- 账号服务入口：`https://codeqiqi.com/mistake-agent/`
- 独立管理网页：`https://codeqiqi.com/mistake-agent/admin`
- 内部监听：`127.0.0.1:8787`，由现有 Caddy 按 `/mistake-agent/*` 转发；现有网站继续使用原后端。
- 源码：`/opt/mistake-agent/current`，实际发布目录 `/opt/mistake-agent/releases/20261027-accounts-v3`。
- Node：`/opt/mistake-agent/runtime/node-v24.16.0-linux-x64/bin/node`，安装包按官方 SHASUMS 校验。该服务器无法直连 Docker 镜像站，因此采用独立 Node + systemd，无需改变现有容器。
- 服务：`mistake-agent-accounts.service`，已启用开机启动和故障重启，独立用户、只读系统目录，数据库目录可写，内存上限 384 MiB。
- 原库备份：`/var/lib/user-store/backups/users-before-account-api-20261027-101053.sqlite3`，另保留自动升级快照及原 `schema.sql` 副本。配置备份位于 `/etc/caddy/Caddyfile.before-mistake-agent-20261027-101338`。

管理员 `wangmin` 已按负责人要求迁移到云端，保留原 UUID、密码摘要、管理员角色、10 次余额和原次数流水；不迁移本机登录令牌、不传学生资料。迁移前备份，导出文件通过 SSH 传输并校验后导入，迁移完成后私有导出文件已删除。云端和本机摘要核对一致，可用原密码登录；当前桌面可执行程序已按下述正式入口编译：

```powershell
$env:MISTAKE_ACCOUNT_API_URL='https://codeqiqi.com/mistake-agent/'
npm --prefix app run desktop:build:debug
```

常用维护命令（服务器）：

```bash
systemctl status mistake-agent-accounts.service --no-pager
journalctl -u mistake-agent-accounts.service -n 50 --no-pager
runuser -u mistake-agent -- env DATABASE_PATH=/var/lib/user-store/users.sqlite3 /opt/mistake-agent/runtime/node-v24.16.0-linux-x64/bin/node /opt/mistake-agent/current/src/backup.mjs /var/lib/user-store/accounts-backup.sqlite3
```

迁移工具为 `src/admin-transfer.mjs`，仅在服务器/本机命令行运行，不能通过公共 HTTP 使用。导入会核对摘要格式、管理员角色、完整次数流水和余额，账号冲突或流水不一致时拒绝覆盖；重复导入不会重复增加余额或流水。请始终显式指定数据库路径和私有导出位置。

不要通过静态站点或公网端口直接提供数据库文件。桌面和独立网页均只通过 HTTPS 后端读写账号及次数。

### 新服务器的 Docker 备选方案

服务器需要 Docker Engine 与 Compose 插件，域名 A/AAAA 记录指向本机，开放 80/443。以下从仓库根目录执行；替换域名，不使用示例地址上线：

```bash
export ACCOUNT_DOMAIN=accounts.example.com
docker compose -f server/deploy/compose.yaml up -d --build
```

Caddy 自动申请 HTTPS 证书；服务不向公网发布 8787 端口。打开 `https://你的域名/admin` 会看到登录入口。先把桌面版本连接到正式域名并注册所有者账号，再授权：

```bash
docker compose -f server/deploy/compose.yaml exec api node src/admin.mjs promote 你的用户名
```

桌面构建时设 `MISTAKE_ACCOUNT_API_URL=https://你的域名`，重新编译，再分发这个版本。账号数据库在 Docker `accounts` 持久卷，容器升级不删除数据。

反向代理的客户端地址配置：默认只信任回环地址。Compose 使用专用 `172.29.81.0/24` 网络，API 仅信任 Caddy 的 `172.29.81.2`；API 不公布端口。如果该子网与你现有网络冲突，同时调整网络和 `TRUST_PROXY`。勿将代理信任设置为 `true` 后直接暴露 API。

备份时使用 SQLite 在线备份命令，不直接复制写入中的单个数据库文件：

```bash
docker compose -f server/deploy/compose.yaml exec api node src/backup.mjs /srv/data/accounts-backup.sqlite
docker compose -f server/deploy/compose.yaml cp api:/srv/data/accounts-backup.sqlite ./accounts-backup.sqlite
```

备份包含账号和用量信息，应保存在你的服务器私有位置。不要运行 `docker compose down -v`，它会删除持久卷。

## 本机旧数据

新版按软件账号隔离本机数据：`%LOCALAPPDATA%/com.local.mistake-agent/accounts/<账号ID>/`。当前考试、知识库、智学网登录资料、恢复文件和导出临时文件均在账号目录。旧版本根目录的考试和知识库保留，不自动归给第一个注册用户；有需要时再确认迁移归属。

## 验证

```powershell
npm --prefix server test
```

接口测试覆盖注册校验、密码摘要、会话撤销与到期、权限拒绝、并发加次去重、余额预占、失败释放、跨账号拒绝、成功只扣一次、次数不足及数据库重开。浏览器检查使用临时账号库，不调用智学网或大模型；不能替代 Ubuntu 上的实际部署验收。

桌面单次登录管理流程检查（从仓库根目录运行）：

```powershell
.\.venv\Scripts\python.exe tests/check_accounts_ui.py
```

检查使用临时数据库及合成账号，实际请求本机账号 API；验证管理员仅发生一次软件登录就进入管理页、切换教学工作台后仍可直接返回管理页，并用同一会话加次和查询流水。也覆盖普通用户权限拒绝及独立浏览器管理页的超时恢复。当前管理页已集成在主窗口，不再新建管理 WebView；此前的 `native-window-check` 独立窗口检查入口已移除。
