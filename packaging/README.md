# Browser Bridge for Claude Code 使用说明

让 Claude Code 直接操作你本机的 Chrome，不需要登录任何账号。由两部分组成：

- `extension/`：Chrome 扩展，负责在浏览器里执行操作
- `mcp/browser-bridge-mcp.mjs`：本机 MCP 服务，负责和 Claude Code 通信

## 安装

需要先装好 [Node.js](https://nodejs.org) 18 或更高版本，以及 Claude Code。

**1. 注册 MCP 服务**

- macOS / Linux：在本目录运行 `./install.sh`
- Windows：双击 `install.cmd`

也可以手动执行（把路径换成本目录的实际位置）：

```bash
claude mcp add browser-bridge -s user -- node /本目录/mcp/browser-bridge-mcp.mjs
```

**2. 加载 Chrome 扩展**

打开 `chrome://extensions`，打开右上角的「开发者模式」，点「加载已解压的扩展程序」，选择本目录下的 `extension` 文件夹。

> 不要把 zip 安装包直接拖进 Chrome：包里除了扩展还有 MCP 服务和安装脚本，Chrome 会报「Could not unzip extension for install」。先解压，再选其中的 `extension` 文件夹。

**3. 重启 Claude Code**

点扩展图标，显示「已连接 MCP 服务」即可使用，直接对 Claude 说「打开 xxx 网站帮我……」。

> 安装后请不要移动或删除本目录：Chrome 和 Claude Code 都会从这里加载文件。

## 在其他 MCP 客户端中使用

`mcp/browser-bridge-mcp.mjs` 是标准的 stdio MCP 服务，任何支持本机 MCP 的客户端都能用：由客户端用 `node` 启动它即可，不需要单独运行。多个客户端（例如 Claude Code、Codex、Claude 桌面版）可以同时使用，每个客户端会话有自己的标签组，互不干扰。

**先确定两个绝对路径**

- 服务文件：本目录下的 `mcp/browser-bridge-mcp.mjs`，例如 `/Users/你的用户名/browser-bridge/mcp/browser-bridge-mcp.mjs`
- node：在终端运行 `which node`。桌面客户端不会继承终端里的 PATH，所以要写 node 的绝对路径。用 fnm、nvm 等版本管理工具时，`which node` 给出的可能是临时路径，请改用稳定路径，例如 fnm 的 `~/.local/share/fnm/aliases/default/bin/node`、nvm 的 `~/.nvm/versions/node/<版本>/bin/node`

下面示例中的 `/path/to/node` 和 `/path/to/browser-bridge-mcp.mjs` 请换成实际路径（JSON 里不能用 `~`）。

**Claude 桌面版**：编辑 `~/Library/Application Support/Claude/claude_desktop_config.json`（Windows 为 `%APPDATA%\Claude\claude_desktop_config.json`），在 `mcpServers` 中加入下面这项，然后重启 Claude 桌面版：

```json
{
  "mcpServers": {
    "browser-bridge": {
      "command": "/path/to/node",
      "args": ["/path/to/browser-bridge-mcp.mjs"]
    }
  }
}
```

**Cursor、Windsurf、Cline、Cherry Studio、Gemini CLI 等**：配置格式与上面相同（`mcpServers` → `command` + `args`），分别写在各自的 MCP 配置里，例如 Cursor 的 `~/.cursor/mcp.json`、Gemini CLI 的 `~/.gemini/settings.json`。

**Codex**：编辑 `~/.codex/config.toml`，加入后重启 Codex：

```toml
[mcp_servers.browser-bridge]
command = "/path/to/node"
args = ["/path/to/browser-bridge-mcp.mjs"]
```

**VS Code（Copilot）**：在 `.vscode/mcp.json` 或用户级 MCP 配置中加入：

```json
{
  "servers": {
    "browser-bridge": {
      "type": "stdio",
      "command": "/path/to/node",
      "args": ["/path/to/browser-bridge-mcp.mjs"]
    }
  }
}
```

**注意**

- 只支持远程 MCP（填一个网址）的客户端无法直接使用，本服务只能由本机客户端启动。
- 截图以图片形式返回，客户端需要支持 MCP 的图片结果，否则看不到截图（其他工具不受影响）。
- 文件上传和 GIF 保存默认只允许在下载、桌面、文稿、图片目录中（从命令行客户端启动时还包括当前项目目录）。需要其他目录时，在配置里加环境变量，例如 JSON 中写 `"env": { "BROWSER_BRIDGE_FILE_DIRS": "/Users/你/work:/Users/你/Downloads" }`。
- 标签组名是「客户端名 · 项目目录」，例如「Codex · api」；页面上的「停止」只拦下该标签页所属的客户端。

## AI 元素查找（可选）

点扩展图标里的「设置」，在「AI 元素查找」中填写 OpenAI 兼容接口：

- **接口地址**：如 `https://api.openai.com/v1`；只填域名时自动补 `/v1/chat/completions`
- **API Key**：只保存在本机浏览器中
- **模型**：接口支持的模型名

先点「测试连接」，再点「保存」。填写后，Claude 查找页面元素时可以用自然语言描述（如“提交订单的按钮”）；不填写则使用本地关键词匹配。启用后页面结构会发送到你填写的接口，密码等敏感字段已脱敏。

## 使用须知

- 每个 agent 只能操作自己标签组里的标签页。想让它操作已有页面，把标签页拖进它的组，或点扩展图标，选好 agent 后点「交出」。
- Claude 操作时页面四周会出现彩色渐变边框，底部的「停止」按钮可以随时叫停。
- 扩展界面跟随浏览器语言（中文 / 英文）。
- 操作时 Chrome 顶部会出现「正在调试此浏览器」提示条，空闲 20 秒后自动消失。
- Claude 使用的是你真实的登录状态，涉及付款、删除、发消息等操作时请留意。
- 上传和保存本机文件只允许在 Claude Code 的工作目录、下载、桌面、文稿、图片目录中，且不能是隐藏文件。

## 可选配置（环境变量）

在注册命令里用 `-e` 传入，例如 `claude mcp add browser-bridge -s user -e BROWSER_BRIDGE_PORT=18766 -- node …`：

| 变量 | 作用 |
| --- | --- |
| `BROWSER_BRIDGE_PORT` | 本机端口，默认 18765；修改后需在扩展弹窗里填相同端口 |
| `BROWSER_BRIDGE_FILE_DIRS` | 允许读写本机文件的目录，用系统路径分隔符分隔 |
| `BROWSER_BRIDGE_EXTENSION_IDS` | 允许连接的扩展 ID，逗号分隔（默认只接受本扩展） |

## 卸载

1. 执行 `claude mcp remove browser-bridge -s user`
2. 在 `chrome://extensions` 中移除 Browser Bridge
3. 删除本目录
