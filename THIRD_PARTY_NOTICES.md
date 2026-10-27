# 第三方源码

`vendor/zhixuewang-python/` 包含 `anwenhu/zhixuewang-python` 的固定源码快照，供原有 Python 验证脚本及离线测试使用。

- 上游仓库：<https://github.com/anwenhu/zhixuewang-python>
- 固定提交：`b5e36428deb0a3ae5f4ac8da34bac2a40019ee25`
- 许可证：MIT，保留于 `vendor/zhixuewang-python/LICENSE`。

上游 Git 元数据、安装生成的 egg-info 和缓存不包含在源码快照中。桌面端的 Node 与 Rust 依赖分别由 `app/package-lock.json` 和 `app/apps/desktop/src-tauri/Cargo.lock` 固定，其许可信息以各依赖发行包为准。

PDF 文字提取使用 Mozilla PDF.js（`pdfjs-dist`，Apache-2.0）。worker、CMap 与标准字体来自锁定的 npm 包，在构建/开发前由 `app/apps/desktop/scripts/prepare-pdf.mjs` 复制到本地资源目录，同时保留该包 LICENSE。库的版本与依赖固定在 `app/package-lock.json`。

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
