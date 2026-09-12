# LetsLogin — 团队密码管理

一个自托管的团队密码管理器：集中托管网站/服务账号密码与 2FA，支持基于可见性的共享、占用式会话和完整审计。

- **后端** Node.js + Express + PostgreSQL，JWT 认证
- **前端** 静态单页应用，由 nginx 提供并反代 API
- **安全** 密码与 2FA Secret 用 AES-256-GCM 加密落库；改密/重置密码即吊销旧 JWT

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

## 目录结构

```
.
├── docker-compose.yml      # 编排 db / server / web
├── .env                    # 密钥(不入库)
├── server/                 # 后端
│   └── src/
│       ├── index.js        # 入口
│       ├── config.js       # 配置校验
│       ├── db.js           # 连接池 / 迁移 / 审计
│       ├── auth.js         # JWT 签发与鉴权(含吊销校验)
│       ├── crypto.js       # AES-256-GCM
│       ├── totp.js         # TOTP 动态码
│       └── routes/         # auth / users / accounts
└── web/                    # 前端(nginx)
    └── public/             # index.html / app.js / style.css
```