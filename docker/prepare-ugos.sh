#!/bin/sh
# ──────────────────────────────────────────────────────────────────────
# UGOS 界面部署辅助脚本（POSIX sh，busybox 也能跑）
#
# 用法（在 NAS 上任意目录执行都行）：
#   sh /volume2/V2Docker/Test/bambufilamentcolors/docker/prepare-ugos.sh
#
# 它做两件事：
#   ① 逐个核对「项目根必须有」的文件，缺哪个直接告诉你
#   ② 生成一份把 context / dockerfile 写成绝对路径的 compose，
#      彻底绕开 UGOS 界面解析相对路径时指错目录的问题
#
# 为什么要绝对路径：compose 里的 context: . 是相对【compose 文件所在目录】的。
# UGOS 界面会把 compose 存进它自己的项目目录，一旦那个目录不是项目根，
# . 就指错地方，报 resolve : lstat .../docker: no such file or directory。
# ──────────────────────────────────────────────────────────────────────
set -e

SELF_DIR=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$SELF_DIR/.." && pwd)

echo "项目根（脚本推算）：$ROOT"
echo ""

miss=0
for f in \
  web/filament-manager.html \
  server/printer-agent.js \
  server/printer-cloud.js \
  server/printer-slice.js \
  server/printer-3mf.js \
  server/printer-store.js \
  package.json \
  package-lock.json \
  docker-compose.yml \
  docker/Dockerfile
do
  if [ -f "$ROOT/$f" ]; then
    printf '  OK   %s\n' "$f"
  else
    printf '  MISS %s\n' "$f"
    miss=1
  fi
done

# .dockerignore 只是拖慢构建，缺了不致命，单独提示
if [ -f "$ROOT/.dockerignore" ]; then
  printf '  OK   %s\n' ".dockerignore"
else
  printf '  NOTE %s（建议补上，否则构建上下文会把 node_modules 一起打包）\n' ".dockerignore"
fi

if [ "$miss" != 0 ]; then
  echo ""
  echo "❌ 有必需文件缺失。"
  echo "   最常见的原因：只把 docker/ 子目录传上来了，项目根没传全。"
  echo "   请把整个项目根（能看到 server/ web/ docker-compose.yml 的那一层）复制到："
  echo "     $ROOT"
  exit 1
fi

OUT="$ROOT/docker-compose.abs.yml"
sed -e "s#^      context: .*#      context: $ROOT#" \
    -e "s#^      dockerfile: .*#      dockerfile: $ROOT/docker/Dockerfile#" \
    "$ROOT/docker-compose.yml" > "$OUT"

echo ""
echo "✅ 文件齐全，已生成：$OUT"
echo "   （context 写死为 $ROOT）"
echo ""
echo "在 UGOS 界面里改用这个文件；或者直接命令行构建："
echo "  cd \"$ROOT\" && docker compose -f docker-compose.abs.yml up -d --build"
