import { Router } from 'express'
import bcrypt from 'bcryptjs'
import { pool, audit } from '../db.js'
import { signToken, requireAuth } from '../auth.js'

const r = Router()

// 登录限流:5 次失败锁 10 分钟,持久化到 DB(重启不丢)
const LOCK_LIMIT = 5, LOCK_WINDOW_MIN = 10
async function isLocked(username) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM login_attempts
     WHERE username=$1 AND failed_at > now() - make_interval(mins => $2)`, [username, LOCK_WINDOW_MIN])
  return rows[0].n >= LOCK_LIMIT
}
async function recordFail(username) {
  await pool.query('INSERT INTO login_attempts (username) VALUES ($1)', [username])
}
async function clearFails(username) {
  await pool.query('DELETE FROM login_attempts WHERE username=$1', [username])
  // 顺带清理已过期的尝试记录,防止表无限增长
  await pool.query('DELETE FROM login_attempts WHERE failed_at <= now() - make_interval(mins => $1)', [LOCK_WINDOW_MIN])
}

r.post('/login', async (req, res) => {
  const { username, password } = req.body || {}
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.ip
  if (!username || !password) return res.status(400).json({ error: '请输入用户名和密码' })

  if (await isLocked(username)) {
    await audit(null, 'login_rate_limited', `user:${username}`, { ip })
    return res.status(429).json({ error: '尝试次数过多,请稍后再试' })
  }

  const { rows } = await pool.query('SELECT * FROM users WHERE username = $1', [username])
  const user = rows[0]
  if (!user || user.disabled || !(await bcrypt.compare(password, user.password_hash))) {
    await recordFail(username)
    await audit(user ? user.id : null, 'login_failed', `user:${username}`, { ip })
    return res.status(401).json({ error: '用户名或密码错误' })
  }
  await clearFails(username)
  await audit(user.id, 'login', null, { ip })
  res.json({
    token: signToken(user),
    user: { id: user.id, username: user.username, role: user.role, mustChangePassword: user.must_change_password },
  })
})

// 注册限流:每 IP 每小时 20 次(邀请码本身也是门槛;单容器自托管,内存计数即可)
const REGISTER_LIMIT = 20, REGISTER_WINDOW_MS = 3600e3
const registerLog = new Map() // ip -> { count, windowStart }

r.post('/register', async (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.ip
  const now = Date.now()
  let entry = registerLog.get(ip)
  if (!entry || now - entry.windowStart > REGISTER_WINDOW_MS) {
    entry = { count: 0, windowStart: now }
    registerLog.set(ip, entry)
  }
  entry.count++
  if (entry.count > REGISTER_LIMIT) {
    await audit(null, 'register_rate_limited', null, { ip })
    return res.status(429).json({ error: '注册尝试过于频繁,请稍后再试' })
  }

  const { username, password, inviteCode } = req.body || {}
  const name = String(username || '').trim()
  const code = String(inviteCode || '').trim().toUpperCase()
  if (!name || !password || !code) return res.status(400).json({ error: '请填写邀请码、用户名和密码' })
  if (!/^[a-zA-Z0-9_]{2,24}$/.test(name)) return res.status(400).json({ error: '用户名仅限 2-24 位字母/数字/下划线' })
  if (String(password).length < 8) return res.status(400).json({ error: '密码至少 8 位' })

  // 事务:原子消耗邀请码(防并发超用)+ 建号,任一失败整体回滚
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const used = await client.query(
      `UPDATE invite_codes SET used_count = used_count + 1
       WHERE code = $1 AND NOT disabled AND used_count < max_uses
         AND (expires_at IS NULL OR expires_at > now())
       RETURNING id, max_uses`, [code])
    if (!used.rows.length) {
      await client.query('ROLLBACK')
      const [exists] = (await client.query('SELECT 1 FROM invite_codes WHERE code=$1', [code])).rows
      return res.status(400).json({ error: exists ? '邀请码已失效(被禁用/过期/用完)' : '邀请码无效' })
    }
    const inserted = await client.query(
      `INSERT INTO users (username, password_hash, role, must_change_password)
       VALUES ($1,$2,'user',FALSE) RETURNING id, username, role, must_change_password`,
      [name, await bcrypt.hash(String(password), 10)])
    await client.query('COMMIT')
    const u = inserted.rows[0]
    await audit(u.id, 'register', `user:${u.id}`, { invite: code, ip })
    res.json({ token: signToken({ ...u, token_version: 1 }), user: { id: u.id, username: u.username, role: u.role, mustChangePassword: false } })
  } catch (e) {
    await client.query('ROLLBACK')
    if (e.code === '23505') return res.status(409).json({ error: '用户名已存在,换一个试试' })
    throw e
  } finally {
    client.release()
  }
})

r.post('/change-password', requireAuth, async (req, res) => {
  const { oldPassword, newPassword } = req.body || {}
  if (!newPassword || newPassword.length < 8) return res.status(400).json({ error: '新密码至少 8 位' })
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id])
  const user = rows[0]
  if (!(await bcrypt.compare(oldPassword || '', user.password_hash)))
    return res.status(400).json({ error: '原密码错误' })
  // 改密同时自增 token_version,吊销在此之前的全部 JWT
  const updated = await pool.query(
    `UPDATE users SET password_hash = $1, must_change_password = FALSE, token_version = token_version + 1
     WHERE id = $2 RETURNING username, role, token_version`,
    [await bcrypt.hash(newPassword, 10), user.id])
  await audit(user.id, 'change_password')
  const u = updated.rows[0]
  res.json({ ok: true, token: signToken({ id: user.id, username: u.username, role: u.role, token_version: u.token_version }) })
})

r.get('/me', requireAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT id, username, role, must_change_password FROM users WHERE id = $1', [req.user.id])
  const u = rows[0]
  res.json({ id: u.id, username: u.username, role: u.role, mustChangePassword: u.must_change_password })
})

export default r
