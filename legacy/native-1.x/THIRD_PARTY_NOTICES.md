# 第三方组件与源码

本项目在安装时下载 aria2 1.37.0 Windows x64 官方发布文件：

- 官方发布：<https://github.com/aria2/aria2/releases/tag/release-1.37.0>
- 完整对应源代码：<https://github.com/aria2/aria2/tree/release-1.37.0>
- aria2 许可证：[licenses/ARIA2-COPYING](licenses/ARIA2-COPYING)
- OpenSSL 相关许可证：[licenses/LICENSE.OpenSSL](licenses/LICENSE.OpenSSL)

安装脚本会验证官方 `aria2c.exe` 的 SHA-256：

```text
BE2099C214F63A3CB4954B09A0BECD6E2E34660B886D4C898D260FEBFE9D70C2
```

`native/aria2c-local64.exe` 在用户电脑安装时生成，不保存在本仓库。相对于官方文件，它仅把 `max-connection-per-server` 的可选上限从 16 改为 64。对应源码改动见 [native/local64-source.patch](native/local64-source.patch)，可重现生成脚本见 [native/build_local64.py](native/build_local64.py)。

该衍生文件遵循 aria2 的 GPL-2.0-or-later 许可证。使用者可以从上述标签取得完整对应源代码，并应用仓库提供的补丁重建。
