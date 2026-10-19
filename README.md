# LetsLogin — 团队密码管理

一个自托管的团队密码管理器：集中托管网站/服务账号密码与 2FA，支持基于可见性的共享、占用式会话和完整审计。

- **后端** Node.js + Express + PostgreSQL，JWT 认证
- **前端** 静态单页应用，由 nginx 提供并反代 API
- **安全** 密码与 2FA Secret 用 AES-256-GCM 加密落库；改密/重置密码即吊销旧 JWT
- **Apex** 内置 Apex 地图轮换查询与本地配置备份/分享工具

## 技术栈

| 层 | 技术 |
|---|---|
| 前端 | 原生 HTML/CSS/JS + nginx 1.27 |
| 后端 | Node 20 / Express 4 / jsonwebtoken / bcryptjs / otplib / pg |
| 数据库 | PostgreSQL 16 |

## 快速开始

前置要求：已安装 Docker 与 Docker Compose。

```bash
# 1. 生成密钥并写入 .env(内容自动被 .gitignore 忽略)
JWT_SECRET=$(openssl rand -hex 32)
SECRETS_KEY=$(openssl rand -hex 32)
printf 'JWT_SECRET=%s\nSECRETS_KEY=%s\nADMIN_INITIAL_PASSWORD=admin123\n' "$JWT_SECRET" "$SECRETS_KEY" > .env

# 2. 构建并启动(首次会拉取镜像,稍慢)
docker compose up -d --build

# 3. 打开
open http://localhost:8080
```

默认管理员：用户名 `admin`，密码 `ADMIN_INITIAL_PASSWORD`（默认 `admin123`）。
首次登录会**强制改密**，改密后旧 JWT 立即失效。

> **务必修改初始密码`admin123`,并保管好 `.env` 中的 `SECRETS_KEY`** —— 丢失它意味着已存账号密码无法解密。

## 环境变量 (.env)

| 变量 | 必填 | 说明 |
|---|---|---|
| `JWT_SECRET` | ✅ | JWT 签名密钥,`openssl rand -hex 32` |
| `SECRETS_KEY` | ✅ | AES-256-GCM 加密密钥,必须为 64 个 hex 字符(`openssl rand -hex 32`) |
| `ADMIN_INITIAL_PASSWORD` | 否 | 初始管理员密码,默认 `admin123` |
| `PORT` / `DATABASE_URL` / `SESSION_TIMEOUT_MINUTES` | 否 | 见 `server/src/config.js` |
| `APEX_API_KEY` | 否 | apexstatus 免费 key([apexlegendsstatus.com](https://apexlegendsstatus.com) 注册),用于 Apex 地图轮换页的官方实时数据;未配置时按标准轮换周期本地推算(赛季更替需更新 `server/src/apex.js` 中的地图池) |

## 常用命令

```bash
docker compose ps                      # 查看服务状态
docker compose logs -f server          # 后端日志
docker compose exec db psql -U letslogin -d letslogin   # 进入数据库
docker compose down                    # 停止
docker compose down -v                 # 停止并清空数据卷
```

## 功能与权限模型

- **账号三种可见性**：`私有`(仅本人) / `全员` / `指定成员`(通过共享列表)
- **权限**：本人或管理员可写入；读取需本人、管理员、全员可见或有共享
- **会话占用**：签出(开始占用)→同一账号同时仅一人可用→签入(结束占用)
- **审计日志**：登录、增删改账号、查看密文、会话起止均记录 `audit_logs`

## Apex 配置工具（备份 / 恢复 / 分享）

登录后进入「Apex 配置」面板，下载单文件工具 `apex_cfg_tool.py`（仅需 Python 3.8+，零第三方依赖），集中管理 Apex Legends 本地配置——灵敏度、键位、画质等均**字节级备份**，不依赖解析格式：

```powershell
python apex_cfg_tool.py scan                           # 定位配置目录(Saved Games\Respawn\Apex\local)
python apex_cfg_tool.py backup                         # 备份(指纹去重+自动轮转,默认保留 20 份)
python apex_cfg_tool.py list                           # 查看备份列表
python apex_cfg_tool.py restore apex-backup-XXXX.zip   # 恢复(恢复前自动为当前状态打安全包)
python apex_cfg_tool.py export -o 我的配置.apexcfg       # 导出可分享配置(含灵敏度预览)
python apex_cfg_tool.py import 队友配置.apexcfg          # 应用他人配置(同样先打安全包)
```

- 安全性：逐文件 sha256 校验、原子写入、包内文件名防路径穿越；服务端发布时会重新校验 base64/哈希
- 网页「分享广场」支持标题/备注/灵敏度摘要搜索与分页浏览；配置正文仅在点击下载时拉取（列表接口不传 payload）
- 详细设计与性能方案见 [docs/apex-config-design.md](docs/apex-config-design.md)

## API 一览

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/auth/login` | 登录,返回 JWT |
| POST | `/api/auth/change-password` | 改密(同时吊销旧 token) |
| GET | `/api/auth/me` | 当前用户 |
| GET/POST | `/api/accounts` | 账号列表 / 新建 |
| GET/PATCH/DELETE | `/api/accounts/:id` | 查看(解密)/修改/删除 |
| POST | `/api/accounts/:id/sessions` | 签出(占用) |
| POST | `/api/accounts/:id/sessions/end` | 签入 |
| GET/POST | `/api/users` | (管理员)用户管理 |
| GET | `/api/apex/maprotation` | Apex 当前地图轮换与下场轮换倒计时 |
| GET | `/api/apex/configs` | Apex 配置分享列表(分页/搜索,不含配置正文) |
| GET | `/api/apex/configs/:id` | 配置详情(含 `.apexcfg` 正文;`?count=1` 计一次下载) |
| POST | `/api/apex/configs` | 发布配置(服务端全量校验文件名/base64/sha256) |
| DELETE | `/api/apex/configs/:id` | 删除配置(本人或管理员) |

## 目录结构

```
.
├── docker-compose.yml        # 编排 db / server / web
├── .env                      # 密钥(不入库)
├── docs/
│   └── apex-config-design.md # Apex 配置工具设计文档
├── server/                   # 后端
│   └── src/
│       ├── index.js          # 入口
│       ├── config.js         # 配置校验
│       ├── db.js             # 连接池 / 迁移(含 apex_configs 表) / 审计
│       ├── auth.js           # JWT 签发与鉴权(含吊销校验)
│       ├── crypto.js         # AES-256-GCM
│       ├── totp.js           # TOTP 动态码
│       ├── apex.js           # Apex 地图轮换数据
│       └── routes/           # auth / users / accounts / apex / apex-configs
└── web/                      # 前端(nginx)
    └── public/
        ├── index.html / app.js / style.css
        └── downloads/        # apex_cfg_tool.py 工具直链
```
