# 第三方源码

桌面 PDF 导出随包附带 Node.js 运行时，仅执行固定的本地导出桥与检查程序。运行时版本与二进制摘要记录在 `resources/workflow-runtime/runtime-manifest.json`，对应版本的完整 Node.js 及内含第三方许可保留在同目录 `NODE-LICENSE.txt`。PDF.js、XState、@napi-rs/canvas 及平台二进制沿用锁定 npm 依赖并保留发行包许可。未捆绑或分发系统中文字体。

`vendor/zhixuewang-python/` 包含 `anwenhu/zhixuewang-python` 的固定源码快照，供原有 Python 验证脚本及离线测试使用。

- 上游仓库：<https://github.com/anwenhu/zhixuewang-python>
- 固定提交：`b5e36428deb0a3ae5f4ac8da34bac2a40019ee25`
- 许可证：MIT，保留于 `vendor/zhixuewang-python/LICENSE`。

上游 Git 元数据、安装生成的 egg-info 和缓存不包含在源码快照中。桌面端的 Node 与 Rust 依赖分别由 `app/package-lock.json` 和 `app/apps/desktop/src-tauri/Cargo.lock` 固定，其许可信息以各依赖发行包为准。

PDF 文字提取使用 Mozilla PDF.js（`pdfjs-dist`，Apache-2.0）。worker、CMap 与标准字体来自锁定的 npm 包，在构建/开发前由 `app/apps/desktop/scripts/prepare-pdf.mjs` 复制到本地资源目录，同时保留该包 LICENSE。库的版本与依赖固定在 `app/package-lock.json`。

阶段 B 的本机 Node PDF 执行器复用 PDF.js 的 `@napi-rs/canvas` 1.0.13 可选依赖（MIT）进行工作线程内渲染；其版本及原生平台包由现有 npm lockfile 固定，许可证保留于依赖发行包。Windows 中文和数学字体从已验证系统字体读取并记录摘要，不将系统字体复制进项目或分发包。

阶段 C 的SQLite记录完整性复核使用Rust `sha2` 0.10.9（MIT OR Apache-2.0）；桌面原依赖树已有该固定版本，现声明为直接依赖，开发存储探针使用相同版本。许可随依赖发行包保留，摘要不替代账号权限控制或模型独立核验。

## XState

云端 Key 会话的 Rust 内存缓冲区清理使用 `zeroize` 1.9.1（MIT OR Apache-2.0），本项目按 MIT 许可使用。Copyright (c) 2018-2026 The RustCrypto Project Developers；完整许可保留在 `licenses/zeroize-MIT.txt`，版本固定于桌面 Cargo.lock。该库清理其管理的缓冲区，不代表 HTTP/TLS 或操作系统所有临时副本均可证明已擦除。

双模式工作流使用 npm `xstate` **5.33.3** 的状态机与 actor API，版本固定于 `app/package-lock.json`。项目业务流程自行实现，未复制外部 Anki 项目的代码或提示词。本次参考文档为 XState 官方状态持久化与 actor 文档。依赖的 MIT 许可证原文如下：

```text
The MIT License (MIT)

Copyright (c) 2015 David Khourshid

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Shadcn Dashboard

成绩分析中的 `ExamMetric` 布局改编自 [Shadcn Dashboard](https://github.com/towerneon/shadcndashboard-ui) 的 `src/components/dashboards/modern/totals-assets.tsx`，参考提交 `6f99c0b04b7169f9ef12dc99946bc4faaeb40b9b`。项目使用 MIT 许可证，原许可证如下：

```text
MIT License

Copyright (c) 2026 Shadcn Dashboard

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## XState

新工作流使用 `xstate` 5.33.3 核心依赖（版本及完整性固定于 `app/package-lock.json`），MIT 许可证，Copyright (c) 2015 David Khourshid。使用官方状态机/actor API，业务状态、守卫和预算代码自行实现，没有复制参考仓库示例。发行依赖时保留 npm 包中的 LICENSE。完整许可文本如下：

```text
The MIT License (MIT)

Copyright (c) 2015 David Khourshid

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
