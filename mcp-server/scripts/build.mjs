// 构建：把命令行入口和 MCP 服务打成单个 ESM 文件（运行时无需任何依赖，只要 Node.js 18+）。
// 直接运行（npm run build，npm pack/publish 前自动执行）时生成 npm 包内容：
//   dist/browser-bridge-mcp.mjs   可执行入口
//   dist/extension/               随包附带的 Chrome 扩展（browserbridge-mcp extension 命令导出）
// 根目录的 scripts/package.mjs 也用 bundleServer() 生成 zip 安装包里的服务文件
import { chmodSync, cpSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const serverDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(serverDir, '..');
export const VERSION = JSON.parse(readFileSync(join(serverDir, 'package.json'), 'utf8')).version;
export const EXTENSION_DIR = join(repoRoot, 'extension');

export function checkVersions() {
  const extVersion = JSON.parse(readFileSync(join(EXTENSION_DIR, 'manifest.json'), 'utf8')).version;
  if (extVersion !== VERSION) throw new Error(`版本不一致：扩展 ${extVersion}，MCP 服务 ${VERSION}。请先统一版本号。`);
}

export async function bundleServer(outfile) {
  await esbuild.build({
    entryPoints: [join(serverDir, 'src/cli.js')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node18',
    // ws 的可选原生加速模块，运行时找不到会自动跳过
    external: ['bufferutil', 'utf-8-validate'],
    // 依赖里有 CommonJS 模块，打成 ESM 后需要提供 require
    banner: { js: "import { createRequire as __bbCreateRequire } from 'node:module';\nconst require = __bbCreateRequire(import.meta.url);" },
    define: { __BB_VERSION__: JSON.stringify(VERSION) },
    legalComments: 'eof',
    logLevel: 'warning',
  });
  chmodSync(outfile, 0o755);
}

export function copyExtension(dst) {
  cpSync(EXTENSION_DIR, dst, { recursive: true, filter: (src) => !/(^|[\\/])(\.DS_Store|Thumbs\.db)$/.test(src) });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  checkVersions();
  const dist = join(serverDir, 'dist');
  rmSync(dist, { recursive: true, force: true });
  await bundleServer(join(dist, 'browser-bridge-mcp.mjs'));
  copyExtension(join(dist, 'extension'));
  console.log(`已构建 dist/（v${VERSION}）`);
}
