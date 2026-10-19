import { Router } from 'express'
import crypto from 'node:crypto'
import { pool, audit } from '../db.js'
import { requireAuth } from '../auth.js'
import { smtpConfigured, sendInviteMail } from '../mailer.js'

const r = Router()
r.use(requireAuth)

// 码表:32 字符,剔除肉眼易混的 I L O 0 1,4-4-4 分组
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const CODE_LEN = 12

function genCode() {
  const bytes = crypto.randomBytes(CODE_LEN)
  let raw = ''
  for (let i = 0; i < CODE_LEN; i++) raw += ALPHABET[bytes[i] % ALPHABET.length]
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`
}

// 生成邀请码:max_uses 允许一码多人(如车队),expiresInDays 不填=永久
r.post('/', async (req, res) => {
  const { note = '', maxUses = 1, expiresInDays, email } = req.body || {}
  const maxUsesN = Math.min(Math.max(Number(maxUses) || 1, 1), 99)
  const days = Number(expiresInDays)
  const expiresAt = Number.isFinite(days) && days > 0 ? new Date(Date.now() + days * 864e5) : null

  // 12 位码碰撞概率可忽略,但仍循环重试以兜底唯一约束
  let row
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { rows } = await pool.query(
        `INSERT INTO invite_codes (code, created_by, note, max_uses, expires_at)
         VALUES ($1,$2,$3,$4,$5) RETURNING id, code, max_uses, expires_at, created_at`,
        [genCode(), req.user.id, String(note).slice(0, 120), maxUsesN, expiresAt])
      row = rows[0]
      break
    } catch (e) {
      if (e.code !== '23505') throw e
      if (attempt === 2) throw e
    }
  }
  await audit(req.user.id, 'invite_create', `invite:${row.id}`, { note, maxUses: maxUsesN, email: email || null })

  // 可选直发邮箱;成败均入审计,不阻塞码的返回
  let emailStatus = null
  if (email) {
    if (!smtpConfigured()) {
      emailStatus = '未发送:SMTP 未配置'
    } else {
      try {
        await sendInviteMail(email, row.code, note)
        emailStatus = '已发送'
        await audit(req.user.id, 'invite_email_sent', `invite:${row.id}`, { to: email })
      } catch (err) {
        emailStatus = '发送失败:' + err.message
        await audit(req.user.id, 'invite_email_failed', `invite:${row.id}`, { to: email, error: err.message })
      }
    }
  }
  res.json({ ...row, smtpConfigured: smtpConfigured(), emailStatus })
})

// 列表(全量,管理员;邀请码数量有限不分页)
r.get('/', async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT i.id, i.code, i.note, i.max_uses, i.used_count, i.expires_at, i.disabled,
            i.created_at, i.created_by, u.username AS created_by_name
     FROM invite_codes i LEFT JOIN users u ON u.id = i.created_by
     ORDER BY i.id DESC LIMIT 200`)
  res.json({ invites: rows, smtpConfigured: smtpConfigured() })
})

// 禁用/启用
r.patch('/:id', async (req, res) => {
  const { disabled } = req.body || {}
  if (typeof disabled !== 'boolean') return res.status(400).json({ error: '缺少 disabled 布尔值' })
  const { rows } = await pool.query(
    'UPDATE invite_codes SET disabled=$1 WHERE id=$2 RETURNING id', [disabled, Number(req.params.id)])
  if (!rows.length) return res.status(404).json({ error: '邀请码不存在' })
  await audit(req.user.id, disabled ? 'invite_disable' : 'invite_enable', `invite:${rows[0].id}`)
  res.json({ ok: true })
})

r.delete('/:id', async (req, res) => {
  const { rows } = await pool.query('DELETE FROM invite_codes WHERE id=$1 RETURNING code', [Number(req.params.id)])
  if (!rows.length) return res.status(404).json({ error: '邀请码不存在' })
  await audit(req.user.id, 'invite_delete', `invite:${Number(req.params.id)}`, { code: rows[0].code })
  res.json({ ok: true })
})

export default r
