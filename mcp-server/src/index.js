// MCP 服务：通过 stdio 与 MCP 客户端通信，经本机 WebSocket 桥把工具调用交给浏览器扩展执行。
// 由 cli.js 调用 startServer() 启动
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Bridge } from './bridge.js';
import { INSTRUCTIONS, TOOLS } from './tools.js';
import { VERSION } from './version.js';

const PORT = Number(process.env.BROWSER_BRIDGE_PORT) || 18765;
const TOOL_NAMES = new Set(TOOLS.map((t) => t.name));
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const MIME_TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.txt': 'text/plain', '.csv': 'text/csv', '.json': 'application/json',
  '.html': 'text/html', '.zip': 'application/zip', '.doc': 'application/msword', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

// 网页内容可能诱导 Claude 上传本机敏感文件（如 ~/.ssh/id_rsa）或覆盖文件，所以本机文件的读写
// 只允许在这些目录内，且不能经过隐藏文件/目录。用 BROWSER_BRIDGE_FILE_DIRS（按系统路径分隔符分隔）覆盖
const FILE_DIRS = (process.env.BROWSER_BRIDGE_FILE_DIRS
  ? process.env.BROWSER_BRIDGE_FILE_DIRS.split(delimiter)
  : [projectDir(), ...['Downloads', 'Desktop', 'Documents', 'Pictures'].map((d) => join(homedir(), d))]
).filter(Boolean).map((d) => realOrSelf(resolve(expandHome(d))));

// Claude Code 等命令行客户端在项目目录里启动服务，允许访问该目录；桌面客户端启动时工作目录
// 往往是根目录或主目录，放开它等于放开整个磁盘，此时不加入
function projectDir() {
  const cwd = realOrSelf(process.cwd());
  return cwd === realOrSelf(resolve('/')) || cwd === realOrSelf(homedir()) ? null : cwd;
}

function expandHome(p) {
  return /^~([\\/]|$)/.test(p) ? join(homedir(), p.slice(2)) : p;
}

function realOrSelf(p) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

// 返回规范化后的绝对路径；不在允许的目录内或经过隐藏文件/目录时抛错
function checkLocalPath(input, { mustExist }) {
  const abs = resolve(expandHome(String(input)));
  if (mustExist && !existsSync(abs)) throw new Error(`File not found: ${abs}`);
  // 解析符号链接，防止借链接跳出允许的目录；新文件按其所在目录解析
  const real = mustExist ? realOrSelf(abs) : join(realOrSelf(dirname(abs)), basename(abs));
  const root = FILE_DIRS.find((d) => real === d || real.startsWith(d.endsWith(sep) ? d : d + sep));
  if (!root) {
    throw new Error(`Access to ${abs} is not allowed. Local files must be inside: ${FILE_DIRS.join(', ')} (set BROWSER_BRIDGE_FILE_DIRS to change this).`);
  }
  if (relative(root, real).split(sep).some((seg) => seg.startsWith('.'))) {
    throw new Error(`Access to hidden files or directories is not allowed: ${abs}`);
  }
  return real;
}

// 每个 MCP 服务进程对应一个 agent 会话，扩展给每个会话单独一个标签组，互不干扰。
// client 是 MCP 客户端名称（握手后才知道），folder 用于标签组名称，cwd 用于客户端重启后接回原来的标签组
const session = { id: randomUUID(), client: '', folder: projectDir() ? basename(projectDir()) : '', cwd: realOrSelf(process.cwd()) };
const bridge = new Bridge({ port: PORT, session });
const server = new Server(
  { name: 'browser-bridge', version: VERSION },
  { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
);
server.oninitialized = () => {
  session.client = server.getClientVersion()?.name || '';
  bridge.announce();
};

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

// extra.signal：Claude Code 取消调用（如用户按 Esc）时中止，并通知扩展停止 browser_batch 等后续步骤
server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
  const { name, arguments: args = {} } = req.params;
  try {
    if (!TOOL_NAMES.has(name)) throw new Error(`Unknown tool: ${name}`);
    const result = await bridge.call(name, prepareArgs(name, args), { signal: extra?.signal });
    saveExportedFiles(result);
    return toMcpResult(result);
  } catch (e) {
    return { content: [{ type: 'text', text: e.message }], isError: true };
  }
});

