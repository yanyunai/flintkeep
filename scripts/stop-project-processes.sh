#!/usr/bin/env bash
# 运行工作台的 stopCommand：关闭项目时，把该项目目录下的运行时进程全部清掉。
# 命中的不只是监听端口的那个进程，还包括外部启动的 Desktop/Electron、dev watcher、
# 构建子进程等；终端、编辑器、保险库自身不受影响。
#
# 用法：stop-project-processes.sh <项目绝对路径> [--dry-run]
set -u

target="${1:-}"
dry="${2:-}"
if [ -z "$target" ] || [ ! -d "$target" ]; then
  echo "项目目录不存在：$target" >&2
  exit 1
fi
root=$(cd "$target" && pwd -P)
self=$$
parent=$PPID

# 直接命中：命令行里带着项目绝对路径（Electron 主进程 / helper / 绝对路径起的 node）。
# 待校验：运行时命令带本项目的启动特征，但命令行是相对路径，需要再核对工作目录。
candidates=$(ps -eo pid=,command= | ROOT="$root" SELF="$self" PARENT="$parent" awk '
  function excluded(c) {
    return index(c, "flintkeep") > 0 || index(c, "mishiguanli") > 0 || index(c, "stop-project-processes") > 0 ||
           index(c, "CodeBuddy") > 0 || index(c, "Cursor.app") > 0 ||
           index(c, "/Applications/") > 0
  }
  {
    pid = $1; $1 = ""; cmd = $0
    if (pid == ENVIRON["SELF"] || pid == ENVIRON["PARENT"]) next
    if (excluded(cmd)) next
    if (index(cmd, ENVIRON["ROOT"]) > 0) { print pid "\tpath"; next }
    if (cmd ~ /apps\/cli\/src\/bin\.ts|scripts\/dev-web\.ts|tsx\/esm|dsh web|pnpm run (dev|start):web|pnpm dsh|build:artifacts|vite|esbuild|node_modules\/\.bin\/electron/)
      print pid "\tcwd"
  }')

pids=""
while IFS=$'\t' read -r pid kind; do
  [ -z "${pid:-}" ] && continue
  if [ "$kind" = "path" ]; then
    pids="$pids $pid"
    continue
  fi
  cwd=$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)
  case "$cwd" in
    "$root"|"$root"/*) pids="$pids $pid" ;;
  esac
done <<< "$candidates"

pids=$(printf '%s\n' $pids | sort -un | tr '\n' ' ')
if [ -z "${pids// /}" ]; then
  echo "没有属于 $root 的运行时进程"
  exit 0
fi

if [ "$dry" = "--dry-run" ]; then
  echo "[dry-run] 会关闭："
  for pid in $pids; do
    printf '  %s  %s\n' "$pid" "$(ps -o command= -p "$pid" 2>/dev/null | cut -c1-160)"
  done
  exit 0
fi

for pid in $pids; do kill -TERM "$pid" 2>/dev/null || true; done
sleep 2
for pid in $pids; do
  if kill -0 "$pid" 2>/dev/null; then kill -KILL "$pid" 2>/dev/null || true; fi
done

echo "已关闭项目进程：$(echo $pids | tr ' ' ',')"
exit 0
