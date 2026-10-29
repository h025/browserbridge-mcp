#!/usr/bin/env node
// 命令行入口
//   browserbridge-mcp                    启动 MCP 服务（由 MCP 客户端调用，通过 stdio 通信）
//   browserbridge-mcp extension [目录]   把 Chrome 扩展复制到目录（默认 ~/browser-bridge-extension）
//   browserbridge-mcp --version | --help
import { cpSync, existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { say } from './i18n.js';
import { VERSION } from './version.js';

// 扩展名称已本地化（__MSG_extName__），用 homepage_url 识别；旧版本（0.6.0 及以前）用固定名称识别
const HOMEPAGE = 'https://github.com/h025/browserbridge-mcp';
const LEGACY_NAME = 'Browser Bridge for Claude Code';
const here = dirname(fileURLToPath(import.meta.url));
const [command, arg] = process.argv.slice(2);

const isOurExtension = (dir) => {
  try {
    const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    return m.homepage_url === HOMEPAGE || m.name === LEGACY_NAME;
  } catch {
    return false;
  }
};

// 随包附带的扩展：npm 包里在 dist/extension，zip 安装包里在 mcp/ 旁边，源码运行时在仓库根目录
function bundledExtension() {
  return [join(here, 'extension'), join(here, '..', 'extension'), join(here, '..', '..', 'extension')].find(isOurExtension);
}

function exportExtension(target) {
  const src = bundledExtension();
  if (!src) {
    console.error(say('找不到随包附带的扩展文件，安装可能不完整', 'The bundled extension files are missing; the installation looks incomplete.'));
    process.exit(1);
  }
  const dst = resolve(target ? target.replace(/^~(?=$|[\\/])/, homedir()) : join(homedir(), 'browser-bridge-extension'));
  if (existsSync(dst) && readdirSync(dst).length && !isOurExtension(dst)) {
    console.error(say(
      `目录 ${dst} 不为空，且不是 Browser Bridge 扩展目录。请换一个目录，或先清空它。`,
      `${dst} is not empty and does not hold the Browser Bridge extension. Pick another folder or empty this one first.`,
    ));
    process.exit(1);
  }
  // 覆盖旧版本前先删除，避免残留已删除的文件
  rmSync(dst, { recursive: true, force: true });
  cpSync(src, dst, { recursive: true });
  console.log(say(`Browser Bridge 扩展（v${VERSION}）已复制到：${dst}

首次安装：
  1. 打开 Chrome，进入 chrome://extensions，打开右上角的「开发者模式」
  2. 点「加载已解压的扩展程序」，选择上面的目录
升级：在 chrome://extensions 中点该扩展的刷新按钮

请不要删除这个目录，Chrome 会一直从这里加载扩展。`, `Browser Bridge extension v${VERSION} copied to: ${dst}

First install:
  1. Open chrome://extensions in Chrome and turn on "Developer mode" (top right)
  2. Click "Load unpacked" and choose the folder above
Upgrading: click the reload button on the extension's card in chrome://extensions

Keep this folder; Chrome loads the extension from it every time.`));
}

const HELP = say(`browserbridge-mcp v${VERSION}
让 Claude Code 等 MCP 客户端操作你本机的 Chrome（需配合 Browser Bridge 扩展）

用法：
  browserbridge-mcp                    启动 MCP 服务（写进 MCP 客户端的配置里，由客户端启动）
  browserbridge-mcp extension [目录]   把 Chrome 扩展复制到目录（默认 ~/browser-bridge-extension）
  browserbridge-mcp --version          显示版本

在 Claude Code 中注册：
  claude mcp add browser-bridge -s user -- npx -y browserbridge-mcp`, `browserbridge-mcp v${VERSION}
Lets Claude Code and other MCP clients drive your local Chrome (with the Browser Bridge extension)

Usage:
  browserbridge-mcp                    start the MCP server (put this in your MCP client's config)
  browserbridge-mcp extension [dir]    copy the Chrome extension to dir (default ~/browser-bridge-extension)
  browserbridge-mcp --version          print the version

Register with Claude Code:
  claude mcp add browser-bridge -s user -- npx -y browserbridge-mcp`);

if (command === 'extension') {
  exportExtension(arg);
} else if (command === '--version' || command === '-v') {
  console.log(VERSION);
} else if (command === '--help' || command === '-h' || command === 'help') {
  console.log(HELP);
} else if (command) {
  console.error(`${say('未知命令', 'Unknown command')}: ${command}\n\n${HELP}`);
  process.exit(1);
} else {
  const { startServer } = await import('./index.js');
  await startServer();
}
