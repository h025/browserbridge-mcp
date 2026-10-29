// 打包 zip 安装包：生成 dist/browser-bridge-<版本>/ 目录和同名 zip。
//   extension/                 Chrome 扩展（“加载已解压的扩展程序”）
//   mcp/browser-bridge-mcp.mjs  打成单文件的 MCP 服务，只需要 Node.js 18+，无需 npm install
//   install.sh / install.cmd   把 MCP 服务注册到 Claude Code
//   README.md                  安装与使用说明（中文）
//   LICENSE                    许可
// 用法：先在 mcp-server/ 里 npm install，然后在项目根目录运行 node scripts/package.mjs
// （npm 包由 mcp-server/ 里的 npm pack / npm publish 生成，见 mcp-server/scripts/build.mjs）
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let build;
try {
  build = await import('../mcp-server/scripts/build.mjs');
} catch {
  console.error('缺少构建依赖：请先在 mcp-server/ 目录运行 npm install');
  process.exit(1);
}
try {
  build.checkVersions();
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

const name = `browser-bridge-${build.VERSION}`;
const dist = join(root, 'dist');
const out = join(dist, name);
rmSync(out, { recursive: true, force: true });
rmSync(`${out}.zip`, { force: true });
mkdirSync(join(out, 'mcp'), { recursive: true });

build.copyExtension(join(out, 'extension'));
await build.bundleServer(join(out, 'mcp/browser-bridge-mcp.mjs'));
for (const f of ['install.sh', 'install.cmd', 'README.md']) cpSync(join(root, 'packaging', f), join(out, f));
chmodSync(join(out, 'install.sh'), 0o755);
cpSync(join(root, 'LICENSE'), join(out, 'LICENSE'));

// -X：不写入系统扩展属性
execFileSync('zip', ['-r', '-X', '-q', `${name}.zip`, name], { cwd: dist });

const kb = (p) => `${Math.round(statSync(p).size / 1024)} KB`;
console.log(`已生成 ${join('dist', name)}/`);
console.log(`  mcp/browser-bridge-mcp.mjs  ${kb(join(out, 'mcp/browser-bridge-mcp.mjs'))}`);
console.log(`已生成 ${join('dist', `${name}.zip`)}  ${kb(`${out}.zip`)}`);
if (!existsSync(`${out}.zip`)) process.exit(1);
