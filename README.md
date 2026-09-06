# 多线程下载

当前版本 2.1.1：恢复 1.x 的 aria2 下载机制和默认速度显示，保留新版面板、点击即时反馈、横排按钮和 8 秒圆环倒计时。支持 4/8/16/32/64 路、暂停继续、失败回退和临时文件清理。

## 安装与切换

1. 完成或取消旧扩展的下载，关闭旧扩展的自动接管。
2. 在 Windows 安装 Python 3，运行本仓库的 `install.cmd`。
3. 在 `chrome://extensions/` 开启开发者模式，加载仓库的 `extension` 文件夹。
4. 面板显示“aria2 1.37.0 · 已连接”后，在设置中确认保存目录，并刷新下载网页。

本版使用固定扩展 ID，与 2.0.x 的路径 ID 不同。请关闭或移除旧 2.0.x 扩展，避免重复接管。原有下载分片不能跨引擎迁移。目录搬动后需重新运行安装脚本。

## 工程结构

- `extension/`：Chrome 扩展源码，浏览器加载这里。
- `native/`：1.x Python 桥接与 aria2 引擎工具；配置和二进制不提交 Git。
- `tests/`、`scripts/`、`docs/`：测试、打包与使用文档。
- `legacy/native-1.x/`、`legacy/browser-2.x/`：历史原生版与纯浏览器版备份。
- `dist/`、`work/`：发布产物与本地测试数据，不提交 Git。

## 开发

```sh
npm run check
npm test
npm run package
```

打包生成 `dist/ChromeParallelDownload-2.1.0.zip`，包含扩展、桥接源码、安装脚本和许可证。解压后运行安装脚本，再加载其中的 extension。不会打包本机密钥或任务记录。

Python 回归测试位于 tests/test_*.py。真实浏览器测试需要 Playwright、Chrome for Testing，以及已注册的本机桥接；执行 `npm run test:browser`。测试使用隔离的下载目录、RPC 端口和浏览器配置。

详见 [使用说明](docs/USAGE.md) 与 [第三方组件说明](THIRD_PARTY_NOTICES.md)。本项目代码采用 [MIT License](LICENSE)，aria2 遵循其自身许可证。
