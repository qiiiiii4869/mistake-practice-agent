# Windows 桌面端（阶段 1、2）

Tauri 2 + React + TypeScript。已支持教师内置登录、考试与任教班级选择、全班逐题得分读取、扩展文件导入、单场 SQLite 存储、教师设置与薄弱题统计。试卷识别、知识库、出题和 PDF 尚未接入。

2026-10-25 21:21（北京时间）教师会话、1 个任教班级、6 场考试验证通过，本次未观察到 60500。21:36 全班实测通过：50 人名单，49 人 × 24 题 = 1176 条逐题记录，1 人无原卷。SQLite 保存与重启恢复已确认，TS 重新校验的统计与 Python 原审计一致。证据位于根目录 `output/desktop-full-class-verification-audit.json`。原扩展文件也已通过 TS 导入校验，证据为 `output/desktop-import-verification-audit.json`，原始数据没有复制进项目。

## 使用

在项目根目录 PowerShell 执行：

```powershell
.\app\start-windows.ps1
```

1. 点击“打开智学网登录”，由教师手动登录；然后点击“读取考试列表”。
2. 在“全班逐题得分”中选择考试、学科和任教班级，点击“读取全班逐题得分”。单一选项自动选中，班级受学科约束。考试列表为当前学期第一页，最多 30 场。
3. 完整校验后保存到本机。若已有考试，需确认替换；失败或取消不会覆盖旧考试。
4. 扩展导入时，同时选中 `student-class*.json` 和同次 `verification-full*.json`。支持 BOM，单文件上限 16 MB；只接受完整全班得分，不接受三人样本。
5. 查看每题失分率、全错及部分得分人数、纳入补练人数；展开学生列表查看薄弱题号。没扫和无原卷不判对错，不参与每题分母。
6. “本场教师设置”可保存变式数、每人上限、难度和部分得分阈值。全错始终计入；部分得分只有选择“纳入”且得分率严格低于阈值时计入。题数和难度供后续出题、组卷使用。
7. 重开程序自动恢复当前考试。“清除当前考试”需确认，只清除应用存储，不删除扩展原始下载文件或智学网登录态。

## 编译

```powershell
cd app
npm ci
npm run desktop:build:debug
```

这是约 13 MB 的无开发服务器依赖 Windows 调试版，尚不是正式安装包。开发模式为 `npm run dev`，启动 127.0.0.1:1420 前端和 Tauri；正式优化编译为 `npm run desktop:build`，本次未运行正式发布编译。

依赖由 `package-lock.json`、`apps/desktop/src-tauri/Cargo.lock` 固定。Rust 关闭调试符号与增量编译，本次 `target` 约 1.62 GiB，C 盘剩余约 10.0 GiB。

## 代码与数据

- `packages/core/src/index.ts`：当前考试、学生、逐题结果、来源及教师设置模型；TS 导入审计、规范化、恢复校验和薄弱题统计。配对比较完整 summary，独立重算人数、题号、满分、分数、对错及汇总；拒绝失败、未处理完、重复标识、凭据和远程图片。
- `packages/zhixue/src/index.ts`：接口类型与提示信息。构建时直接复用根目录 `browser-probe/probe.mjs`，运行 `connect`、`subjects`、`export(fullClass=true)`。全班导出不包含作答原文、选项或答题卡图片。
- `apps/desktop/src-tauri/src/remote.rs`：内置窗口注入、轮询与清理，进度只有人数。普通读取超时 2 分钟，全班读取 30 分钟；进度不能证明成功，需保持智学网页面打开、不要中途跳转。
- `apps/desktop/src-tauri/src/storage.rs`：SQLite 单行当前考试，事务替换、修订号冲突检测与结构复核，启用 secure_delete 和 DELETE 日志模式。不跨考试累计，也没有历史表。清除应用数据不等同于擦除浏览器缓存、系统备份或磁盘所有残留。
- 当前考试保存在 `%LOCALAPPDATA%/com.local.mistake-agent/workspace.sqlite`，包含本场姓名和得分，属于本机应用数据，不放入项目目录。
- WebView2 登录资料保存在同一目录的 `zhixue-webview/`，可能保留登录态。密码由教师在官方页面输入，程序不导出密码、Cookie、令牌。
- 匿名诊断在同一目录的 `diagnostics/`：`tauri-login-verification.json` 记录连接状态；保存考试时写 `desktop-class-verification.json`，仅有计数与状态，不存名单、考试名或班级名。项目 `output/` 只存匿名证据。

## 窗口与网络边界

所有本机命令核对调用者必须为本地主界面。远程智学网窗口没有 Tauri IPC 权限。Windows 登录窗口使用独立资料目录和 `--no-proxy-server` 直连，不修改系统代理。首次沿用系统代理曾空白，独立直连后通过；空白页不能作为验证码或权限错误的结论。

顶层导航仅允许 HTTPS 智学网域名及官方登录页引用的 `open.changyan.com`，禁止新弹窗。导航检查不等于所有子资源网络白名单，完整出站限制仍待后续网络管控实现。本次通过不能保证以后不触发验证码；遇到 60500 可改用 Chrome 扩展导入。

当前只采集得分，不能提供错误选项分布或确定具体错因；选项统计需另补数据来源。试卷照片与题号也仍待关联。

## 验证

项目根目录执行：

```powershell
npm --prefix app test
npm --prefix app run build
cargo test --manifest-path app/apps/desktop/src-tauri/Cargo.toml --lib
.\.venv\Scripts\python.exe tests/check_desktop_ui.py
```

34 项 TS 核心测试、6 项 Rust 测试、11 组桌面模拟检查通过；原有 33 项扩展测试、13 项 Python 测试、4 组扩展界面检查均通过。合成测试与真实账号证据分开记录。

真实数据匿名核对（原始文件只读，会覆盖各自的匿名报告）：

```powershell
node tools/audit_desktop_import.mjs
node tools/audit_desktop_workspace.mjs
```

前者原地读取下载目录的全班扩展文件，与原 Python 基线比较；后者只读应用 SQLite，重跑 TS 恢复校验与分析并比较同一基线。这些基线工具针对本次 50 人、24 题的考试，换考试后不应继续套用旧基线。
