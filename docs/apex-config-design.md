# Apex 配置工具 — 设计文档

> 备份 / 恢复 / 导出 / 分享 Apex Legends 本地设置（灵敏度、键位、画质等）。

## 1. 总体架构

```
┌─────────────────────┐        下载           ┌──────────────────────────┐
│  ApexConfigTool /    │◀──── /downloads/ ─────│  nginx(静态资源)          │
│  apex_cfg_tool.ps1   │                       │  gzip + Cache-Control    │
│  (GUI + CLI 双版本)   │                       │                          │
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

- **桌面端（Windows，三版本）**：图形版 `ApexConfigTool-win-x64.zip`（**Neutralino 轻量版 ~1.2MB**，系统自带 WebView2 渲染同一套全键值界面 + 筛选 + 分享广场 + 自绘无边框标题栏）；控制台版 `apex_cfg_tool.ps1`（PS 5.1+ 零依赖零编译，`Start.bat` 免安装菜单）；Python 版 `apex_cfg_tool.py`（单文件，3.8+，菜单/命令行双模式）。三版**引擎互通**：同一 `.apexcfg`(kind/format)、同一备份 manifest、同一安全包/指纹去重规则，逆向兼容：对配置文件做字节级快照，不解析语义即可完整还原。
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
- `preview` 供网页卡片直接渲染，**列表接口只带这份摘要**；`preview.file_pairs` 额外携带每文件全部键值行（单文件上限 800 行、键 80 字符、值 120 字符）。
- 网页卡片「明细」在点击时调用详情接口解码 payload 正文，按 键位(bind) / 灵敏度(sens) / 其他设置 / 画质(videoconfig) 分组全量展示——不增加列表流量，也不改数据库结构。

## 4. 功能设计

### 4.1 桌面工具（Windows）

**图形版（推荐）**：解压 `ApexConfigTool-win-x64.zip` → 运行 `ApexConfigTool.exe`。三个页签：
- **本地配置**：每个文件的全部键值逐行展示（文件/分组/键/值），分组为 键位(bind)/灵敏度(sens)/画质(videoconfig)/其他，关键字实时筛选；
- **备份与恢复**：一键备份（指纹去重 + 轮转）+ 列表选中恢复（自动安全包）；
- **分享广场**：导出 `.apexcfg`（另存为对话框）、导入应用（自动安全包 + 校验）。
- **分享广场（接入 LetsLogin 服务端）**：登录（JWT）后可浏览/搜索广场、查看配置全量键值明细、一键导入（`?count=1` 计下载）、保存 .apexcfg、发布当前配置、删除自己的分享；HTTP 均在主进程发起（无 CORS），导入走与本地相同的校验/安全包管线。
- **自绘标题栏**：`frame:false` 隐藏系统最小化/最大化/关闭按钮，改为自绘控件（`-webkit-app-region: drag` 拖拽区 + `thickFrame` 保留缩放边缘）。
Node 主进程（`apex-config-gui/backend.js`）与 PowerShell 版行为逐条对齐，可用 `node test/backend.test.js` 独立回归。

**控制台版**：双击 `Start.bat` 进入菜单；命令行 `-Action` 参数与菜单等价，便于脚本化：

| 菜单 / -Action | 说明 |
|---|---|
| `[1] backup` | 快照打包 + 指纹去重 + 自动轮转（默认保留 20 份） |
| `[2] list` | 列出本地备份（时间/文件数/大小/指纹） |
| `[3] restore ZIP` | 恢复（自动安全包 → 逐文件校验写入 → 复检哈希） |
| `[4] export` | 导出 `.apexcfg` 分享文件 |
| `[5] import FILE` | 应用分享配置（先安全包 → 校验 → 原子写入） |
| `[6] show` | 预览当前灵敏度/分辨率/键位条数 |
| `[7] scan` | 定位候选配置目录，列出文件 |

实现注意：脚本保存为 UTF-8 **带 BOM**（Windows PowerShell 5.1 无 BOM 会把中文按 ANSI 解析成乱码）；仅使用 PS5.1 可用语法（`-in`、`[ordered]`、`::new()`，不用 `??`/三元等 PS7 才有的特性），zip 操作走 `System.IO.Compression`。此前 PyInstaller 编译 exe 的链路（CI 构建 `apex_cfg_tool.exe`）已下线，不再需要任何编译步骤。

### 4.2 网页「Apex 配置」面板

1. **下载区**：图形版 `ApexConfigTool-win-x64.zip`（主按钮）+ 控制台版 `ApexCfgTool-win.zip`（含 Start.bat / apex_cfg_tool.ps1 / 使用说明）+ 单文件 .ps1 直链。
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
apex-config-gui/                        # 新增: 图形版源码(main/backend/preload/renderer/test)
web/public/downloads/apex_cfg_tool.ps1  # 控制台工具(菜单+参数, 零依赖)
web/public/downloads/Start.bat          # 菜单启动器(绕过执行策略)
web/public/downloads/使用说明.txt        # 面向使用者的说明
web/public/downloads/ApexCfgTool-win.zip # 控制台版打包直链
web/public/downloads/ApexConfigTool-win-x64.zip # 图形版(Neutralino 轻量, win x64)直链
web/public/index.html                   # +Apex 配置面板
web/public/app.js                       # +分享广场逻辑(懒加载/分页/防抖/发布/明细解码)
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
- **桌面端**：轻量图形版已落地（`apex-config-lite/`，Neutralino v6：`neu build` 产出 `ApexConfigTool-win_x64.exe`(2.4MB)+`resources.neu`，直链同仓库 Releases；Electron 版 `apex-config-gui/` 源码保留、不再随包发布——158MB 包体被 WebView2 方案替代）。曾评估 WPF（系统自带但观感陈旧）与 WinUI3（需 .NET SDK + Windows App SDK 打包，违背免安装）与 Electron（功能完整但 158MB 过大）。轻量版引擎为纯 JS（`resources/src/engine.js`，存储/哈希/zip 由适配器注入：浏览器=Neutralino fs+WebCrypto+fflate，Node 自测=fs/promises+crypto+fflate），11 项行为测试与 Python 版 10 项、PS1 版全绿。后续可为 exe 代码签名以消除 SmartScreen 提示。
