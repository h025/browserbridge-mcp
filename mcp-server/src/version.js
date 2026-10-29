// 版本号：打包时由 esbuild 注入 __BB_VERSION__；直接运行源码时读取 package.json
import { readFileSync } from 'node:fs';

/* global __BB_VERSION__ */
export const VERSION = typeof __BB_VERSION__ !== 'undefined'
  ? __BB_VERSION__
  : JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
