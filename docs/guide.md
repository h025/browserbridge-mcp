# Browser Bridge 使用指南

Browser Bridge 让 Claude Code、Codex、Cursor、Claude 桌面版等 MCP 客户端直接操作你本机的 Chrome：打开网页、点击、输入、截图、读取页面内容、上传文件、录制 GIF……全程使用你浏览器里现有的登录状态，**不需要登录任何账号**，也不经过任何云端服务。

目录

- [一、工作原理](#一工作原理)
- [二、准备](#二准备)
- [三、安装](#三安装)
- [四、在各客户端中配置](#四在各客户端中配置)
- [五、日常使用](#五日常使用)
- [六、多个 agent 同时使用](#六多个-agent-同时使用)
- [七、工具一览](#七工具一览)
- [八、设置](#八设置)
- [九、文件上传、截图与 GIF](#九文件上传截图与-gif)
- [十、安全与隐私](#十安全与隐私)
- [十一、升级与卸载](#十一升级与卸载)
- [十二、常见问题](#十二常见问题)

---

## 一、工作原理

```
MCP 客户端 ──stdio──> MCP 服务（Node，本机） ──WebSocket 127.0.0.1:18765──> Chrome 扩展 ──> 网页
```

由两部分组成：

| 组成 | 作用 | 谁来启动 |
| --- | --- | --- |
| **MCP 服务** | 和 MCP 客户端通信，把工具调用转给扩展 | MCP 客户端自动启动，不需要手动运行 |
| **Chrome 扩展** | 在浏览器里真正执行操作 | 加载到 Chrome 后一直在后台运行 |

- 每个客户端会话会启动一个 MCP 服务进程。第一个进程负责和扩展通信，后来的进程经它转发；它退出后由其他进程自动接替。
- 扩展只连接本机 `127.0.0.1`，网页无法连接这个端口。

## 二、准备

- **Chrome** 116 或更高版本（Edge、Brave 等 Chromium 浏览器一般也可以，未专门测试）
- **Node.js** 18 或更高版本：终端运行 `node -v` 查看
- 至少一个支持本机（stdio）MCP 的客户端，例如 Claude Code、Codex、Cursor、Claude 桌面版

## 三、安装

三种方式任选一种。推荐用 npm，升级最方便。

### 方式一：npm（推荐）

**1. 导出 Chrome 扩展**

```bash
npx -y browserbridge-mcp extension
```

扩展会被复制到 `~/browser-bridge-extension`。想放到别处，在命令后加目录，例如 `npx -y browserbridge-mcp extension ~/tools/bb-extension`。

**2. 在 Chrome 中加载扩展**

1. 打开 `chrome://extensions`
2. 打开右上角的「开发者模式」
3. 点「加载已解压的扩展程序」，选择上一步的目录

> 加载后不要删除或移动这个目录，Chrome 每次都从这里加载扩展。

**3. 在客户端中注册 MCP 服务**

Claude Code：

```bash
claude mcp add browser-bridge -s user -- npx -y browserbridge-mcp
```

其他客户端见[第四节](#四在各客户端中配置)。

**4. 重启客户端**，然后点 Chrome 工具栏里的 Browser Bridge 图标，看到「已连接 MCP 服务」就装好了。

### 方式二：Release 安装包

1. 在 [Releases](https://github.com/h025/browserbridge-mcp/releases) 下载最新的 `browser-bridge-<版本>.zip` 并解压到一个固定位置，例如 `~/browser-bridge`
2. 注册 MCP 服务：macOS / Linux 在解压目录运行 `./install.sh`；Windows 双击 `install.cmd`。脚本会检查 Node.js 版本，并执行 `claude mcp add` 把服务注册到 Claude Code
3. 在 Chrome 中加载解压目录里的 `extension` 文件夹（步骤同方式一的第 2 步）
4. 重启 Claude Code

> 不要把 zip 直接拖进 Chrome：包里除了扩展还有 MCP 服务和脚本，Chrome 会报「无法解压缩扩展程序」。先解压，再选其中的 `extension` 文件夹。

安装包里的 MCP 服务是单个文件 `mcp/browser-bridge-mcp.mjs`，只需要 Node.js，不需要 `npm install`。其他客户端可以直接用 `node` 启动它，见第四节。

### 方式三：从源码运行

```bash
git clone https://github.com/h025/browserbridge-mcp.git
cd browserbridge-mcp/mcp-server && npm install
claude mcp add browser-bridge -s user -- node "$(pwd)/src/cli.js"
```

然后在 Chrome 中加载仓库里的 `extension/` 目录。

### 验证安装

1. 点 Chrome 工具栏里的 Browser Bridge 图标，状态应为绿色的「已连接 MCP 服务」
2. 在客户端里说：「用浏览器打开 example.com 并截个图」
3. Chrome 会新开一个窗口，里面有一个带颜色的标签组，页面四周出现彩色边框，客户端里能看到截图

## 四、在各客户端中配置

MCP 服务是标准的 stdio 服务，下面两种启动方式任选：

- **npm 方式**：命令 `npx`，参数 `-y browserbridge-mcp`
- **安装包方式**：命令 `node`，参数是 `browser-bridge-mcp.mjs` 的绝对路径

> **桌面客户端找不到 node / npx？** 桌面应用不会读取终端里的 PATH。用 nvm、fnm 等版本管理工具时尤其常见。解决办法：`command` 写绝对路径（终端运行 `which npx` 或 `which node` 查看），并在配置里加上 `"env": { "PATH": "<node 所在目录>:/usr/bin:/bin" }`。版本管理工具给出的临时路径请换成稳定路径，例如 fnm 的 `~/.local/share/fnm/aliases/default/bin`、nvm 的 `~/.nvm/versions/node/<版本>/bin`。JSON 里不能用 `~`，要写完整路径。

### Claude Code

```bash
claude mcp add browser-bridge -s user -- npx -y browserbridge-mcp
```

`-s user` 表示所有项目都能用。查看状态：`claude mcp list`；在会话里输入 `/mcp` 可以查看或重连。

### Claude 桌面版

编辑 `~/Library/Application Support/Claude/claude_desktop_config.json`（Windows：`%APPDATA%\Claude\claude_desktop_config.json`），然后重启 Claude 桌面版：

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

### Codex

编辑 `~/.codex/config.toml`，然后重启 Codex：

```toml
[mcp_servers.browser-bridge]
command = "npx"
args = ["-y", "browserbridge-mcp"]
```

### Cursor、Windsurf、Cline、Cherry Studio、Gemini CLI 等

格式与 Claude 桌面版相同（`mcpServers` → `command` + `args`），写在各自的 MCP 配置里，例如：

| 客户端 | 配置文件 |
| --- | --- |
| Cursor | `~/.cursor/mcp.json` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |
| Gemini CLI | `~/.gemini/settings.json` |
| Cline、Cherry Studio | 在应用的 MCP 设置界面里添加 |

### VS Code（Copilot）

在 `.vscode/mcp.json` 或用户级 MCP 配置中加入：

```json
{
  "servers": {
    "browser-bridge": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "browserbridge-mcp"]
    }
  }
}
```

### 注意

- 只支持远程 MCP（填一个网址）的客户端无法使用，本服务只能由本机客户端启动。
- 截图以图片返回，客户端需要支持 MCP 图片结果才能看到截图，其他工具不受影响。

## 五、日常使用

### 直接用自然语言下达任务

不需要记工具名，像平时一样描述任务即可。例如：

- 「打开 https://news.ycombinator.com，把首页前 10 条标题和链接整理成表格」
- 「在我已经登录的后台里，把订单 12345 的状态改成已发货，改之前先截图给我确认」
- 「打开 xxx 页面，看看控制台有没有报错，再看一下哪些接口返回了 500」
- 「填写这个报名表单：姓名张三，电话 138……，提交前先让我看一下」
- 「录一个 GIF：打开 xxx，搜索 yyy，点开第一个结果，导出到下载目录」

### 第一次使用：新窗口和标签组

agent 第一次操作浏览器时会**新开一个窗口**，里面有一个属于它的标签组，与你自己的窗口分开。组名是「客户端名 · 项目目录」，例如「Claude Code · my-app」。agent 只能操作自己组里的标签页，不会动你的其他标签页。

### 让 agent 操作你已经打开的页面

两种方法：

- **拖进去**：把标签页拖进该 agent 的标签组
- **用弹窗交出**：切到这个标签页，点 Browser Bridge 图标，在「把当前标签页交给」里选好 agent，点「交出」

如果 agent 还没有标签组，「交出」会用这个标签页为它新建一个组。

### 操作时页面上的提示

| 提示 | 含义 |
| --- | --- |
| 页面四周的彩色渐变边框和光晕 | agent 正在操作这个标签页 |
| 彩色光标 | 显示 agent 点击、移动的位置 |
| 页面底部的「停止」按钮 | 随时叫停这个 agent |
| 标签组标题前的 ⌛ / ✅ | 执行中 / 已完成 |
| Chrome 顶部「已开始调试此浏览器」提示条 | Chrome 的安全提示，扩展通过调试接口操作页面时必然出现；空闲 20 秒后自动消失 |

截图时这些提示会自动隐藏，不会出现在截图里。

### 停止 agent

- **页面上的「停止」按钮**：点击后，这个标签页所属 agent 的下一次调用会被拒绝，并要求它停下来问你接下来怎么做。只影响这一个 agent，2 分钟内有效，只生效一次。
- **客户端里取消**：例如在 Claude Code 里按 Esc。正在执行的批量操作会停在当前步骤。

### 网页弹出的对话框

agent 操作期间页面弹出的 `alert` 会自动确认，`confirm` / `prompt` 会自动取消（否则页面会卡住），结果里会告诉 agent。agent 空闲时出现的对话框留给你处理；下次 agent 操作该标签页时如果还没关，才会自动处理。

离开有未保存内容的页面时（「离开此网站？」），默认不离开并告诉 agent；agent 明确要放弃修改时才会强制离开。

## 六、多个 agent 同时使用

可以同时开多个 Claude Code 会话，或者 Claude Code、Codex、Cursor 一起用，它们互不干扰：

- **各用各的标签组**：每个 agent 只能看到和操作自己组里的标签页，操作别人的标签页会报错。
- **组名和颜色**：组名为「客户端名 · 项目目录」，重名时加序号，例如「Claude Code · my-app 2」；每个组颜色不同。桌面客户端没有项目目录，只显示客户端名。
- **停止只影响一个**：页面上的「停止」只拦下这个标签页所属的 agent。
- **退出后组保留**：agent 退出（关闭会话）后，它的标签组和标签页都保留，不会被关掉。
- **重启后接回原来的组**：同一个客户端在同一个目录重新启动时（例如 Claude Code 里用 `/mcp` 重连），会接回原来的标签组，之前的标签页编号仍然有效。
- **从旧版本升级**：0.7.0 之前所有 agent 共用一个名为「Browser Bridge」或「Claude Bridge」的组，升级后由第一个需要标签组的 agent 接手。

## 七、工具一览

agent 会自己选择工具，一般不需要你指定。了解这些有助于描述任务：

| 工具 | 作用 | 要点 |
| --- | --- | --- |
| `tabs_context_mcp` | 查看自己组里的标签页 | 没有组时可以新开窗口建组 |
| `tabs_create_mcp` / `tabs_close_mcp` | 在组里新建 / 关闭标签页 | 新标签页在后台打开 |
| `navigate` | 打开网址、后退、前进 | 遇到「离开此网站？」默认不离开 |
| `computer` | 截图、点击、双击、右键、悬停、拖拽、输入、按键、滚动、放大局部、等待 | 可以按坐标，也可以按元素编号（ref）操作 |
| `read_page` | 读取页面结构，每个元素带编号 | `filter: "interactive"` 只看可交互元素 |
| `find` | 按描述查找元素 | 默认关键词匹配，配置 AI 后支持自然语言 |
| `form_input` | 直接设置输入框、下拉框、复选框、单选框、日期、滑块的值 | |
| `get_page_text` | 提取页面正文 | 优先取 article / main |
| `javascript_tool` | 在页面里执行 JavaScript | 支持顶层 await，30 秒超时 |
| `read_console_messages` | 读取控制台日志 | 第一次调用时开始记录 |
| `read_network_requests` | 读取网络请求 | 第一次调用时开始记录 |
| `resize_window` | 调整窗口大小 | |
| `file_upload` | 把本机文件放进网页的文件选择框 | 见第九节 |
| `upload_image` | 把之前的截图上传到网页，或拖放到页面某处 | |
| `gif_creator` | 录制操作并导出 GIF | 见第九节 |
| `browser_batch` | 一次执行多个操作 | 出错即停，速度更快 |

其他行为：

- **后台标签页**也能截图、点击、输入，不需要切到前台。
- **输入**：逐字发送真实按键，中文、emoji 等直接插入；默认模拟真人打字节奏（可在设置里关闭）。macOS 上 `cmd+a` / `cmd+c` / `cmd+v` 等组合键可正常使用。
- **点击打开了新标签页**时，新标签页会自动加入 agent 的组。
- **按元素点击时元素被遮挡**（弹窗、横幅等），结果里会提示。
- **操作前校验域名**：点击、输入、上传、执行脚本前，如果页面已经跳到别的网站，会拒绝执行。
- **背景声音**：后台标签页可能被唤醒播放音视频，扩展会先把它静音，你切到该标签页后恢复。

## 八、设置

### 扩展弹窗

点 Chrome 工具栏里的 Browser Bridge 图标：

| 项目 | 说明 |
| --- | --- |
| 连接状态 | 绿色「已连接 MCP 服务」/ 黄色「正在连接」/ 红色「未连接」，后面是端口 |
| MCP 服务端口 | 默认 18765；改了服务端口时这里要填一样的，点「保存」 |
| 重连 | 立即重新连接（扩展本身每 30 秒自动重连） |
| 把当前标签页交给 | 选择 agent，点「交出」 |
| 元素查找 | 显示 `find` 当前用关键词还是 AI；「设置」打开设置页 |

### 设置页

点弹窗里的「设置」，或在 `chrome://extensions` 中点扩展的「详情」→「扩展程序选项」。

**AI 元素查找（可选）**

默认情况下 `find` 用本地关键词匹配。填写一个 OpenAI 兼容接口后，可以用自然语言描述要找的元素，例如「提交订单的按钮」「拖放文件的区域」。

| 项目 | 说明 |
| --- | --- |
| 接口地址 | 例如 `https://api.openai.com/v1`；只填域名时自动补 `/v1/chat/completions`，也可以填完整地址 |
| API Key | 只保存在本机浏览器中；本机模型（如 Ollama）可以留空 |
| 模型 | 接口支持的模型名，例如 `gpt-4o-mini` |

先点「测试连接」确认能用，再点「保存」。「清除配置」恢复关键词匹配。

- 启用后，`find` 会把页面结构（密码、验证码、信用卡等字段已脱敏）和查询发送到你填写的接口。
- 接口没填、调用失败或 60 秒超时时，自动退回关键词匹配，并在结果里说明原因。
- 模型编造的、页面上不存在的元素会被过滤掉。

**输入：模拟真人打字节奏**

默认开启：逐字输入，字符之间随机间隔几十毫秒，长文本会自动加快（一次输入约 12 秒内完成）。有些网站会把瞬间打完的输入当成机器人并弹出验证码，开着更稳妥；关闭后输入更快。

### 界面语言

扩展的弹窗、设置页、页面上的「停止」按钮和 GIF 上的动作标签跟随浏览器的界面语言，目前支持中文和英文（其他语言显示英文）。命令行 `browserbridge-mcp` 的提示和「扩展未连接」等提示跟随系统语言。

### 环境变量

在 MCP 配置里设置。Claude Code 用 `-e` 传入，例如：

```bash
claude mcp add browser-bridge -s user -e BROWSER_BRIDGE_PORT=18766 -- npx -y browserbridge-mcp
```

JSON 配置里写在 `"env": { ... }` 中。

| 变量 | 作用 |
| --- | --- |
| `BROWSER_BRIDGE_PORT` | 本机端口，默认 18765。修改后要在扩展弹窗里填相同端口 |
| `BROWSER_BRIDGE_FILE_DIRS` | 允许上传、保存本机文件的目录，用系统路径分隔符分隔（macOS / Linux 是 `:`，Windows 是 `;`），会替换默认目录 |
| `BROWSER_BRIDGE_EXTENSION_IDS` | 允许连接的扩展 ID，逗号分隔。默认只接受本扩展，自己改了扩展再打包时才需要 |

> 同一台电脑上的所有客户端要用同一个端口，它们才能共用一个扩展。

## 九、文件上传、截图与 GIF

### 上传本机文件（`file_upload`）

agent 给出本机文件路径，由 MCP 服务读取后放进网页的文件选择框。为防止网页诱导 agent 把敏感文件传出去，有以下限制：

- 文件必须在这些目录里：客户端的项目目录（从命令行客户端启动时）、`~/Downloads`、`~/Desktop`、`~/Documents`、`~/Pictures`
- 不能是隐藏文件，也不能在隐藏目录里（例如 `~/.ssh`、`.env`）
- 一次最多 10 MB

需要其他目录时，用环境变量 `BROWSER_BRIDGE_FILE_DIRS` 指定。

### 截图

- 截图会缩放到适合模型查看的大小（长边不超过 1568 像素），agent 给出的坐标始终按截图换算，不受缩放影响。
- 每张截图有一个编号，5 分钟内可以用 `upload_image` 把它上传到网页，或拖放到页面上（例如把截图贴进在线文档）。

### 录制 GIF（`gif_creator`）

1. 让 agent「开始录制」，之后它的每次点击、输入、跳转都会记一帧（最多 50 帧）
2. 操作完成后让它「停止录制并导出」
3. 导出方式二选一：
   - **保存到本机**：默认保存到 `~/Downloads`，也可以指定文件名或路径（同样受允许目录的限制）
   - **拖放到页面**：直接拖到网页的某个位置，例如上传区域

GIF 上会标出点击位置、拖拽路径、动作说明和进度条，这些都可以关掉。

## 十、安全与隐私

- **只在本机通信**：MCP 服务只监听 `127.0.0.1`，并校验来源，普通网页无法连接；只接受本扩展的连接，其他扩展无法冒充。本机的其他程序仍然可以连接，请只在可信的电脑上使用。
- **使用你真实的登录状态**：涉及付款、删除、发消息等操作时，请留意 agent 在做什么，必要时让它操作前先截图给你确认。
- **只能操作自己组里的标签页**：agent 看不到、也碰不到你的其他标签页。
- **敏感信息脱敏**：页面结构和表单结果中的密码、验证码、信用卡等字段会被隐藏；`javascript_tool` 的返回值会隐藏 token、cookie、JWT 等。
- **AI 元素查找**：只有你在设置页填了接口才会启用，启用后页面结构会发到你填写的接口。

## 十一、升级与卸载

### 升级

**npm 方式**

1. 配置里写 `browserbridge-mcp` 时，npx 可能沿用缓存里的旧版本；想确保用最新版，写成 `browserbridge-mcp@latest`，想固定版本就写成 `browserbridge-mcp@0.7.0`
2. 重新导出扩展：`npx -y browserbridge-mcp@latest extension`（会覆盖原目录）
3. 在 `chrome://extensions` 中点 Browser Bridge 的刷新按钮
4. 重启客户端

**安装包方式**

1. 从 Releases 下载新版本，解压后替换原目录（路径不变就不用重新注册）
2. 在 `chrome://extensions` 中点 Browser Bridge 的刷新按钮
3. 重启客户端

扩展和 MCP 服务的版本要一致。版本不一致时，部分新功能可能不可用。

### 卸载

1. 从客户端中移除：Claude Code 执行 `claude mcp remove browser-bridge -s user`；其他客户端删掉配置里的 `browser-bridge`
2. 在 `chrome://extensions` 中移除 Browser Bridge
3. 删除扩展目录（以及安装包目录）

## 十二、常见问题

**弹窗显示「未连接」**

- MCP 服务由客户端启动。先确认客户端已经启动，并且配置里有 browser-bridge（Claude Code 可用 `claude mcp list` 查看）。
- 确认扩展弹窗里的端口和 `BROWSER_BRIDGE_PORT` 一致（默认都是 18765）。
- 点「重连」，或等 30 秒自动重连。

**客户端提示「浏览器扩展未连接」**

- 确认 Chrome 正在运行，并且 Browser Bridge 扩展已启用。
- 如果有多个 Chrome 或多个配置文件都装了扩展，请求只会发给最后连上的那个，请只在一个配置文件里启用。

**桌面客户端提示找不到 npx 或 node**

见[第四节](#四在各客户端中配置)开头：`command` 写绝对路径，并在 `env` 里设置 `PATH`。

**Chrome 提示无法加载 zip**

先解压，再加载其中的 `extension` 文件夹。

**提示「Tab xxx is not in the … tab group」**

这个标签页不在该 agent 的组里，可能是被拖出去了，或属于别的 agent。把它拖回组里，或用弹窗「交出」。

**有些页面操作不了**

`chrome://` 页面、扩展页面和 Chrome 应用商店，浏览器不允许扩展操作。

**顶部一直有「已开始调试此浏览器」提示条**

这是 Chrome 的安全提示，agent 操作时一定会出现，空闲 20 秒后自动消失。手动关掉提示条也会断开调试，下次操作时会自动重新连接。

**客户端里看不到截图**

客户端需要支持 MCP 的图片结果。不支持时其他工具照常可用。

**控制台日志或网络请求是空的**

这两项在第一次读取时才开始记录（避免一连接就打开这些调试功能，被网站的反自动化检测识别）。控制台会补上页面之前已经输出的日志，网络请求只记录开启之后的。可以让 agent 刷新页面后再读取。跳到其他网站时会清空。

**AI 元素查找没生效**

在设置页点「测试连接」看具体报错。调用失败时会自动退回关键词匹配，结果里会注明原因。

**和其他调试类扩展冲突**

如果另一个扩展（或开发者工具）也在调试同一个标签页，两者会冲突，请避免同时操作同一个标签页。

**还有问题？**

到 [GitHub Issues](https://github.com/h025/browserbridge-mcp/issues) 反馈，附上客户端名称、Chrome 版本、扩展版本和报错信息。
