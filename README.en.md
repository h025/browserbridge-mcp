# Browser Bridge for Claude Code

[中文](README.md) | English

Let Claude Code and other MCP clients drive your local Chrome, **with no account sign-in**. Everything runs locally:

```
MCP client ──stdio(MCP)──> mcp-server (Node, local) ──WebSocket 127.0.0.1:18765──> Chrome extension ──CDP/scripting──> web page
```

**📖 A detailed usage guide (in Chinese) is in [docs/guide.md](docs/guide.md).**

- No cloud service; the extension only talks to `127.0.0.1`
- Uses the logins already in your browser
- Several agents can use it at once, **each with its own tab group, without getting in each other's way**: the first MCP process acts as the hub, the others relay through it, and a new hub takes over when it exits

## Install

**npm**

```bash
npx -y browserbridge-mcp extension          # copy the Chrome extension to ~/browser-bridge-extension
claude mcp add browser-bridge -s user -- npx -y browserbridge-mcp
```

Then open `chrome://extensions`, turn on "Developer mode", click "Load unpacked" and choose the exported folder.

Other MCP clients (Claude Desktop, Cursor, Windsurf, Cline, Gemini CLI, ...) add this to `mcpServers`:

```json
{
  "mcpServers": {
    "browser-bridge": { "command": "npx", "args": ["-y", "browserbridge-mcp"] }
  }
}
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.browser-bridge]
command = "npx"
args = ["-y", "browserbridge-mcp"]
```

Desktop apps do not see your shell's PATH. If they cannot find `npx` or `node` (common with nvm or fnm), use the absolute path of `npx` as `command` and add `"env": { "PATH": "<node dir>:/usr/bin:/bin" }`.

**From source (development)**

```bash
cd mcp-server && npm install
claude mcp add browser-bridge -s user -- node "$(pwd)/src/cli.js"
```

Load the `extension/` folder with "Load unpacked". After restarting the client, the extension popup should say "Connected to the MCP server".

## Tools

| Tool | Purpose |
| --- | --- |
| `tabs_context_mcp` | List the controllable tabs in the group; `createIfEmpty: true` opens a window with a new group |
| `tabs_create_mcp` / `tabs_close_mcp` | Open (in the background) / close a tab in the group |
| `navigate` | Open a URL, go back or forward; a "Leave site?" prompt keeps the page unless `force: true` |
| `computer` | Screenshot, click, double/triple/right click, hover, drag, type, keys, scroll, `scroll_to`, `zoom`, wait |
| `read_page` | Accessibility tree with element `ref`s; `filter: "interactive"` for visible interactive elements |
| `find` | Find elements by keywords, or by natural language with your own AI endpoint |
| `form_input` | Set inputs, selects, checkboxes, radios, dates, sliders |
| `get_page_text` | Extract the main text (article / main first) |
| `javascript_tool` | Run JS in the page (REPL semantics, top-level await, not blocked by CSP) |
| `read_console_messages` / `read_network_requests` | Console output and network requests of the current site |
| `resize_window` | Resize the window |
| `file_upload` | Put local files into a file input (read by the server, up to 10 MB) |
| `upload_image` | Upload an earlier screenshot (by ID, kept 5 minutes) to a file input or drop it at a point |
| `gif_creator` | Record actions and export a GIF (click markers, labels, progress bar), saved locally or dropped on the page |
| `browser_batch` | Run several tool calls in one round trip, stopping at the first error |

Highlights:

- **Screenshots and coordinates**: screenshots are scaled to the vision token budget (28 px per token, at most 1568 on the long side and in total). Coordinates always refer to the latest full-size screenshot; `scale` only shrinks the returned image.
- **Background tabs**: focus emulation lets background tabs be captured, clicked and typed into without bringing them to the front.
- **Keyboard**: `type` sends real key events per character (text not on the keyboard, such as CJK or emoji, is inserted); `key` supports chords and, on macOS, the system editing commands needed for `cmd+a` / `cmd+c` / `cmd+v`.
- **Page indicator**: while a tool runs, the page gets a colorful gradient border and glow and a gradient cursor moves to each click; everything is hidden in screenshots. A **Stop** button at the bottom makes the agent's next call fail with a request to stop and ask you.
- **Idle release**: the debugger detaches after 20 seconds without activity; the tab group title shows ⌛ while working and ✅ when done.
- **Same-site check**: clicks, typing, uploads and JS are refused if the page moved to another site meanwhile.
- **Dialogs**: alerts raised while a tool runs are accepted and confirm/prompt dismissed automatically, and the result says so; dialogs that show up while idle are left for you.
- **Privacy**: password, verification-code and card fields are masked in the tree and form results; `javascript_tool` results hide tokens, cookies and JWTs.

