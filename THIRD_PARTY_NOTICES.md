# 第三方源码

`vendor/zhixuewang-python/` 包含 `anwenhu/zhixuewang-python` 的固定源码快照，供原有 Python 验证脚本及离线测试使用。

- 上游仓库：<https://github.com/anwenhu/zhixuewang-python>
- 固定提交：`b5e36428deb0a3ae5f4ac8da34bac2a40019ee25`
- 许可证：MIT，保留于 `vendor/zhixuewang-python/LICENSE`。

上游 Git 元数据、安装生成的 egg-info 和缓存不包含在源码快照中。桌面端的 Node 与 Rust 依赖分别由 `app/package-lock.json` 和 `app/apps/desktop/src-tauri/Cargo.lock` 固定，其许可信息以各依赖发行包为准。

PDF 文字提取使用 Mozilla PDF.js（`pdfjs-dist`，Apache-2.0）。worker、CMap 与标准字体来自锁定的 npm 包，在构建/开发前由 `app/apps/desktop/scripts/prepare-pdf.mjs` 复制到本地资源目录，同时保留该包 LICENSE。库的版本与依赖固定在 `app/package-lock.json`。
