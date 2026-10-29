# Browser Bridge for Claude Code

中文 | [English](README.en.md)

让 Claude Code 等 MCP 客户端直接操作你本机的 Chrome，**不需要登录任何账号**，通信全部在本机完成：

```
Claude Code ──stdio(MCP)──> mcp-server（Node，本机）──WebSocket 127.0.0.1:18765──> Chrome 扩展 ──CDP/scripting──> 网页
```

**📖 安装、配置、使用和常见问题的完整说明见 [使用指南](docs/guide.md)。**

- 不连接任何云端服务，扩展只与本机 `127.0.0.1` 通信
- 使用你浏览器里现有的登录状态
- 多个 agent 可同时使用，**每个 agent 有自己的标签组，互不干扰**：第一个 MCP 进程做 hub，其余自动作为 peer 经 hub 转发；hub 退出后自动接任

## 安装

**方式一：npm（发布后）**

```bash
npx -y browserbridge-mcp extension          # 导出 Chrome 扩展到 ~/browser-bridge-extension
claude mcp add browser-bridge -s user -- npx -y browserbridge-mcp
```

然后在 `chrome://extensions` 中打开「开发者模式」，「加载已解压的扩展程序」选择导出的目录。其他 MCP 客户端的配置见 `mcp-server/README.md`。

**方式二：zip 安装包**：见下文「打包发布」，解压后运行 `install.sh`。

**方式三：从源码运行（开发用）**

```bash
cd mcp-server && npm install
claude mcp add browser-bridge -s user -- node "$(pwd)/src/cli.js"
```

在 Chrome 中「加载已解压的扩展程序」选择 `extension/` 目录。

重启 Claude Code 后，点击扩展图标应显示「已连接 MCP 服务」。之后直接对 Claude 说「打开 xxx 网站帮我……」即可。

## 工具

| 工具 | 作用 |
| --- | --- |
| `tabs_context_mcp` | 列出本 agent 标签组里的标签页；`createIfEmpty: true` 时新开窗口并建组 |
| `tabs_create_mcp` / `tabs_close_mcp` | 在组内新建（后台）/ 关闭标签页 |
| `navigate` | 打开 URL、后退、前进；遇到「离开此网站？」默认不离开，`force: true` 时放弃修改 |
| `computer` | 截图、点击、双击、三击、右键、悬停、拖拽、输入、按键、滚动、`scroll_to`、`zoom`、等待 |
| `read_page` | 可访问性树（带元素 `ref`），`filter: "interactive"` 只看视口内可交互元素 |
| `find` | 按关键词查找元素 |
| `form_input` | 设置输入框、下拉框、复选框、单选框、日期、滑块等的值 |
| `get_page_text` | 提取正文（优先 article / main） |
| `javascript_tool` | 在页面中执行 JS（REPL 语义，支持顶层 await，不受 CSP 限制） |
| `read_console_messages` / `read_network_requests` | 当前域名下的控制台日志、网络请求 |
| `resize_window` | 调整窗口尺寸 |
| `file_upload` | 把本机文件设置到文件输入框（服务端读取文件，≤10 MB） |
| `upload_image` | 把之前的截图（按截图 ID，保留 5 分钟）上传到文件输入框，或拖放到页面坐标处 |
| `gif_creator` | 录制操作并导出 GIF（带点击标记、动作标签、进度条），保存到本地（默认 `~/Downloads`）或拖放到页面 |
| `browser_batch` | 一次往返顺序执行多个工具调用，出错即停 |

关键行为：

