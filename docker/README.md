# filament-manager · Docker 部署

单容器：一个 Node 进程同时托管前端页面（`web/filament-manager.html`）和 API。
浏览器直接访问 `http://<NAS_IP>:18787/`，不用再双击 HTML、不用再开 `.bat` 窗口。

库存数据存在容器的 `/data` 卷里，手机和电脑打开看到的是同一份。

默认配置已经按「国内网络 + NAS 与打印机同局域网」调好：
依赖走 npmmirror、alpine 源走阿里云、容器用 **host 网络**（自动搜索打印机可用）。

---

## 一、部署（绿联 DXP4800 Plus / 任意 Linux Docker）

```bash
# 在项目根目录执行（构建上下文是根目录，不是 docker/）
docker compose up -d --build
```

**`docker-compose.yml` 在项目根**（和 `server/`、`web/` 同一层），不在 `docker/` 里。
早期版本放在 `docker/` 下并写 `context: ..`，UGOS 界面部署会因此报
`resolve : lstat /volume2/.../docker: no such file or directory`——已挪到根目录根治。

或者在 UGOS 的 Docker 应用里「项目 / Compose → 新建」，**项目目录选项目根**，
也就是能直接看到 `server/`、`web/`、`docker-compose.yml` 的那一层（例如 `/volume2/V2Docker/Test/bambufilamentcolors`）。
选错层级就会报上面那个 lstat——见下面「项目根必须有这 11 个文件」。

首次构建约 1~3 分钟（拉基础镜像 + 装 3 个纯 JS 依赖）。

### 关于 host 网络（默认）

`network_mode: host` 是**自动搜索打印机的前提**，原因见第六节。两个副作用要知道：

- **端口不再隔离**：`PRINTER_AGENT_PORT` 的端口（**当前默认 `18787`**）直接开在 NAS 上。
  原来的 `8787` 在有些 UGOS 环境里已被占用，容器会启动失败并反复重启，日志报
  `端口 8787 已被占用` —— 所以默认值已换成 `18787`。再被占就继续往上换，
  先自查 `ss -lntp | grep 18787`。**换端口只需改 compose 里的这一个变量**，
  第 73 行的 `healthcheck` 用 `$$PRINTER_AGENT_PORT` 跟着走，不用改镜像。
- **不能再写 `ports`**：host 模式下无效，compose 会报配置冲突。文件里那段已注释掉。

### 验收

```bash
docker compose ps                                       # STATUS 应为 healthy
curl http://127.0.0.1:18787/api/health                   # {"ok":true,"store":"ok","net":{"ssdp":"ok"},...}
curl -I http://127.0.0.1:18787/                          # 200 + text/html
```

`net.ssdp` 是 `ok` 就说明这套网络模式下自动搜索可用，`degraded` 则是 bridge（收不到组播）。

再从**另一台电脑**开 `http://<NAS_IP>:18787/`。只在本机测是不够的——
UGOS 的防火墙/安全中心可能只放行特定端口段。

### 项目根必须有这些文件和目录（层级一个字都不能差）

```
<项目根>/                               ← UGOS 里选的容器项目目录必须是这一层
├── server/                             ← 后台服务，5 个 js
│   ├── printer-agent.js
│   ├── printer-cloud.js
│   ├── printer-slice.js
│   ├── printer-3mf.js
│   └── printer-store.js
├── web/
│   └── filament-manager.html           ← 483KB 的主程序
├── package.json
├── package-lock.json
├── docker-compose.yml                  ← 就是这个文件所在的层
├── .dockerignore                       ← 点文件，容易漏传
├── .npmrc                              ← 可选，本机构建加速用
└── docker/
    └── Dockerfile
```

`server/` 和 `web/` 两层目录名不能改：服务端用 `__dirname/..` 推项目根再找
`web/filament-manager.html`，改成扁平结构就得同时改代码和 Dockerfile。

一条命令自查，缺哪个会直接报 `No such file`：

