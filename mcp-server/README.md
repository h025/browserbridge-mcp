# browserbridge-mcp

中文 | [English](https://github.com/h025/browserbridge-mcp/blob/main/README.en.md)

让 Claude Code 等 MCP 客户端直接操作你本机的 Chrome，**不需要登录任何账号**，使用你浏览器里现有的登录状态。

由两部分组成，都在这个包里：

- **MCP 服务**：由 MCP 客户端启动，通过 stdio 通信
- **Chrome 扩展**：在浏览器里执行操作，用 `browserbridge-mcp extension` 导出后在 Chrome 中加载

需要 Node.js 18 或更高版本。

## 快速开始

**1. 导出并加载 Chrome 扩展**

```bash
npx -y browserbridge-mcp extension
```

扩展会被复制到 `~/browser-bridge-extension`（也可以在命令后指定目录）。然后打开 `chrome://extensions`，打开右上角的「开发者模式」，点「加载已解压的扩展程序」，选择这个目录。之后不要删除该目录。

**2. 在 MCP 客户端中注册**

Claude Code：

```bash
claude mcp add browser-bridge -s user -- npx -y browserbridge-mcp
```

其他客户端（Claude 桌面版、Cursor、Windsurf、Cline、Gemini CLI 等）在 MCP 配置的 `mcpServers` 中加入：

```json
{
  "mcpServers": {
    "browser-bridge": {
      "command": "npx",
      "args": ["-y", "browserbridge-mcp"]
    }
  }
}
```

Codex（`~/.codex/config.toml`）：

```toml
[mcp_servers.browser-bridge]
command = "npx"
args = ["-y", "browserbridge-mcp"]
```

**3. 重启客户端**，点 Chrome 里的扩展图标，看到「已连接 MCP 服务」即可使用。

> 桌面客户端读不到终端里的 PATH。如果提示找不到 `npx` 或 `node`（常见于用 nvm、fnm 管理 Node 的情况），把 `command` 改成 npx 的绝对路径，并在配置里加上 `"env": { "PATH": "<node 所在目录>:/usr/bin:/bin" }`。可以在终端用 `which npx` 查看路径；版本管理工具给出的临时路径请换成稳定路径，例如 fnm 的 `~/.local/share/fnm/aliases/default/bin`。

## 升级

`npx -y browserbridge-mcp` 会使用最新版本；如需固定版本，写成 `browserbridge-mcp@0.7.0`。扩展需要重新导出：再运行一次 `npx -y browserbridge-mcp extension`，然后在 `chrome://extensions` 中点该扩展的刷新按钮。扩展和服务的版本不一致时，部分新工具可能不可用。

## 提供的工具

| 工具 | 作用 |
| --- | --- |
| `tabs_context_mcp` / `tabs_create_mcp` / `tabs_close_mcp` | 查看、新建、关闭可操作的标签页 |
| `navigate` | 打开网址、后退、前进 |
| `computer` | 截图、点击、输入、按键、滚动、拖拽、放大 |
| `read_page` / `find` / `get_page_text` | 读取页面结构、查找元素、提取正文 |
| `form_input` / `file_upload` / `upload_image` | 填写表单、上传文件或截图 |
| `javascript_tool` | 在页面中执行 JavaScript |
| `read_console_messages` / `read_network_requests` | 控制台日志、网络请求 |
| `resize_window` / `gif_creator` / `browser_batch` | 调整窗口、录制 GIF、批量执行 |

## 安全

- Claude 只能操作「Browser Bridge」标签组里的标签页；页面底部有「停止」按钮可随时叫停。
- 服务只监听 `127.0.0.1`，只接受本扩展的连接。
- 上传和保存本机文件只允许在下载、桌面、文稿、图片目录（以及命令行客户端的项目目录）中，且不能是隐藏文件。

## 可选配置（环境变量）

| 变量 | 作用 |
| --- | --- |
| `BROWSER_BRIDGE_PORT` | 本机端口，默认 18765；修改后需在扩展弹窗里填相同端口 |
| `BROWSER_BRIDGE_FILE_DIRS` | 允许读写本机文件的目录，用系统路径分隔符分隔 |
| `BROWSER_BRIDGE_EXTENSION_IDS` | 允许连接的扩展 ID，逗号分隔 |

扩展的「设置」里还可以填写 OpenAI 兼容接口，让查找元素支持自然语言描述，以及开关「模拟真人打字节奏」。

扩展界面跟随浏览器语言（中文 / 英文），命令行提示跟随系统语言。

## 许可

MIT

源码：https://github.com/h025/browserbridge-mcp