- **截图与坐标**：截图按设备像素截取，缩放到视觉 token 预算内（每 28px 一个 token，长边与总 token ≤1568）。坐标一律以最近一次全尺寸截图为准，越界会报错；`scale` 参数只缩小返回的图片，不改变坐标系。
- **后台标签页**：附加调试器后开启焦点模拟，后台标签页无需切到前台即可截图、点击、输入。
- **键盘**：`type` 逐字符发送真实按键，键盘上没有的字符（中文、emoji 等）直接插入；`key` 支持组合键，macOS 上自动附带系统编辑命令（`cmd+a` / `cmd+c` / `cmd+v` 等才能生效）；刷新快捷键会直接刷新页面，页面缩放快捷键会被拒绝。
- **点击打开新标签页**时，新标签页会加入标签组，返回结果里给出它的 tabId；按 ref 点击时若元素中心被弹窗、横幅等遮挡，结果里会提示。
- **取消**：在 Claude Code 里按 Esc 取消调用时，正在执行的 `browser_batch` 会停止后续步骤。
- **页面指示器**：Claude 操作时，页面四周显示彩色渐变边框和光晕，渐变光标会动画移到点击位置；截图时自动隐藏。
- **自动释放**：标签页 20 秒没有新操作就断开调试器（Chrome 顶部的「正在调试」提示条随之消失），MCP 服务断开时全部释放；标签组标题显示 ⌛（执行中）/ ✅（已完成）。标签页被拖出标签组后立即收回控制。
- **操作前校验域名**：点击、输入、上传、执行 JS 前确认页面没有跳到别的域名，否则拒绝执行。
- **后台标签页静音**：焦点模拟可能让后台页面的音视频出声，会先静音，切到该标签页后恢复。
- **其他扩展干扰**：其他扩展（如密码管理器）注入的 iframe 导致调试器无法附加时，自动移除后重试。
- **连接保活**：连接期间用离屏文档保持 Service Worker 常驻。
- **安全**：可访问性树和表单结果中，密码、验证码、信用卡等字段会脱敏；`javascript_tool` 的返回值会屏蔽 token、cookie、JWT 等敏感数据。
- 每次结果末尾附带 `Tab Context`（当前组内所有标签页）。

其他说明：

- `find`：可选接入自己的 AI 接口理解自然语言（见下文「AI 元素查找」），未配置时用本地关键词匹配。
- 不需要账号，也没有网站权限弹窗。
- 页面底部有「停止」按钮：点击后 Claude 的下一次调用会被拒绝并要求它停下来询问你。
- `gif_creator` 的 `download: true` 由 MCP 服务把 GIF 写到本地磁盘并返回路径。
- 对话框处理：Claude 执行操作期间页面弹出的 alert 自动确认、confirm/prompt 自动取消（否则页面会被阻塞），并在结果中提示；Claude 空闲时出现的对话框（可能是你自己的操作）留给你处理，Claude 下次操作该标签页时若仍未关闭才自动处理。

## 打包发布

```bash
cd mcp-server && npm install && cd ..
node scripts/package.mjs
```

生成 `dist/browser-bridge-<版本>.zip`，解压后包含：

- `extension/`：Chrome 扩展，用「加载已解压的扩展程序」安装
- `mcp/browser-bridge-mcp.mjs`：打成单文件的 MCP 服务，只需要 Node.js 18+，不用 `npm install`
- `install.sh` / `install.cmd`：把 MCP 服务注册到 Claude Code
- `README.md`：给使用者的中文安装说明（源文件在 `packaging/`）

扩展和 MCP 服务的版本号需一致（`extension/manifest.json` 与 `mcp-server/package.json`），否则打包脚本会报错。