```bash
cd /volume2/V2Docker/Test/bambufilamentcolors      # 换成你的实际路径
ls -l web/filament-manager.html \
      server/printer-agent.js server/printer-cloud.js server/printer-slice.js \
      server/printer-3mf.js server/printer-store.js \
      package.json package-lock.json docker-compose.yml docker/Dockerfile
```

更省事：直接跑自带的检查脚本，它会逐个核对**并且顺手生成一份绝对路径版 compose**
（`docker-compose.abs.yml`），用来绕开 UGOS 界面解析相对路径的问题：

```bash
sh /volume2/V2Docker/Test/bambufilamentcolors/docker/prepare-ugos.sh
```

输出全 `OK` 就说明目录结构没问题；有 `MISS` 就是文件没传全。它生成的
`docker-compose.abs.yml` 里 `context` / `dockerfile` 都是写死的绝对路径，
在 UGOS 界面里改用这个文件就不会再报 `lstat`。

> **主程序只有一个**：`web/filament-manager.html`（483KB）。早期的
> `bambu_filament_colors.html` 草稿已删除，不用再担心拿错文件。
> 如果你把它改名，`server/printer-agent.js` 顶部的 `WEB_PATH` 要跟着改（只此一处）。

### 构建报错对照

| 报错 | 真正的原因 | 处理 |
|---|---|---|
| `resolve : lstat .../docker: no such file or directory` | compose 不在项目根，`context` 解析到了别处 | 把 `docker-compose.yml` 放到项目根；或用绝对路径写 `context` / `dockerfile` |
| `failed to compute cache key: "/web/..." not found` 或页面 500「web/filament-manager.html 未找到」 | `web/` 目录没传全，或层级被压平了 | 按上面清单逐个 `ls`，确认是 `web/filament-manager.html` 而不是根目录下的裸文件 |
| `COPY failed: ... excluded by .dockerignore` | `.dockerignore` 里有 `*.html` 之类的通配把它排掉了 | 检查 `.dockerignore`，本项目只排 `*.md` 和测试脚本 |
| `Get "https://registry-1.docker.io/v2/": context deadline exceeded` | 基础镜像拉不到（国内网络） | 见第二节①，配镜像加速或 `NODE_IMAGE` |
| `pull access denied for filament-manager` | compose 里只剩 `image:` 没有 `build:`，且本地没这个镜像 | 补回 `build:` 段，或先 `docker save` / 导入镜像 |

---

## 二、国内加速（三处，都已配好）

构建慢基本卡在这三处，逐个说明改在哪、怎么改回去：

| 环节 | 默认行为 | 改在哪 |
|---|---|---|
| 基础镜像 `node:22-alpine` | Docker Hub，国内常 i/o timeout | compose → `build.args.NODE_IMAGE`，或 NAS 守护进程配 `registry-mirrors` |
| alpine 软件源 (`apk add tini tzdata`) | `dl-cdn.alpinelinux.org`，几十 KB/s | `Dockerfile` 已 `sed` 成 `mirrors.aliyun.com` |
| npm 依赖 | `registry.npmjs.org`，锁文件里全是原站 URL | `Dockerfile` → `ARG NPM_REGISTRY` + `--replace-registry-host=always` |

### ① 基础镜像

Docker Hub 直连不通时，在 compose 里取消这一行的注释再构建：

```yaml
build:
  args:
    NODE_IMAGE: docker.m.daocloud.io/library/node:22-alpine
```

**更彻底的做法**是在 NAS 的 Docker 守护进程里配镜像加速，对所有镜像生效：
UGOS Pro →「Docker」应用 → 设置 → 镜像加速 / Registry mirrors，填一个可用地址
（如 `https://docker.m.daocloud.io`），保存后重启 Docker 服务。这一步做了就不用改 compose。

### ② alpine 软件源

`Dockerfile` 里已经替换成阿里云：

```dockerfile
RUN sed -i 's#https\?://dl-cdn.alpinelinux.org#https://mirrors.aliyun.com#g; ...' /etc/apk/repositories
```

