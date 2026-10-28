# 软件账号与次数服务

> 2026-10-28 当前发布：`20261028-cloze-v10`，增加客户端v10输出预算兼容（16384）；原v7/v8/v9预算、数据库版本、Key与计次规则保留。14项测试在本机/Ubuntu通过，原网站与账号健康。读取正文和听写质量规则由客户端执行，账号服务器不接收题干或模型正文。

> 2026-10-28 最新发布：`20261028-fact-repair-v8`；v7/v8任务均返回maxOutputTokens=16384，旧版本维持4096。数据库、Key文件与扣次规则保留，14项测试在本机/Ubuntu通过。客户端v8修复知识点核验逐项保留与定向重试；服务器只保留预算和任务元数据。

> 2026-10-28 当前发布：`20261028-text-only-v7`，在原服务器原子切换。仅调整v7任务的maxOutputTokens为16384，旧提示词版本保留4096；总预算、Key文件、数据库版本6与扣次规则不变。14项测试在本机/Ubuntu通过，原网站及账号服务健康。管理员此前已配置真实Key，用户无需重填；下方尚未配置的表述是初次上线时记录。

> 2026-10-28：v2 工作流授权、共享模型 Key 配置与下发、心跳、任务查询和幂等结束接口已部署到生产服务器，数据库升级为版本 6。线上版本为 `20261028-workflow-v6-1793161758`；下方版本 5 的部署描述是历史快照，旧版计次与手填 Key 入口保留兼容。真实模型 Key 尚未配置。

## v2 共享模型授权

Key 保存在云端 `MODEL_KEY_FILE` 指定的受限文件中，不进入账号数据库、次数流水或源码。管理员在桌面“生成报告 → 云端模型 · 双模式内容测试 → 管理员：配置云端模型 Key”中经 HTTPS 保存；普通用户看不到此输入。生产 systemd 配置使用 `/var/lib/user-store/shared-model-key`，目录 0700、文件 0600，服务用户为 `mistake-agent`。也支持从受限进程环境读取 `SHARED_MODEL_KEY` 作为首次配置；不将真实值写入示例文件或终端日志。

| 接口 | 行为 |
|---|---|
| `GET /v2/model-status` | 登录后查看是否配置及配置版本；不返回 Key |
| `POST /v2/admin/model-config` | 管理员设置/轮换 Key；返回结果不含 Key |
| `POST /v2/report-runs` | 核验账号、余额与范围；共用既有 generations 预占，一账号同时一批 |
| `POST /v2/report-runs/:id/credential` | 仅活动任务所有者经 HTTPS 领取 Key；仅 Rust 接收 |
| `POST /v2/report-runs/:id/heartbeat` | 每约20秒续验，正常客户端90秒失去授权则停止；不上传学生和题目 |
| `GET /v2/report-runs/:id` | 查询任务归属、预算和完成状态，不返回 Key |
| `GET /v2/active-report-run` | 查找本账号中断的任务，供显式释放预占 |
| `POST /v2/report-runs/:id/finish` | 失败/部分完成/取消释放；正式完成的扣次幂等 |

响应统一 `Cache-Control: no-store`，Fastify 不记录请求或响应正文。生产必须 `ALLOW_LOCAL_CREDENTIALS=false`；本机临时服务测试可设为 true，且仅允许回环主机。端点和模型固定为 DeepSeek 官方 `deepseek-flash`，服务器不代理推理，不接收学生名单、试卷、逐题成绩或生成正文。

桌面 Key 只进入单任务 Rust 内存，使用 `Zeroizing<String>` 清理所管理的 Key 缓冲区；任务结束先清理本机，再等待云端释放，因此断网不阻止清理。取消、模型鉴权/额度错误、授权或绝对时限到期、账号失效、登出、页面重新加载和窗口销毁均停止/清理；迟到的旧任务结束事件不会清掉新任务的 Key。Key 不回传 React，不写 SQLite、检查点、日志或 PDF。HTTP/TLS/操作系统仍可能保留临时内存副本，这不是对换页文件、内存转储或被修改客户端的物理擦除保证。共享 Key 已下发后不能阻止恶意客户端自行复制；若要求客户电脑始终拿不到 Key，需改成服务器代理。

新入口当前只测试内容，完成后使用 `outcome=partial` 释放预占，不扣成功次数；服务商模型请求仍有成本。`WORKFLOW_DELIVERY_ENABLED=false` 为默认值，服务端拒绝新流程成功扣次，避免尚未验收 PDF 时提前结算。后续 PDF 验收和跨模式计次政策明确后再开启正式交付；旧 v1 客户端保持原收费逻辑，v1 finish 不能结算 v2 任务。