Other notes:

- `find` can use your own OpenAI-compatible endpoint (see below) to understand natural language; without it, local keyword matching is used.
- No account and no site-permission prompts.
- `gif_creator` with `download: true` writes the GIF to disk through the MCP server and returns the path.

## Interface language

The popup, settings page, the on-page Stop button and the GIF action labels follow the browser's UI language: Chinese and English for now (other languages show English). Strings live in `extension/_locales/`. The `browserbridge-mcp` command line and messages such as "extension not connected" follow the system language (`LANG`). Tool descriptions and results for the model are always English.

## AI element search (optional)

Open "Settings" in the extension popup and fill in an OpenAI-compatible endpoint:

- **Endpoint**, e.g. `https://api.openai.com/v1` (a bare host gets `/v1/chat/completions` added)
- **API key**, stored only in this browser (`chrome.storage.local`); can be empty for local models such as Ollama
- **Model**

With it, `find` sends the page's accessibility tree (sensitive fields masked) and the query to that model and returns matching elements with reasons. Refs invented by the model are dropped. If the endpoint is missing, fails or times out (60 s), keyword matching is used and the result says why.

## Security

- **Each agent can only control the tabs in its own tab group.** Drag a tab into an agent's group, or pick the agent in the popup and click "Hand over".

## Several agents at once

Each MCP server process (one per agent session) gets its own tab group and can neither see nor control other agents' tabs:

- **Group name**: client · project folder, e.g. "Claude Code · my-app" or "Codex · api", numbered when names clash; every group gets a different color. Desktop clients have no project folder, so only the client name is shown.
- **Stop**: the on-page Stop button stops only the agent that owns that tab.
- **Exit and restart**: when an agent exits, its group stays (tabs are not closed). When the same client restarts in the same folder (for example `/mcp` reconnect in Claude Code), it gets its old group back and earlier tab IDs keep working.
- **Upgrading**: the shared "Browser Bridge" / "Claude Bridge" group from before 0.7.0 is taken over by the first agent that needs a group. Requests from older MCP servers (without session info) share one group named "Browser Bridge".
- The WebSocket server listens on `127.0.0.1` only and checks `Origin`: web pages cannot connect, and only this extension (its ID is pinned by the manifest `key`: `oajlnlbllfohnlkecpodgediipicjajd`) is accepted. Use `BROWSER_BRIDGE_EXTENSION_IDS` (comma separated) to allow other IDs. Other local programs can still connect, so use it on machines you trust.
- **Local file access is limited**: files read by `file_upload` or written by `gif_creator` must be inside the client's working directory, `~/Downloads`, `~/Desktop`, `~/Documents` or `~/Pictures`, and not hidden (no `~/.ssh`, `.env`, ...). Change the list with `BROWSER_BRIDGE_FILE_DIRS` (path-separator separated).
- The agent acts with your real logins; keep an eye on payments, deletions and messages.

## Notes and limits

- While attached, Chrome shows the "started debugging this browser" bar; it goes away after 20 idle seconds.
- Console and network recording start the first time `read_console_messages` / `read_network_requests` runs on a tab.
- Typing follows a human rhythm by default (random gaps, faster for long text); turn it off in Settings.
- If several Chrome profiles have the extension, requests go to the one that connected last.
- `read_page` / `find` cover the main document (including open shadow DOM), not iframes.
- `chrome://` pages, extension pages and the Chrome Web Store cannot be controlled.
- Default port `18765`; change it with `BROWSER_BRIDGE_PORT` and enter the same port in the popup.

## Build

```bash
cd mcp-server && npm install && cd ..
node scripts/package.mjs        # dist/browser-bridge-<version>.zip
cd mcp-server && npm pack       # npm package
```

The versions in `extension/manifest.json` and `mcp-server/package.json` must match. Every push to `main` runs `.github/workflows/release.yml`, which builds the zip and publishes it to the `v<version>` [release](https://github.com/h025/browserbridge-mcp/releases); while the version stays the same, that release is updated in place, so bump the version to publish a new one. No AI endpoint is bundled; users enter their own in Settings.

## Tests

```bash
node tests/e2e/run-all.mjs              # regression features review ai fixes
node tests/e2e/run-all.mjs regression   # selected suites
```

Needs Chrome for Testing from the Playwright cache (or `CHROME_PATH`); `HEADFUL=1` shows the window. Tests use port 18790 and do not touch your running client or Chrome. Assertions expect the Chinese UI, so run them on a Chinese system (Chrome on macOS ignores `--lang`).

## License

[MIT](LICENSE)
