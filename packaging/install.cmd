@echo off
rem 把 Browser Bridge 的 MCP 服务注册到 Claude Code（用户级，所有项目都可用）
chcp 65001 >nul
setlocal
set "DIR=%~dp0"
set "SERVER=%DIR%mcp\browser-bridge-mcp.mjs"

where node >nul 2>nul
if errorlevel 1 (
  echo 未找到 Node.js，请先安装 Node.js 18 或更高版本：https://nodejs.org
  goto :end
)
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 18 ? 0 : 1)"
if errorlevel 1 (
  echo Node.js 版本过低，需要 18 或更高版本
  goto :end
)
where claude >nul 2>nul
if errorlevel 1 (
  echo 未找到 claude 命令，请先安装 Claude Code
  goto :end
)

rem 重新安装时先移除旧的注册
call claude mcp remove browser-bridge -s user >nul 2>nul
call claude mcp add browser-bridge -s user -- node "%SERVER%"

echo.
echo MCP 服务已注册到 Claude Code。接下来：
echo   1. 打开 Chrome，进入 chrome://extensions，打开右上角的「开发者模式」
echo   2. 点「加载已解压的扩展程序」，选择目录：%DIR%extension
echo   3. 重启 Claude Code

:end
echo.
pause
