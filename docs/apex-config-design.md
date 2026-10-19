# Apex 配置工具 — 设计文档

> 备份 / 恢复 / 导出 / 分享 Apex Legends 本地设置（灵敏度、键位、画质等）。

## 1. 总体架构

```
┌─────────────────────┐        下载           ┌──────────────────────────┐
│  apex_cfg_tool.py   │◀──── /downloads/ ─────│  nginx(静态资源)          │
│  (桌面 CLI, Python)  │                       │  gzip + Cache-Control    │
└─────────┬───────────┘                       └────────────▲─────────────┘
          │ 读写                                            │ 浏览器
          ▼                                                │
┌─────────────────────┐        .apexcfg 文件上传           ┌──────────────────────────┐
│ %USERPROFILE%\Saved  │ ────────────────────────────────▶│ /api/apex/configs         │
│  Games/Respawn/Apex/ │                                   │  Express(requireAuth)     │
│  local/*.cfg|*.txt   │                                   └────────────┬─────────────┘
└─────────────────────┘                                                ▼
                                                        PostgreSQL(apex_configs 表)
```

- **桌面端（CLI）**：单文件 `apex_cfg_tool.py`，仅 Python 标准库，负责本地备份/恢复/导出/导入。逆向兼容：对配置文件做字节级快照，不解析语义即可完整还原。
- **网页端**：登录后的 `Apex 配置` 面板，供给侧览/搜索/发布/下载 `.apexcfg`。
- **服务端**：复用现有 JWT 鉴权，分享广场写入 `apex_configs` 表；列表接口不返回配置正文。

## 2. 配置定位与范围

| 项 | 值 |
|---|---|
| 主目录 | `%USERPROFILE%\Saved Games\Respawn\Apex\local\` |
| 备选 | `Documents\Respawn\Apex\local\`（含 OneDrive 重定向） |
| 收录后缀 | `.cfg`（键位/灵敏度）、`.txt`（画质 videoconfig）、`.ini` |
| 排除 | 超过 8MB 的文件、非配置文件（日志/崩溃转储天然不含） |
| 覆盖 | 允许 `--dir` 手动指定目录（应对自定义安装/极端情况） |

## 3. 数据格式

### 3.1 备份包（zip）

```
apex-backup-YYYYMMDD-HHMMSS.zip
├── manifest.json   # {kind, tool_version, created_at, fingerprint, files:[{name,size,sha256}]}
└── files/
    ├── settings.cfg
    └── videoconfig.txt
