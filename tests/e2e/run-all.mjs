// 依次运行全部端到端测试：node tests/e2e/run-all.mjs [套件名…]
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const suites = process.argv.slice(2).length ? process.argv.slice(2) : ['regression', 'features', 'review', 'ai', 'fixes'];
const results = [];
for (const name of suites) {
  console.log(`\n######## ${name}`);
  const r = spawnSync(process.execPath, [join(here, `${name}.mjs`)], { stdio: 'inherit', env: process.env });
  results.push([name, r.status === 0]);
}
console.log('\n######## 汇总');
for (const [name, ok] of results) console.log(`  ${ok ? '✅' : '❌'} ${name}`);
process.exit(results.every(([, ok]) => ok) ? 0 : 1);
