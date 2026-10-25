# syntax=docker/dockerfile:1
#
# filament-manager 单容器镜像：一个 Node 进程同时托管页面和 API。
#
# 构建上下文是【项目根】，不是本目录：
#   docker build -f docker/Dockerfile -t filament-manager:2 .
# 或者直接用项目根的 compose（context 就是 . ，不再靠 .. 猜层级）：
#   docker compose up -d --build
#
# 为什么不在 build 里 COPY 整个目录：printer.config.json 里有明文 LAN 访问码、
# bambu-cloud.json 里有拓竹云 token，这些属于用户数据，必须走 /data 卷而不是镜像层。
# 根目录的 .dockerignore 已经把这两个排除掉了。

# ── 国内加速 ①：基础镜像走加速站 ──
# Docker Hub 在国内经常拉不动（i/o timeout / TLS handshake）。
# 三种用法（任选，arg 不改也能构建，只是慢）：
#   docker build --build-arg NODE_IMAGE=docker.m.daocloud.io/library/node:22-alpine ...
#   docker build --build-arg NODE_IMAGE=dockerproxy.net/library/node:22-alpine ...
# 更彻底的办法是在 NAS 的 Docker 守护进程里配 registry-mirrors（见 README「国内加速」）。
ARG NODE_IMAGE=node:22-alpine
FROM ${NODE_IMAGE}

# ── 国内加速 ②：alpine 软件源换阿里云 ──
# 默认的 dl-cdn.alpinelinux.org 在国内经常几十 KB/s，装 tini+tzdata 能卡一分钟。
# 用 # 当分隔符避免 URL 里的 / 冲突；两代 alpine 的源文件域名不同，两条都替换。
#
# tini：PID 1 收信号 + 回收僵尸进程（agent 自己处理 SIGTERM，但仍交给 init 更稳）
# tzdata：alpine 的 musl 不带 zoneinfo，不装的话 TZ=Asia/Shanghai 只对 UTC 生效
RUN sed -i 's#https\?://dl-cdn.alpinelinux.org#https://mirrors.aliyun.com#g; s#https\?://mirror.aarnet.edu.au#https://mirrors.aliyun.com#g' /etc/apk/repositories \
 && apk add --no-cache tini tzdata

ENV NODE_ENV=production \
    TZ=Asia/Shanghai \
    PRINTER_AGENT_DIR=/data \
    PRINTER_AGENT_HOST=0.0.0.0 \
    PRINTER_AGENT_PORT=8787

WORKDIR /app

# 只装运行期依赖。mqtt 是硬依赖；basic-ftp / fflate 缺失只会关掉「本地 3mf」那条路。
#
# ── 国内加速 ③：npm 走 npmmirror ──
# 关于 --replace-registry-host=always（实测结论，不是猜的）：
#   · npm 10（node:22 自带）的默认值就是 npmjs，会自己把锁文件里 npmjs 的域名换成
#     你配置的 registry —— 所以只写 --registry 在 node:22 下通常也能走镜像。
#   · 显式写 always 是为了两个兜底场景：① 基础镜像哪天换成自带 npm 8/9 的（没有这个默认行为）；
#     ② 有人用官方源重跑过 npm install，锁文件里的 tarball 地址又变回 registry.npmjs.org。
#   两种情况都会让构建悄悄重新卡在 npmjs 上，写死了就不用再排查。
ARG NPM_REGISTRY=https://registry.npmmirror.com
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev --no-audit --no-fund \
        --registry="$NPM_REGISTRY" --replace-registry-host=always; \
    else \
      npm install --omit=dev --no-audit --no-fund \
        --registry="$NPM_REGISTRY" --replace-registry-host=always; \
    fi \
 && npm cache clean --force

# 目录结构必须和仓库一致（服务端代码靠 __dirname/.. 找 web/）：
#   server/  5 个 js   ← printer-slice 会 require ./printer-3mf，
#                        printer-agent 懒加载 ./printer-cloud / ./printer-slice / ./printer-store
#   web/     单文件应用（由 server 托管，缺了就是 500）
# 少任何一个都只是「功能降级」或 500，不会在构建期报错，所以两行都写成整目录 COPY。
COPY server/ ./server/
COPY web/ ./web/

# 预建 /data 并给 node 属主：命名卷首次挂载会继承这个属主，
# 免掉 UGOS/NAS 上最常见的 "EACCES: /data/printer.config.json.tmp"。
RUN mkdir -p /data && chown -R node:node /app /data

USER node
EXPOSE 8787
VOLUME ["/data"]

# health 在打印机离线时仍返回 200 —— healthy 只代表「服务活着」，不代表打印机在线
#
# 端口不要写死：compose 里可能把 PRINTER_AGENT_PORT 换成 18787（8787 被 NAS 上
# 别的服务占了）。用 ${PRINTER_AGENT_PORT:-8787} 让健康检查跟着环境变量走，
# 否则端口一换，服务明明活着却永远显示 unhealthy，排障时特别误导。
# 这是 shell 形式（不是 JSON 数组），运行期才展开，所以变量能生效。
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PRINTER_AGENT_PORT:-8787}/api/health" >/dev/null 2>&1 || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server/printer-agent.js"]