想换回官方源就把这行 `sed` 删掉。想用清华源就把 `mirrors.aliyun.com` 改成
`mirrors.tuna.tsinghua.edu.cn`（路径结构相同）。

### ③ npm 依赖

```dockerfile
ARG NPM_REGISTRY=https://registry.npmmirror.com
RUN npm ci --omit=dev --no-audit --no-fund \
      --registry="$NPM_REGISTRY" --replace-registry-host=always
```

两个事实（本机实测，不是照抄文档）：

- 当前 `package-lock.json` 里的 tarball 地址**已经是 `registry.npmmirror.com`**，
  所以这套仓库直接构建就走镜像。
- `--replace-registry-host=always` 是**兜底**，不是必需：npm 10（`node:22` 自带）默认值
  就是 `npmjs`，会自己把锁文件里 `registry.npmjs.org` 的域名换成你配置的 registry。
  显式写 `always` 是为了两种情况不出意外——① 基础镜像换成自带 npm 8/9 的（没有这个默认行为）；
  ② 有人用官方源重跑过 `npm install`，锁文件地址又变回 npmjs。

实测：全新缓存下 `npm ci --omit=dev` 装 46 个包 **13 秒**，请求全部落在
`registry.npmmirror.com` / `cdn.npmmirror.com`。

本机开发同样受益：项目根的 `.npmrc` 已把 registry 指向 npmmirror，
所以 `npm install` 拿测试依赖也是秒下。

---

## 三、首次使用的四件事

1. **打开页面**：`http://<NAS_IP>:18787/`
2. **添加打印机**：进打印机页会**自动搜索**局域网里的拓竹打印机。
   一台都没配时会自动把 IP + 序列号 + 名称填进表单（只搜到一台的情况），
   你只需要补 **LAN 访问码**（打印机屏幕：设置 → LAN Only 模式可查看）。
   访问码不在 SSDP 公告里，任何自动发现都拿不到，只能手填一次。
3. **登录拓竹云**：打印机页 →「拓竹云」卡片。第三方无 RFID 料盘的每次克重只能从云上取；
   token 存在 `/data/bambu-cloud.json`，登录一次即可。
4. **迁移旧数据**：在**旧浏览器**（`file://` 打开的那份）里「数据管理 → 导出 JSON 备份」，
   然后在新地址「导入 → 替换」。
   > 换地址 = 换 origin，localStorage 不会跟过去，必须走导出/导入。
   > 备份里的 accessCode 是空的（导出时抹掉了），打印机重新录入即可。

---

## 四、数据与备份

数据挂在**项目目录的 `data/`**（compose 里 `- ./data:/data`），容器里看到的是 `/data`。
一个键一个文件，直接可读：

| 文件 | 内容 | 丢了会怎样 |
|---|---|---|
| `store/filaments.json` | **库存**（最要紧的一个） | 库存没了 |
| `store/savedTags.json`<br>`store/trash.json`<br>`store/lowStockCfg.json` | 标签池 / 回收站 / 低库存阈值 | 对应功能回默认 |
| `store/prnSlotMatch.json`<br>`store/prnTagBind.json`<br>`store/prnTagArc.json`<br>`store/prnSlotHist.json` | 槽位匹配账本 / RFID 绑定与归档 / 槽位历史 | 换卷识别与自动匹配退化，需要重新绑一次 |
| `store/prnCalibLog.json`<br>`store/prnSlicedApply.json`<br>`store/prnSlicedSeen.json` | 校准流水 / 切片扣减流水 / 幂等索引 | 用量统计与扣减记录清零 |
| `store/swFavs.json` | 色卡收藏 | 收藏没了 |
| `store/_meta.json` | 各键版本号（**不含数据本体**） | 丢了会自动按数据文件重建索引 |
| `printer.config.json` | 打印机列表 + **明文 LAN 访问码** | 要重新加打印机 |
| `printer-history.json` | 任务用量历史（≤2MB） | 用量统计清零 |
| `bambu-cloud.json` | 拓竹云 token（0600） | 要重新登录（可能要收验证码） |
| `agent-token` | 本服务的访问令牌（0600） | 自动重新生成，已开着的页面要刷新 |