// 只有本机进程能读文件：把 file_upload 的本地路径读成 base64 后再交给扩展（browser_batch 里的也一样）
function prepareArgs(name, args) {
  if (name === 'browser_batch' && Array.isArray(args.actions)) {
    return { ...args, actions: args.actions.map((a) => (a?.name === 'file_upload' ? { ...a, input: prepareArgs('file_upload', a.input || {}) } : a)) };
  }
  if (name !== 'file_upload' || !Array.isArray(args.paths)) return args;
  let total = 0;
  const files = args.paths.map((p) => {
    const path = checkLocalPath(p, { mustExist: true });
    const stat = statSync(path);
    if (!stat.isFile()) throw new Error(`Not a file: ${path}`);
    total += stat.size;
    if (total > MAX_UPLOAD_BYTES) throw new Error('Total upload size exceeds 10 MB; use smaller files or split across multiple file_upload calls.');
    return {
      name: basename(path),
      data: readFileSync(path).toString('base64'),
      mimeType: MIME_TYPES[extname(path).toLowerCase()] || 'application/octet-stream',
    };
  });
  const { paths, ...rest } = args;
  return { ...rest, files };
}

// gif_creator(download: true) 导出的 GIF 由本机进程写入磁盘，默认放在 ~/Downloads
function saveGif({ filename, base64 }) {
  const downloads = join(homedir(), 'Downloads');
  const baseDir = existsSync(downloads) ? downloads : process.cwd();
  const expanded = expandHome(filename);
  const target = isAbsolute(expanded) ? expanded : join(baseDir, expanded);
  const path = checkLocalPath(target, { mustExist: false });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, Buffer.from(base64, 'base64'));
  return path;
}

function saveExportedFiles(result) {
  const holders = [result, ...(result?.batchItems || [])];
  for (const h of holders) {
    if (!h?.gifFile) continue;
    try {
      h.output = `${h.output ?? ''} Saved to: ${saveGif(h.gifFile)}`;
    } catch (e) {
      h.output = `${h.output ?? ''} Failed to save GIF: ${e.message}`;
    }
    delete h.gifFile;
  }
}

const image = (data, format) => ({ type: 'image', data, mimeType: `image/${format || 'png'}` });

function formatTabContext(ctx) {
  const executed = ctx.executedOnTabId ? `\n- Executed on tabId: ${ctx.executedOnTabId}` : '';
  const tabs = ctx.availableTabs.map((t) => `  • tabId ${t.id}: ${JSON.stringify(t.title)} (${JSON.stringify(t.url)})`).join('\n');
  return `\n\nTab Context:${executed}\n- Available tabs:\n${tabs}`;
}

function toMcpResult(result) {
  if (!result || result.error) {
    return { content: [{ type: 'text', text: result?.error || 'Unknown error' }], isError: true };
  }
  const content = [];
  if (result.batchItems) {
    for (const item of result.batchItems) {
      content.push({ type: 'text', text: `[${item.label}] ${item.output ?? 'ok'}` });
      if (item.base64Image) content.push(image(item.base64Image, item.imageFormat));
    }
  } else if (result.output) {
    content.push({ type: 'text', text: result.output });
  }
  if (result.tabContext?.availableTabs) content.push({ type: 'text', text: formatTabContext(result.tabContext) });
  if (result.base64Image) content.push(image(result.base64Image, result.imageFormat));
  if (!content.length) content.push({ type: 'text', text: 'ok' });
  return { content };
}

// 启动服务。Claude Code 关闭时 stdin 结束，必须退出进程以释放端口，让其他会话接任 hub
export async function startServer() {
  const shutdown = () => {
    bridge.close();
    process.exit(0);
  };
  process.stdin.on('close', shutdown);
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  await server.connect(new StdioServerTransport());
  await bridge.start();
}