**自动发布**：推送到 `main` 后，GitHub Actions（`.github/workflows/release.yml`）会自动打包，把 zip 安装包发布到 [Releases](https://github.com/h025/browserbridge-mcp/releases) 的 `v<版本号>`。版本号没变时更新同一个 Release（替换安装包），要发新版本先改版本号再推送。包里不含任何 AI 接口配置，由使用者在扩展的「设置」里自行填写。

## 在其他 MCP 客户端中使用

MCP 服务是标准 stdio 服务，Claude 桌面版、Codex、Cursor、VS Code 等都能用：在客户端的 MCP 配置里把命令设为 node 的绝对路径、参数设为服务文件的绝对路径即可。各客户端的配置示例见 `packaging/README.md`（安装包里的 `README.md`）。

## AI 元素查找（可选）

点扩展图标里的「设置」（或在 `chrome://extensions` 中打开扩展的「扩展程序选项」），在「AI 元素查找」中填写 OpenAI 兼容接口：

- **接口地址**：如 `https://api.openai.com/v1`；只填域名时自动补 `/v1/chat/completions`，也可填完整地址。
- **API Key**：只保存在本机浏览器（`chrome.storage.local`），本机模型（如 Ollama）可留空。
- **模型**：接口支持的模型名。

填写后可点「测试连接」确认。启用后，`find` 会把页面的可访问性树（密码、验证码、信用卡等字段已脱敏）和查询发给该模型，返回匹配的元素和理由，例如“拖放文件的区域”“提交新故事的链接”这类关键词匹配不到的描述也能找到；模型编造的 ref 会被过滤。未填写、调用失败或超时（60 秒）时自动退回本地关键词匹配，并在结果里注明原因。

## 界面语言

扩展的弹窗、设置页、页面上的「停止」按钮和 GIF 动作标签跟随浏览器界面语言，目前支持中文和英文（其他语言显示英文），文字在 `extension/_locales/` 中。命令行 `browserbridge-mcp` 的提示和「扩展未连接」等提示跟随系统语言（`LANG`）。返回给模型的工具说明和结果始终是英文。

## 权限与安全

- **每个 agent 只能操作自己标签组里的标签页。** 想让它操作已有页面，把标签页拖进它的组，或点扩展图标，选好 agent 后点「交出」。

## 多个 agent 同时使用

每个 MCP 服务进程（也就是每个 agent 会话）有自己的标签组，看不到、也操作不了别的 agent 的标签页：

- **组名**：客户端名 · 项目目录，例如「Claude Code · my-app」「Codex · api」；重名时加序号，每个组颜色不同。桌面客户端没有项目目录，只显示客户端名。
- **停止**：页面上的「停止」只拦下这个标签页所属的 agent，其他 agent 照常工作。
- **退出与重启**：agent 退出后它的标签组保留（标签页不关闭）；同一客户端在同一目录重新启动（例如 Claude Code 里 `/mcp` 重连）时接回原来的组，之前的标签页 ID 仍然有效。
- **升级**：0.7.0 之前共用的 “Browser Bridge” / “Claude Bridge” 组由第一个需要标签组的 agent 接手。旧版 MCP 服务（不带会话信息）的请求共用一个名为 “Browser Bridge” 的组。
- WebSocket 服务只监听 `127.0.0.1`，并校验 `Origin`：普通网页无法连接；扩展端只接受本扩展（manifest 中的 `key` 固定了扩展 ID `oajlnlbllfohnlkecpodgediipicjajd`），其他扩展无法冒充来截获 Claude 输入的内容。如需改用其他扩展 ID，设置环境变量 `BROWSER_BRIDGE_EXTENSION_IDS`（逗号分隔）。本机的其他程序仍可连接，请只在可信的电脑上使用。
- **本机文件访问受限**：`file_upload` 读取、`gif_creator` 保存的文件必须位于 Claude Code 的工作目录、`~/Downloads`、`~/Desktop`、`~/Documents`、`~/Pictures` 之内，且不能是隐藏文件或在隐藏目录中（如 `~/.ssh`、`.env`），防止网页诱导 Claude 把敏感文件上传出去。用环境变量 `BROWSER_BRIDGE_FILE_DIRS`（以 `:` 分隔）自定义允许的目录。
- Claude 用的是你真实的登录状态，涉及付款、删除、发消息等操作时请留意它在做什么。

## 说明与限制

- 操作页面时扩展会附加调试器，Chrome 顶部会出现「已开始调试此浏览器」提示条，这是 Chrome 的安全机制；空闲 20 秒后会自动断开。手动关掉提示条也会断开调试，下次操作时自动重新附加。
- 控制台日志和网络请求在第一次调用 `read_console_messages` / `read_network_requests` 时才开始记录（避免一附加调试器就开启这些调试功能、被网站的反自动化检测识别）；控制台会补上页面此前已输出的消息，网络请求只记录开启之后的。跳转到其他域名时清空；调试器空闲断开期间产生的网络请求不会被记录。
- 输入文本默认模拟真人打字节奏（字符间随机间隔，长文本自动加快），可在扩展「设置」中关闭。
- 多个 Chrome（或多个 Chrome 配置文件）同时装了扩展时，请求只会发给最后连上服务的那一个，请只在一个配置文件中启用扩展。
- `read_page` / `find` 只覆盖主文档（含 open shadow DOM），不进入 iframe 内部。
- 不能操作 `chrome://`、扩展页面和 Chrome 应用商店页面。
- 如果其他扩展也在调试同一个标签页，两者会冲突，请避免同时操作同一标签页。
- 端口默认 `18765`。要修改，设置环境变量 `BROWSER_BRIDGE_PORT`，并在扩展弹窗里填写相同端口。

## 目录结构

```
extension/
  manifest.json
  _locales/              界面文字（en、zh_CN）
  background.js          Service Worker 入口
  src/bridge.js          与 MCP 服务的 WebSocket 连接（保活、自动重连）
  src/tools.js           工具实现与分发（含 browser_batch）
  src/computer.js        computer 工具：鼠标、键盘、截图
  src/cdp.js             chrome.debugger 封装：焦点模拟、对话框处理、控制台/网络日志
  src/input.js           鼠标、键盘事件派发
  src/keys.js            US 键位表与 macOS 编辑命令
  src/screenshot.js      截图、token 预算缩放与坐标换算
  src/tabs.js            按 agent 会话管理标签组、域名校验
  src/activity.js        活动跟踪：页面指示器、空闲释放、停止请求、标签组状态前缀
  src/gif.js             GIF 录制与导出
  src/page-agent.js      内容脚本：可访问性树、ref、表单、上传/拖放、正文提取、关键词查找
  src/indicator.js       内容脚本：彩色渐变边框、动画光标、停止按钮
  src/i18n.js            界面文字的取用与填充
  offscreen.html / .js   离屏文档：GIF 合成编码、Service Worker 保活
  vendor/gifenc.js       GIF 编码库（gifenc 1.0.3，MIT）
  src/ai.js              可选的 AI 元素查找（OpenAI 兼容接口）
  options.html / .js     AI 接口设置页
  popup.html / popup.js  连接状态、端口设置、共享当前标签页、当前查找模式
mcp-server/
  src/cli.js             命令行入口：启动服务 / 导出扩展 / 版本
  src/index.js           MCP stdio 服务：工具调用、结果格式化、本机文件读写
  src/bridge.js          WebSocket hub/peer
  src/i18n.js            命令行提示的中英文切换
  src/tools.js           工具 JSON Schema 与使用说明
  scripts/build.mjs      打成单文件（npm 包与 zip 安装包共用）
  README.md              npm 包说明
scripts/package.mjs      生成 zip 安装包
scripts/make-icons.py    生成扩展图标（需要 Pillow）
packaging/               zip 安装包里的安装脚本与说明
tests/e2e/               端到端测试（见下文）
```

## 测试

```bash
node tests/e2e/run-all.mjs              # 全部：regression features review ai fixes
node tests/e2e/run-all.mjs regression   # 只跑某几套
```

需要 Playwright 缓存里的 Chrome for Testing（或用 `CHROME_PATH` 指定），`HEADFUL=1` 用有界面模式。测试使用专用端口 18790，不会影响正在使用的 Claude Code 和 Chrome。测试其他构建产物时可用 `EXT_DIR` 指定扩展目录、`SERVER_CMD` 指定服务启动命令（JSON）。断言按中文界面编写，请在中文系统上运行（macOS 上 Chrome 不支持用 `--lang` 切换界面语言）。

## 许可

[MIT](LICENSE)