**完整备份 = 直接打包宿主机的 `data/`**，不用进容器（数据本来就在宿主机上）：

```bash
tar czf fm-data-$(date +%Y%m%d).tar.gz -C ./data .
```

迁移到另一台 NAS：把项目目录（含 `data/`）拷过去，`chown -R 1000:1000 ./data`，起容器即可。

> 从旧版本升级（数据还在命名卷 `fm-data` 里）：
> ```bash
> docker run --rm -v filament-manager_fm-data:/from -v "$PWD/data:/to" \
>   alpine sh -c 'cp -av /from/. /to/'
> ```
> 旧的单文件 `app-store.json` 会在启动时自动拆成 `store/*.json`，原文件改名
> `app-store.json.migrated-<时间戳>` 留底。

页面里「导出 JSON」只覆盖库存相关键，回收站和 RFID 绑定表不在里面；
想要服务端全量快照可以用 `curl http://127.0.0.1:18787/api/store/export`（需带令牌，见下），
想确认数据到底落在哪就用 `curl .../api/store?info=1`，或看页面「数据管理 → 数据存放位置」。

---

## 五、访问令牌（默认开启）

`FM_AUTH=on` 时，容器首次启动会生成随机令牌写到 `/data/agent-token`，并注入页面，
前端自动带上 `X-FM-Token`。同时**不再返回任何 CORS 头**，也就是跨源请求一律被浏览器拦掉。

挡的是两个真实风险：局域网里任意网页可以跨站 `DELETE /api/printers/:id` 删设备；
`POST /api/printers` 能填任意 host，等于内网 SSRF 探针。
host 网络下这份令牌更重要——服务直接暴露在 NAS 的 IP 上。

命令行调接口时手动带令牌：

```bash
TOKEN=$(docker exec filament-manager cat /data/agent-token)
curl -H "X-FM-Token: $TOKEN" http://127.0.0.1:18787/api/printers
```

`/api/health` 不需要令牌（Docker HEALTHCHECK 和前端探活要用）。
想彻底关掉就设 `FM_AUTH: "off"`——只建议确认只有自己能访问时用。

---

## 六、自动搜索打印机

**默认可用。** 靠的是 SSDP 被动监听：拓竹打印机每约 5 秒向
`239.255.255.250:2021` 发一条 NOTIFY 公告，服务收 8 秒就能拿到 IP / 序列号 / 型号 / 名称 / 固件版本。

三层自动行为：

1. **进打印机页自动搜**。一台都没配时每次进页都重试（60s 节流）；
   配好之后每会话只搜一次，纯粹当「后来有新机加入」的补充。
2. **只搜到一台且一台都没配 → 自动回填表单**（IP + 序列号 + 名称），你只差访问码。
3. **搜到多台 → 列表展示**，点「填入表单」选一台。

为什么必须是 host 网络：Docker 的 bridge 网络不会把局域网 UDP 组播泛洪进容器的 veth，
agent 能成功 bind 但永远收不到公告，表现为「搜到 0 台」——
文件里保留了这个降级路径：配 `FM_NET_MODE: bridge` 时页面会明确写「这是网络模式问题，
不是打印机没开机」，而不是让你去查打印机开没开。

搜不到时按这个顺序查：

1. 打印机的 LAN Only 模式开了吗（设置 → LAN Only 模式）；
2. NAS 和打印机在同一网段吗（跨 VLAN / 跨路由器需要设备支持组播转发；
   交换机开了 IGMP snooping 但网内没有 querier 时也会丢组播，试着把 NAS 和打印机接到同一台交换机）；
3. `docker exec filament-manager wget -qO- http://127.0.0.1:18787/api/health`
   看 `net.ssdp` 是不是 `ok`；
