import { Router } from 'express'
import { createHash } from 'node:crypto'
import { pool, audit } from '../db.js'
import { requireAuth } from '../auth.js'

// Apex 配置分享广场:列表只出摘要,正文(.apexcfg JSON)仅详情接口返回
// 权限约定:所有已登录用户(普通用户与管理员同等)均可发布配置;删除仅限本人或管理员
const r = Router()
r.use(requireAuth)

// 发布限流:每账号每小时 12 次(单容器自托管,内存计数即可);管理员不受限
const PUBLISH_WINDOW_MS = 60 * 60 * 1000
const PUBLISH_MAX_PER_WINDOW = 12
const publishLog = new Map() // userId -> { count, windowStart }

function publishRateLimited(userId) {
  const now = Date.now()
  const rec = publishLog.get(userId)
  if (!rec || now - rec.windowStart > PUBLISH_WINDOW_MS) {
    publishLog.set(userId, { count: 1, windowStart: now })
    return false
  }
  rec.count += 1
  // 顺手清理过期窗口记录, 防止 Map 无限膨胀
  if (publishLog.size > 2000) {
    for (const [k, v] of publishLog) {
      if (now - v.windowStart > PUBLISH_WINDOW_MS) publishLog.delete(k)
    }
  }
  return rec.count > PUBLISH_MAX_PER_WINDOW
}

const MAX_PAYLOAD_BYTES = 512 * 1024      // 入库正文上限(JSON 文本, base64 后配置通常 < 200KB)
const MAX_DECODED_TOTAL = 32 * 1024 * 1024
const MAX_FILE_BYTES = 8 * 1024 * 1024
const MAX_FILES = 64
const ALLOWED_SUFFIXES = new Set(['.cfg', '.txt', '.ini'])
const TITLE_MAX = 60
const NOTES_MAX = 300
const PAGE_DEFAULT = 12
const PAGE_MAX = 50

const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/

// 拒绝路径穿越/绝对路径/过深层级
function safeConfigName(name) {
  if (typeof name !== 'string' || !name || name.includes('\0') || name.startsWith('/')) return false
  const parts = name.split('/')
  if (parts.length > 4 || parts.some(p => !p || p === '.' || p === '..')) return false
  const dot = name.lastIndexOf('.')
  return dot > 0 && ALLOWED_SUFFIXES.has(name.slice(dot).toLowerCase())
}

// preview 只保留卡片渲染需要的已知字段并截断, 防止超大对象进 JSONB
function cleanPreview(src) {
  const out = {}
  if (!src || typeof src !== 'object') return out
  const pickMap = (value, keyMax, valMax, countMax) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    return Object.fromEntries(
      Object.entries(value).slice(0, countMax).map(([k, v]) => [String(k).slice(0, keyMax), String(v).slice(0, valMax)])
    )
  }
  const sens = pickMap(src.sensitivity, 48, 32, 12)
  if (sens) out.sensitivity = sens
  const video = pickMap(src.video, 48, 40, 10)
  if (video) out.video = video
  if (Number.isFinite(Number(src.binds_count))) out.binds_count = Math.trunc(Number(src.binds_count))
  return out
}

function validateAndNormalizePayload(rawText) {
  let parsed
  try { parsed = JSON.parse(rawText) } catch { throw new Error('配置文件不是有效 JSON') }
  if (!parsed || parsed.kind !== 'apexcfg' || parsed.format !== 1) {
    throw new Error('不支持的配置格式(kind/format 不符), 请更新工具后重新导出')
  }
  const files = parsed.files
  if (!files || typeof files !== 'object' || Array.isArray(files) || Object.keys(files).length === 0) {
    throw new Error('配置中没有任何文件内容')
  }
  const names = Object.keys(files)
  if (names.length > MAX_FILES) throw new Error(`文件数量超过上限 ${MAX_FILES}`)

  let total = 0
  for (const name of names) {
    if (!safeConfigName(name)) throw new Error(`不支持的文件名: ${name}`)
    const meta = files[name]
    if (!meta || typeof meta !== 'object' || typeof meta.b64 !== 'string') {
      throw new Error(`文件 ${name} 缺少 base64 内容`)
    }
    if (!B64_RE.test(meta.b64)) throw new Error(`文件 ${name} 的内容不是有效 base64`)
    const decoded = Buffer.from(meta.b64, 'base64')
    if (decoded.length > MAX_FILE_BYTES) throw new Error(`文件 ${name} 超过单文件 8MB 上限`)
    total += decoded.length
    if (total > MAX_DECODED_TOTAL) throw new Error('配置解码后总体积过大')
    // 服务端重新计算哈希, 不信任上传方自带的 sha256 字段
    if (typeof meta.sha256 === 'string' &&
        meta.sha256.toLowerCase() !== createHash('sha256').update(decoded).digest('hex')) {
      throw new Error(`文件 ${name} 哈希校验失败, 内容可能被篡改`)
    }
  }
  return { fileCount: names.length, preview: cleanPreview(parsed.preview), compact: JSON.stringify(parsed) }
}