部署前先停止服务并备份账号库与现有服务配置，发布新源码与依赖，更新 systemd 环境中的 `MODEL_KEY_FILE`，再启动。版本 5 升级 6 会先创建本地 SQLite 快照并事务创建 `report_runs`；保留账号 ID、余额、历史流水及旧接口。回滚应使用部署前快照和旧发布目录，不能直接让旧程序打开版本 6 库；回滚前需处理升级后新增的数据，避免覆盖。

本地与 Ubuntu 上均通过 13 项服务端测试，包含 v2 配置权限、Key 不进普通响应/数据库、HTTPS、归属、预占、租约、冻结、到期、预算、幂等和旧接口兼容。已使用服务器既有 SSH 密钥完成上线；没有设置真实 Key 或调用付费模型。负责人可在软件管理员入口填写真实 Key，经 HTTPS 写入服务器受限文件。

生产发布目录为 `/opt/mistake-agent/releases/20261028-workflow-v6-1793161758`，`current` 已原子切换。以 `/etc/systemd/system/mistake-agent-accounts.service.d/workflow-v6.conf` 增加三个工作流环境设置，保留原 service 文件和 Caddy 配置。完整备份位于 `/var/lib/user-store/workflow-deploy-backups/20261028-workflow-v6-1793161758/`，其中有 `accounts-before.sqlite3`、`previous.service` 和旧发布目录记录。升级前后 users、sessions、generations、credit_ledger、account_audit 逐表差异均为 0；数据库完整性与外键检查通过，保留 2 个账号、1 个管理员、总余额10次和1条流水。

公网健康检查为200，v1账号接口和v2模型状态接口未登录均返回401，原网站返回200。部署审计仅含计数与状态，保存在项目忽略目录 `output/cloud-workflow-v6-deployment-audit.json`。部署工具为 `deploy/activate-workflow-v6.sh` 和 `deploy/verify-upgrade.mjs`；审计通过 SQLite 内部比较行数据，只输出差异计数，不输出密码、会话令牌或用户明细。

支持用户名密码注册/登录、退出、服务器端登录会话、剩余次数查询、管理员加次、密码查看/修改和次数流水。适用于 Ubuntu 单机部署，数据库为服务器上的 SQLite，不需要另装数据库服务。学生名单、成绩、试卷、知识库和补练正文不会上传到账号服务。

## 规则

- 用户名为 3～32 位英文字母、数字、下划线，不区分大小写；密码 10～128 位。**2026-10-27 晚间按负责人明确要求改为明文保存**：新注册和设置密码写入 `users.password_plain`，`password_hash` 留空。数据库及包含明文的备份泄露将直接暴露密码，不应把当前方式描述为安全的密码哈希存储。
- 旧账号保留原 scrypt 哈希，迁移不重置任何密码。旧用户首次成功登录时，用其提交的正确密码写入明文字段并清空哈希；错误登录和仅升级数据库不会转换。旧哈希无法逆推出密码，查看时返回“旧哈希无法还原”，可等待用户登录或由管理员设置新密码。
- 所有用户行（含管理员本人）有“设置密码”和“查看密码”。修改管理员账号的密码须验证操作者当前密码；修改后撤销目标全部会话、释放未完成预占，余额与冻结状态保留，修改自己后立即退出并要求新密码登录。普通用户无权调用管理密码接口。
- 查看任何账号密码均须验证操作者当前管理员密码，成功后显示 30 秒自动隐藏；只在专用管理查看接口返回明文，普通用户列表、登录响应及审计不返回明文。查看和修改各自留操作者/目标/时间记录，记录不含密码；客户端不把查看结果或输入密码持久化到本机。
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

负责人指定的基础库为 `/var/lib/user-store/users.sqlite3`，原表只有 `username/password_hash/remaining_uses`，检查时为空库。现已备份并升级到版本 5，包含 `users/sessions/generations/credit_ledger/account_audit`；`remaining_uses` 映射到当前 API 的 `credits`。保留 STRICT 约束，增加账号角色、唯一 ID、账号状态、会话摘要、并发预占、次数流水、冻结/恢复和密码操作审计及 `password_plain`。旧审计表在事务中迁移并保留既有记录。数据库文件权限 0600，目录 0700，归独立系统账号 `mistake-agent` 所有。

迁移器只自动处理已知的三字段基础结构。非空库要求用户名合法且不发生大小写冲突、余额为非负整数、密码为当前支持的 scrypt 摘要；不满足则停止，不猜测或重置密码。迁移前以 SQLite 完整快照保留备份，测试已验证哈希及余额保留和失败时原表不变。

- 账号服务入口：`https://codeqiqi.com/mistake-agent/`
- 独立管理网页：`https://codeqiqi.com/mistake-agent/admin`
- 内部监听：`127.0.0.1:8787`，由现有 Caddy 按 `/mistake-agent/*` 转发；现有网站继续使用原后端。
- 源码：`/opt/mistake-agent/current`，实际发布目录 `/opt/mistake-agent/releases/20261027-accounts-v5`。
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
