# 阶段 B：双模式 PDF 离线交付

`plan.ts` 是不依赖文件系统的 TypeScript 文档计划与 Typst 模板；`tools/workflow-pdf-engine.mjs` 是本机 Node 参考执行器，`tools/workflow-pdf-worker.mjs` 使用项目锁定的 PDF.js 与其本地 `@napi-rs/canvas` 依赖，在独立工作线程中逐页检查和渲染。现有旧版人工审核 PDF 导出保持原接口。

这是阶段 B 的可运行离线链路。普通用户桌面入口、SQLite 工作流任务恢复与正式计次分别继续按阶段 C/F 接入。执行器不访问账号服务或模型，PDF 通过也不会触发结算。

## 运行

在项目根目录执行，沿用现有 Node 与本地 Typst 资源：

```powershell
npm --prefix app ci
npm --prefix app run prepare:runtime
npm --prefix app run workflow:pdf-demo
npm --prefix app run test:workflow-pdf
```

演示运行听写/出题 × 个人/合订四组路径，所有页面有不可分发的合成数据页眉，结果索引在 `output/pdf/workflow-phase-b/matrix.json`。增加 `--stress` 可验证长材料、上下标、希腊字母、分式、四种题型与跨页教师报告：

```powershell
node tools/run_workflow_pdf_demo.mjs --stress
node tools/run_workflow_pdf_demo.mjs --retry "本次失败返回的staging完整路径"
```

Windows 版本使用已验证系统字体 Microsoft YaHei、Cambria Math 与 Typst 内置数学字体；记录编译器版本/摘要、系统字体文件摘要及实际 PDF 所用字体，不复制或分发系统字体。Python、PyMuPDF 和 Poppler 只用于开发时的独立金样复核，不是执行器的运行前提。

## 数据与校验

`buildDocumentPlan(input, run, profile, options)` 先复核冻结输入和导出摘要、事实/题目结构、自检通过状态，再重新计算个人目标、分配、全班统计及教师建议引用。局部测试、未完成内容、审核不通过及无独立整场教师报告均拒绝；模拟批次只能使用 `syntheticPreview:true`，永久显示演示标记。

计划列出每个文档的角色、ownerId、语义块 ID、练习/答案分区、题目 ID 和空号。没有错题、没扫和无原卷均保留各自学生的状态页。答案由同一题目/空位对象生成；不附答案时只移除答案页，原始结构化答案留在本机导出缓存。来源默认显示原题号、资料 ID 与页码；可通过 `sourceNames` 提供本地资料文件名映射，文件名只参与排版，不发送模型。

个人模式每人一份；合订模式逐人新页并带 PDF 书签。教师报告始终独立，包含全班成绩分布图、逐题正确率与分母、部分得分/全错人数、知识映射、讲评依据、分组巩固与局限。长表重复表头；材料和长知识句有续题说明；短题干与选项整体排版。正文 11pt，页眉页脚不低于 10.5pt；内联公式额外保留真实垂直空间。

Typst 只接收受控模板及字符串/有限公式，不执行模型提供的代码。模板通过实际布局查询返回每块的页码和边界。PDF.js 独立读取生成文件，检查 A4、正文边界、字体/缺字、内容存在与匹配、公式字符、非叠放块重叠、学生边界、答案分区和非预期空白页；所有页面以 144dpi 光栅化，检查非空渲染与语义块绘制。工作线程禁用网络 fetch，字体与 CMap 从本地读取。

## 文件事务与恢复

输出根目录的 `.workflow-work/<exportId>/` 为本机私有导出缓存，保存冻结输入/结构化答案、源文件、检查点、各轮 QA 与可选金样 PNG。仅分发最终 `report-<exportId>/` 中的 PDF；最终报告目录不包含原始输入或 Typst 源。

最终目录包含所选 PDF、`manifest.json`、`document-plan.json`、`qa-report.json` 与 `student-boundaries.json`。QA 报告记录五层检查、编译器/字体证据、每文件摘要、每页渲染摘要与检查结论。所有必需文件通过后，才在同一目标磁盘复制并核对哈希，再以新目录重命名提交；不覆盖旧输出。

可解析的布局问题最多重排两轮：先移动完整题组、教师表格另起页，再缩短长文本块，始终不缩小字号或重写题目答案。损坏 PDF、编译/IO 异常与取消立即保留失败检查点。再次调用 `retryWorkflowPdf(stagingDir)` 会复用摘要相同且已通过的文件，重新检查所有页面，只重做失败部分；不调用模型。目标临时复制中断也可从同一目录恢复。

安全上限为整批 1200 页/300MB、单页 400 万像素，逐页串行释放画布；时间预算按估算页数增长，最多一小时。它们是资源限制，不能解读为所有规模均已做性能验收。更换组织方式或答案页设置创建新导出配置，内容摘要不变，无新增模型调用。

## 验收范围

规则、字形、公式字符和光栅检查不能证明全部视觉细节或科学事实绝对正确。模板发布前须对四条路径、长材料/公式/续表/状态页金样逐页看图并记录批准版本；业务运行不要求教师中途审核。

`tools/check_workflow_pdf_layout.py --matrix <matrix.json>` 使用独立 Poppler 渲染器渲染全部金样页面，核对摘要、A4、嵌入字体、文字边界并输出带标签的逐页联系表，供开发看图验收。实际失败注入测试覆盖损坏文件、重复空白页、教师报告 IO 失败、取消、复制中断及幂等重试。

2026-10-28：`workflow-pdf-v1` 已完成开发视觉验收，31份PDF/96页全部以独立渲染器复核并看图；字体、编译器和模板源码指纹见 `tests/fixtures/workflow-pdf-golden-approval.json`。22项专项检查通过（含8项纯业务测试与14项实际文件集成测试）。这些记录使用合成数据，不构成真实整班、收费或科学内容质量验收。
