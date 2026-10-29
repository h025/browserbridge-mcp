#!/bin/sh
# 把 Browser Bridge 的 MCP 服务注册到 Claude Code（用户级，所有项目都可用）
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
SERVER="$DIR/mcp/browser-bridge-mcp.mjs"

if ! command -v node >/dev/null 2>&1; then
  echo "未找到 Node.js，请先安装 Node.js 18 或更高版本：https://nodejs.org" >&2
  exit 1
fi
if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)'; then
  echo "Node.js 版本过低（当前 $(node -v)），需要 18 或更高版本" >&2
  exit 1
fi
if ! command -v claude >/dev/null 2>&1; then
  echo "未找到 claude 命令，请先安装 Claude Code" >&2
  exit 1
fi

# 重新安装时先移除旧的注册
claude mcp remove browser-bridge -s user >/dev/null 2>&1 || true
claude mcp add browser-bridge -s user -- node "$SERVER"

cat <<EOF

MCP 服务已注册到 Claude Code。接下来：
  1. 打开 Chrome，进入 chrome://extensions，打开右上角的「开发者模式」
  2. 点「加载已解压的扩展程序」，选择目录：$DIR/extension
  3. 重启 Claude Code
EOF