// 列表(分页 + 关键词搜索):显式列名, 绝不返回 payload 大字段
// 用 LIMIT+1 探测下一页, 省一条 COUNT(*) 查询
r.get('/', async (req, res) => {
  const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || PAGE_DEFAULT, 1), PAGE_MAX)
  const offset = Math.max(Number.parseInt(req.query.offset, 10) || 0, 0)
  const search = String(req.query.search || '').trim().slice(0, 60)

  const conditions = []
  const params = []
  if (search) {
    params.push(`%${search.replace(/[\\%_]/g, m => '\\' + m)}%`)
    const p = `$${params.length}`
    conditions.push(`(a.title ILIKE ${p} ESCAPE '\\' OR a.notes ILIKE ${p} ESCAPE '\\' OR a.preview::text ILIKE ${p} ESCAPE '\\')`)
  }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''

  const { rows } = await pool.query(
    `SELECT a.id, a.title, a.notes, a.preview, a.file_count, a.payload_bytes,
            a.downloads, a.user_id, u.username AS author, a.created_at
     FROM apex_configs a JOIN users u ON u.id = a.user_id
     ${where}
     ORDER BY a.created_at DESC
     LIMIT ${limit + 1} OFFSET ${offset}`,
    params
  )
  res.json({ configs: rows.slice(0, limit), hasMore: rows.length > limit })
})

// 详情:含正文 payload;前端「下载」动作带 ?count=1 以下载次数
r.get('/:id', async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isInteger(id)) return res.status(400).json({ error: '无效的 id' })
  const { rows } = await pool.query(
    `SELECT a.id, a.title, a.notes, a.preview, a.payload, a.payload_bytes, a.file_count,
            a.downloads, a.user_id, u.username AS author, a.created_at
     FROM apex_configs a JOIN users u ON u.id = a.user_id
     WHERE a.id = $1`, [id])
  if (!rows[0]) return res.status(404).json({ error: '配置不存在' })
  const config = rows[0]
  if (req.query.count === '1') {
    await pool.query('UPDATE apex_configs SET downloads = downloads + 1 WHERE id = $1', [id])
    config.downloads += 1
  }
  res.json({ config })
})

// 发布:任何已登录用户都可发布(无角色门槛);服务端全量重新校验(格式/文件名/base64/sha256),正文压缩重序列化后入库
r.post('/', async (req, res) => {
  if (req.user.role !== 'admin' && publishRateLimited(req.user.id)) {
    return res.status(429).json({ error: `发布过于频繁(每小时最多 ${PUBLISH_MAX_PER_WINDOW} 次), 请稍后再试` })
  }
  const body = req.body || {}
  const title = (typeof body.title === 'string' ? body.title : '').trim()
  const notes = (typeof body.notes === 'string' ? body.notes : '').trim()
  if (!title || title.length > TITLE_MAX) {
    return res.status(400).json({ error: `标题必填且不超过 ${TITLE_MAX} 字` })
  }
  if (notes.length > NOTES_MAX) {
    return res.status(400).json({ error: `备注不超过 ${NOTES_MAX} 字` })
  }
  const rawPayload = typeof body.payload === 'string' ? body.payload : ''
  if (!rawPayload) return res.status(400).json({ error: '缺少配置内容 payload' })
  if (Buffer.byteLength(rawPayload, 'utf8') > MAX_PAYLOAD_BYTES) {
    return res.status(400).json({ error: '配置内容超过 512KB, 请精简后再分享' })
  }

  let normalized
  try { normalized = validateAndNormalizePayload(rawPayload) } catch (err) {
    return res.status(400).json({ error: err.message })
  }

  const { rows } = await pool.query(
    `INSERT INTO apex_configs (user_id, title, notes, preview, payload, payload_bytes, file_count)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [req.user.id, title, notes, JSON.stringify(normalized.preview), normalized.compact,
     Buffer.byteLength(normalized.compact, 'utf8'), normalized.fileCount]
  )
  const id = rows[0].id
  await audit(req.user.id, 'apex_config_publish', `apex_config:${id}`, { file_count: normalized.fileCount })
  res.status(201).json({ id, fileCount: normalized.fileCount })
})

// 删除:仅本人或管理员
// 先校验归属再删除 —— 绝不能先 DELETE 后判权限, 否则越权请求虽返回 403 但数据已被删掉
r.delete('/:id', async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isInteger(id)) return res.status(400).json({ error: '无效的 id' })
  const { rows } = await pool.query('SELECT user_id FROM apex_configs WHERE id = $1', [id])
  if (!rows[0]) return res.status(404).json({ error: '配置不存在' })
  if (rows[0].user_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: '只能删除自己分享的配置' })
  }
  const del = await pool.query('DELETE FROM apex_configs WHERE id = $1 RETURNING id', [id])
  if (!del.rows[0]) return res.status(404).json({ error: '配置不存在' })
  await audit(req.user.id, 'apex_config_delete', `apex_config:${id}`)
  res.json({ ok: true })
})

export default r
