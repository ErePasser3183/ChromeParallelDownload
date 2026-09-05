# Chrome Parallel Download

一个面向 Windows 的 Chrome 多线程下载扩展。点击网页下载后，扩展暂停 Chrome 原任务，并交给本机 aria2 引擎进行分段并发下载。

> 本项目参考了 Plain Craft Launcher 2 的多线程下载体验，采用独立实现和 aria2 引擎；它不是 PCL 官方项目，也没有复制 PCL 工具箱未公开的源码。

## 功能

- 自动接管普通 HTTP/HTTPS GET 文件下载
- 每个文件可选 4、8、16、32 或 64 路连接
- 显示速度、进度和实际连接数
- 支持暂停、继续、取消和切回 Chrome
- 下载完成后自动清理扩展中的任务记录
- 同名文件自动编号，不覆盖已有文件
- 接管失败时尽量恢复 Chrome 原下载
- 不上传下载地址、下载记录或浏览数据

## 系统要求

- Windows 10 或 Windows 11
- Google Chrome
- Python 3
- 首次安装时可以连接 GitHub，用于下载 aria2 1.37.0 官方发布文件

## 安装

1. 下载仓库并解压到一个长期保留的目录，例如 `D:\Tools\ChromeParallelDownload`。安装后不要删除或移动它。
2. 双击 `install.cmd`。脚本会下载并校验 aria2、生成本机随机 RPC 密钥，并为当前 Windows 用户注册 Native Messaging Host。
3. 在 Chrome 地址栏输入 `chrome://extensions/`。
4. 开启“开发者模式”，点击“加载已解压的扩展程序”。
5. 选择项目中的 `extension` 文件夹。
6. 打开扩展面板，看到“aria2 1.37.0 · 已连接”即安装成功。

默认下载目录是 `D:\Downloads`；没有 D 盘时使用当前用户的 `Downloads`。也可以在 PowerShell 中指定：

```powershell
& .\install.ps1 -DownloadDir 'E:\Downloads'
```

## 使用说明

网页下载被接管后，Chrome 原任务会显示“暂停”，这是作为失败回退保留的备份任务。请在扩展面板查看多线程进度；如果在 Chrome 原任务中点击“继续”，下载会切回 Chrome。

连接数越高不一定越快。建议从 8 或 16 路开始；只有服务器限制单连接速度时，32/64 路才可能继续提升速度。某些服务器会限制或拒绝过多连接。

以下任务保留给 Chrome：

- 小于 2 MiB 的文件
- 带 Cookie、Authorization 或代理认证的请求
- POST、`blob:`、`data:` 等网页生成下载
- 无痕窗口下载
- Chrome 标记为风险的下载
- 其他扩展发起的下载

## 工作方式

```text
网页下载
   │
   ├─ 不符合接管条件 ──────────────> Chrome 下载
   │
   └─ 符合条件
        │
        ├─ Chrome 原任务暂停（回退用）
        └─ Native Messaging → Python 桥接 → aria2 分段下载
                                      │
                         成功 ────────┴──────── 失败
                          │                       │
                    文件移入下载目录        尝试恢复 Chrome
```

Chrome 与本机程序通过官方 Native Messaging 机制通信。aria2 RPC 只监听回环地址，并使用每台电脑首次安装时生成的随机密钥。

## 卸载

1. 在 Chrome 扩展页移除本扩展。
2. 运行：

```powershell
& .\uninstall.ps1
```

卸载脚本会停止本项目的下载引擎并注销本机桥接，不删除已下载文件。

## 开发与测试

扩展使用 Manifest V3，无构建步骤。修改 `extension` 中的文件后，在 `chrome://extensions/` 刷新扩展。

```powershell
node --check extension/background.js
node --check extension/popup.js
node tests/test_extension.cjs
python -m py_compile native/host.py
python tests/test_history_cleanup.py
```

要验证完整安装流程但不修改注册表，可运行：

```powershell
& .\install.ps1 -DownloadDir "$env:TEMP\ChromeParallelDownload-Test" -SkipRegistration
```

`native/build_local64.py` 基于哈希固定的 aria2 1.37.0 官方 Windows x64 文件生成 64 路变体。它校验原文件 SHA-256 与目标机器指令，只修改一个数值常量。等价源码补丁见 `native/local64-source.patch`。

## 隐私与权限

扩展需要 `downloads`、`nativeMessaging`、`storage`、`alarms` 和 `webRequest` 权限。`webRequest` 只用于识别下载请求类型并读取 User-Agent/Referer；检测到 Cookie 或认证头时不会接管。项目不包含遥测、广告或远程控制服务。

## 致谢与许可证

- 下载引擎：[aria2 1.37.0](https://github.com/aria2/aria2/tree/release-1.37.0)，GPL-2.0-or-later；详见 [第三方组件说明](THIRD_PARTY_NOTICES.md)。
- 体验参考：[Plain Craft Launcher 2](https://github.com/Meloong-Git/PCL) 的公开下载模块。

本项目自身代码使用 [MIT License](LICENSE)。aria2 及其本地变体遵循 aria2 自身许可证。