4. UDP 2021 是否被 NAS 上别的容器/服务占着（占了会返回 `PORT_BUSY`）；
5. NAS 的防火墙是否放行 **UDP 2021 入站**（host 模式下容器和 NAS 共用网络栈，
   UGOS 安全中心的规则一样会挡组播）；
6. 都不行就手填 IP + 序列号 + 访问码，功能完全一样。

> 想放弃自动搜索换回 bridge：删 `network_mode: host`，加 `ports: ["18787:18787"]`，
> `FM_NET_MODE` 改 `bridge`。文件末尾有完整注释块可直接抄。

---

## 七、排障

| 现象 | 原因 / 处理 |
|---|---|
| `docker build` 卡在 pulling / i/o timeout | 基础镜像拉不动，见第二节①：配 NAS 的 registry mirror 或换 `NODE_IMAGE` |
| `apk add` 卡住或超时 | alpine 源没换成功，`docker build --no-cache` 重来；确认 `sed` 那行还在 |
| `npm ci` 一直连 registry.npmjs.org | 少了 `--replace-registry-host=always`，锁文件把请求拽回原站了 |
| 打不开页面，`docker ps` 一直 restarting | `docker logs filament-manager`。先看 `PRINTER_AGENT_PORT` 的端口（默认 18787）是否被 NAS 上别的服务占用；再看 `/data` 是否可写（bind mount 没 `chown 1000:1000`） |
| 页面能开，但一直显示「服务未启动」 | 你在用**旧书签**指向 `file://`，或者 `PRINTER_AGENT_HOST` 被改回了 `127.0.0.1` |
| 所有 API 都 401 | `FM_AUTH=on` 但页面是旧缓存（没拿到令牌）。`Ctrl+F5` 强刷一次 |
| 每次重启都要重新登录拓竹云 | `/data/bambu-cloud.json` 写不进去（属主不对），或卷没挂上 |
| 库存改了但刷新又变回去 | 另一台设备/标签页同时改同一个键，页面会提示「另一台设备也改过」。刷新取服务端版本 |
| 打印机页离线 | 容器到 `192.168.x.x` 的 8883 不通。`docker exec filament-manager wget -O- http://<printer_ip>` 之类先确认路由 |
| 「搜索打印机」永远 0 台 | 见第六节；先确认 `net.ssdp` 不是 `degraded` |
| 打印完了没自动扣 | 看打印机页「切片用量流水」顶部有没有待归属警示条；没有的话确认拓竹云是否登录、任务是否云端下发 |

---

## 八、升级

```bash
docker compose up -d --build
```

项目目录下的 `data/` 是挂载点，重建镜像不丢数据。`store/_meta.json` 里带 `schema` 字段，
破坏性改动会在这个字段上升级并做迁移（v1 单文件 `app-store.json` → v2 `store/*.json` 是自动的）。

---

## 九、本地开发（不容器化）

和以前一样，双击 `start-printer-agent.bat`，或 `npm start`（= `node server/printer-agent.js`），
浏览器打开 `http://127.0.0.1:8787/`（也可以用 `file://` 直接开 `web/filament-manager.html`）。此时：

- 打开 `http://127.0.0.1:8787/` → 服务端注入快照 → **数据在项目 `data/store/`**，前端 localStorage 只是缓存
- 用 `file://` 双击 HTML → 不注入 → `FM.on === false` → 数据只在浏览器 localStorage，行为与改造前一致
  （这种模式下 `data/` 目录不会被读写，因为浏览器不能直接写磁盘）
- 不设 `FM_AUTH` → 无令牌、`Access-Control-Allow-Origin: *`、只监听 `127.0.0.1`
- 不设 `FM_NET_MODE` → 视为 `local`，自动搜索照常可用

改完代码跑测试：

```bash
npm install     # 只为跑测试（jsdom 是 devDependency，镜像里不装）；.npmrc 已指向 npmmirror
npm test        # 跑 tests/ 下 8 个套件：syntax + slice + cloud + store + inject + sync + smoke + calib
```

镜像里刻意 `--omit=dev`，所以测试不进镜像。要跑测试就挂着源码目录本地跑。