```

- `fingerprint` = 对 `name:sha256` 清单再取 sha256，用于**零变化跳过**（去重）。
- 恢复语义：只写入 manifest 中列出的文件，**不删除**包外文件；写前先对当前状态做安全包 `pre-restore-*.zip`。

### 3.2 分享文件 `.apexcfg`（JSON）

```json
{
  "kind": "apexcfg", "format": 1,
  "tool_version": "1.0.0",
  "game": "Apex Legends",
  "created_at": "2025-01-01T12:00:00+00:00",
  "label": "1.8 灵敏度 · 平底锅键位", "note": "微波炉压枪配置",
  "preview": { "sensitivity": {"mouse_sensitivity": "1.8"}, "video": {"setting.defaultres": "2560"}, "binds_count": 24, "files": ["settings.cfg"] },
  "files": { "settings.cfg": { "b64": "…", "sha256": "…" } }
}
```

- 文件正文 base64 + sha256 双保险：跨平台编码无所谓，传输后逐文件校验哈希。
- `preview` 供网页卡片直接渲染，**网页与数据库永不接触文件正文以外的大结构**（见性能设计）。

## 4. 功能设计

### 4.1 CLI

| 命令 | 说明 |
|---|---|
| `scan` | 定位候选配置目录，列出目录与文件 |
| `show` | 预览当前灵敏度/分辨率/键位条数 |
| `backup` | 快照打包 + 指纹去重 + 自动轮转（默认保留 20 份） |
| `list` | 列出本地备份（时间/文件数/大小/指纹） |
| `restore ZIP` | 恢复（自动安全包 → 逐文件校验写入 → 复检哈希） |
| `export` | 导出 `.apexcfg` 分享文件 |
| `import FILE` | 应用分享配置（先安全包 → 校验 → 原子写入） |

### 4.2 网页「Apex 配置」面板

1. **下载区**：一键下载 `apex_cfg_tool.py` + 命令速查。
2. **分享广场**：卡片列表（标题/作者/灵敏度摘要/文件数/时间/下载数），关键词搜索、分页加载更多。
3. **发布**：选择 `.apexcfg` 文件 → 前端校验 → 填标题备注 → 发布。
4. **下载卡片**：拉取详情接口获得 payload → 浏览器端生成 Blob 下载 → 同工具 `import` 应用。
5. **删除**：作者本人或管理员可删（与账号权限模型一致）。

## 5. 性能设计

### 5.1 桌面端

| 策略 | 效果 |
|---|---|
| 白名单后缀 + 指定目录扫描 | 单次快照只读几 KB~几百 KB，无全盘 IO |
| `fingerprint` 去重 | 配置没动时 `backup` 零写盘（<10ms 返回） |
| 流式 sha256（256KB chunk） | 常量内存，不整读文件 |
| 原子写（临时文件 + `os.replace`） | 断电/杀进程不产生半写损坏 |
| 轮转保留 N 份 | 备份目录不随时间膨胀 |

典型数据：`local/` 仅 `settings.cfg`(≈30KB) + `videoconfig.txt`(≈10KB)，一次备份 < 50ms（含哈希与 zip 压缩）。

### 5.2 服务端 / 数据库

| 策略 | 说明 |
|---|---|
| **列表不返回 payload** | `SELECT` 显式列（`payload TEXT` 是大字段），列表响应 < 5KB/页 |
| preview JSONB 摘要 | 卡片渲染零解码成本 |
| `LIMIT/OFFSET` 分页 | 默认 12、上限 50，`ORDER BY created_at DESC` 走索引 |
| 体积上限 | payload ≤ 512KB、单文件 ≤ 8MB、文件数 ≤ 64，拒绝异常大包 |
| 发布即重验 | 服务端重新 base64 解码 + sha256 比对，防止校验字段被篡改 |

### 5.3 前端

| 策略 | 说明 |
|---|---|
| 面板懒加载 | 首次点开「Apex 配置」才请求列表 API |
| 分页加载更多 | 不一次拉全量，滚动/点击增量渲染 |
| 搜索防抖 300ms | 输入期间不打接口 |
| 单次 innerHTML 拼接渲染 | 沿用站内模式，避免逐节点 reflow |
| gzip | nginx 对 JSON/JS/CSS 开 gzip（`gzip_types`），payload 类响应压缩率 >70% |
| 静态缓存 | `/downloads/` 1 天强缓存；文本正文 Blob 前端生成，无静态文件请求 |

## 6. 安全设计

- API 全部走现有 `requireAuth`（该站为团队私有站，登录后才见广场）。
- 发布/删除写 `audit_logs`（`apex_config_publish` / `apex_config_delete`）。
- 路径安全：`import`/`restore` 对包内文件名做净化（拒绝绝对路径、`..`、反斜杠、空段），从根上防 zip-slip / 路径穿越。
- 完整性：manifest↔zip 逐文件 sha256 校验，写盘后复检；不一致即报错退出。
- 前端渲染使用现有 `esc()` 转义，用户输入不进 HTML 上下文。
- 隐私提示：`settings.cfg`/`videoconfig.txt` 为纯游戏设置，分享前工具在 `show/scan` 时展示将上传的文件清单，用户可自行确认。

## 7. 目录与改动清单

```
web/public/downloads/apex_cfg_tool.py   # 新增: CLI 工具(下载页直链)
web/public/index.html                   # +Apex 配置面板
web/public/app.js                       # +分享广场逻辑(懒加载/分页/防抖/发布)
web/public/style.css                    # +面板样式
web/nginx.conf                          # +/downloads 下载头 + gzip
server/src/db.js                        # +apex_configs 表与索引
server/src/routes/apex-configs.js       # 新增: 列表/详情/发布/删除
server/src/index.js                     # 挂载路由 + JSON body 上限 1mb
docs/apex-config-design.md              # 本文档
```

## 8. 后续扩展路线

- **公共广场**：开放只读匿名浏览 + 队列审核；列表改游标分页（`created_at+id` keyset），`ILIKE` 换 `tsvector` 全文索引。
- **热度**：下载计数已有，可加收藏/点赞表 + `hot_score` 定时聚合。
- **一键应用**：工具增加 `import-from-url`，网页复制带 token 的命令直达。
- **Windows 包装**：PyInstaller 打包单 exe，网页出直链，免 Python 环境。
