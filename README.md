# 错题智能推送 Agent

> 整体产品计划、架构和进度见 [计划进度表.md](计划进度表.md)。

当前可读取、导入、保存和分析逐题得分，不生成新题，不修改智学网成绩。

## 下载源码与启动

当前首先支持 Windows 开发验证。需要 Node.js 24、Rust、Visual Studio C++ 生成工具和 WebView2。

```powershell
git clone https://github.com/qiiiiii4869/mistake-practice-agent.git
cd mistake-practice-agent
npm --prefix app ci
npm --prefix app run desktop:build:debug
.\app\start-windows.ps1
```

已有本地副本可用 `git pull` 获取更新。程序由教师使用自己的智学网账号手动登录。仓库不包含学生数据、数据库、登录态、API Key、编译产物或本机审计报告。文中历史实测文件名是维护者本机记录；公开仓库的 `output/` 仅含说明。

运行 Python 离线测试或界面模拟检查前，创建本机环境并安装依赖：

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e .\vendor\zhixuewang-python
```

界面模拟检查使用已安装的 Microsoft Edge，第三方源码与许可证说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## Windows 桌面端（阶段 1、2 已通过）

2026-10-25 21:21（北京时间），Tauri 内置窗口真实账号登录与考试读取通过：已确认教师会话、1 个任教班级、6 场考试，5 个接口成功，本次未观察到 60500。教师已确认读取成功。匿名证据见 `output/tauri-login-verification-audit.json`（本机记录，不随仓库分发）。

**2026-10-25 21:36（北京时间），桌面全班实测通过。** 内置窗口读取 50 人名单：49 人 × 24 题，共 1176 条记录，1 人无原卷。已通过 TS 核心校验保存 SQLite，重启恢复成功，与原 Python 审计统计一致。匿名证据见 `output/desktop-full-class-verification-audit.json`（本机记录，不随仓库分发）。原扩展文件经 TS 导入校验通过，证据见 `output/desktop-import-verification-audit.json`（本机记录，不随仓库分发）。

主通道采用内置登录，扩展导入为备用；只保留当前一场考试，支持确认替换、清除、本场教师设置及按题、按学生的薄弱题统计。运行 `.\app\start-windows.ps1` 打开程序；使用与开发说明见 [`app/README.md`](app/README.md)。前端及 Windows 调试版构建、34 项核心测试、6 项 Rust 测试、11 组桌面模拟检查通过，原有扩展与 Python 回归检查也通过。

## Chrome 扩展（备用入口及历史实测）

**当前测试版本为 0.3.3。** 0.3.0 实测处理 50 人，其中 49 人各 24 题成功，共 1176 条记录；最后一人的原卷 HTML 数据未能解析。0.3.1 增加同权限下的结构化记录接口补读；0.3.2 将名单成绩栏标为“没扫”的学生单独记录、不判对错，0.3.2 实测发现第 50 名学生成绩栏为数字、名单标明无原卷，两个接口均无逐题记录；0.3.3 按官方班级成绩页的“查看原卷”规则（`hasOriginPaper`，缺失时看排名代码 -2/-3）将其单独记为“无原卷”，保留总分，不判对错。审计脚本按“已导出 + 没扫 + 无原卷 = 名单人数”核对。

**2026-10-25 19:12，0.3.3 全班实测通过。** 名单 50 人：49 人各 24 题，共 1176 条逐题记录（全对 524、全错 346、部分得分 306）；1 人无原卷（名单总分 0、排名代码 -3），单独记录、不判对错；失败 0 人。题号和满分在 49 人间一致。审计结果见 `output/full-class-verification-audit.json`（本机记录，不随仓库分发）。无原卷学生是缺考还是其他原因，需要教师核对。试卷照片与题号的关联尚未验证。按用户最终需求，只读取每名学生的题号、得分、满分和对错状态，不验证答题卡图片。试卷由教师拍照上传后另行关联。

**2026-10-25 18:06，真实账号的自动样本导出已成功。** 已读取当前教师的 1 个任教班级、1 门学科、6 场考试和 50 人名单，并自动保存 3 名学生各 24 题，共 72 条逐题记录。每名学生包含 19 道客观题作答、5 道主观题得分和 12 条小问得分。下载文件已重新打开核对：学生标识不重复、题号不重复、分数范围正确、失分标记与分数一致。

核对结果见 `output/live-verification-audit.json`（本机记录，不随仓库分发），仅含匿名统计，不复制原始学生数据。原始样本保留在用户下载目录中。后续全班实测已通过，见上文 0.3.3 记录；原始题干由教师上传试卷提供。

使用 `browser-probe` 中的 Chrome 扩展，操作说明见 [`browser-probe/使用说明.md`](browser-probe/使用说明.md)。
它复用当前普通 Chrome 的教师登录，用户选择考试、学科和班级后，程序自动读取全班名单与逐题得分，并生成本机下载文件。

版本 0.3.3 已通过 33 项扩展核心测试和 13 项 Python 离线测试（含审计脚本的没扫、无原卷学生核对），界面沿用已通过 4 组模拟流程检查的全班页面；这些都不是实际账号测试。

2026-10-25 用户生成的 `Downloads/zhixue-auto-export/diagnostic.json` 确认了真实教师会话，失败点为旧版 `/exam/marking/schoolClass` 请求（未收到 HTTP 状态，不能认定是权限拒绝）。按照任课教师场景，现改为从 `getUserTeachingInfos` 读取任教范围，单一学科和班级自动选中，并使用 `singleScoreList` 读取班级单科学生名单。新版已通过上述真实样本实测。

此前 Playwright 测试窗口遭遇验证码 `60500`（用户反馈）；普通 Chrome 可以登录（用户反馈）。桌面控制工具因不能可靠识别当前网址而停止，不代表智学网拒绝数据接口。扩展通过 Chrome 的 `activeTab` 临时授权和源码内的网址核对来限定测试页面，不通过桌面输入工具操作浏览器。

新版考试列表和认证请求的实现依据为 2026-10-25 核对的智学网官方前端公开脚本。扩展只读测试和原来的 Playwright 测试脚本是两个独立入口，后者暂不推荐用于真实登录。

## 已完成的本地检查

- 固定上游仓库 `anwenhu/zhixuewang-python` 的提交为 `b5e36428deb0a3ae5f4ac8da34bac2a40019ee25`，源码位于 `vendor/zhixuewang-python`。
- 创建独立 Python 环境并成功导入上游教师模块。
- 6 项离线测试通过：标准作答结构、页面脚本格式变化、登录页、空数据、非法分数、报告脱敏。
- 复现上游解析器在 `var` 改为 `const` 或变量间插入其他脚本时返回空题目列表的问题。离线测试为合成数据，不能证明真实账号可用。
- 2026-10-25 实际访问：直连登录页 HTTP 200，存在账号和密码输入框；未登录的账号接口返回 `errorCode=-200, result=null`。本机代理请求超时，专用验证浏览器采用直连，不修改系统代理。

## 真实账号验证

使用工作区根目录下的 PowerShell：

```powershell
.\.venv\Scripts\python.exe .\tools\verify_zhixue.py
```

在弹出的 Edge 中手动登录教师账号，依次打开考试、班级和一名学生的原卷／答题详情。
浏览器默认保留 30 分钟；关闭浏览器会结束验证。登录态只在这次浏览器会话中使用。

验证结果写入 `tmp/zhixue-verification.json`。只保存已知接口路径、HTTP 状态、经白名单过滤的结构和统计，不保存密码、Cookie、学生姓名、作答原文或原始响应。

必须分别核对以下条件，不能用“HTTP 200”代替通过：

1. 确认实际为教师会话。
2. 考试接口包含真实考试列表。
3. 班级学生接口能提供教师有权限读取的学生列表。
4. 至少一名学生的答卷中含逐题答案、得分、满分等字段。
5. 另行确认题干和标准答案的来源；得分接口中的 `standardScore` 是满分，不是标准答案。

“已观察到接口响应”只表示抓到了结构，仍需检查成功状态和列表内容。学生失分只作为补练选题依据，不能单凭失分确定具体错因。

## 重跑离线检查

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
node --test tests/test_browser_probe.mjs
.\.venv\Scripts\python.exe tests/check_popup_ui.py
```

全班文件下载后，运行以下命令核对数据完整性，生成匿名审计报告：

```powershell
.\.venv\Scripts\python.exe tools/audit_full_class.py
```
