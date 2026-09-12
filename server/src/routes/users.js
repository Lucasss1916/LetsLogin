import { Router } from 'express'
import bcrypt from 'bcryptjs'
import { pool, audit } from '../db.js'
import { requireAuth, requireAdmin } from '../auth.js'

const r = Router()
r.use(requireAuth)
r.use(requireAdmin)

r.get('/', async (_req, res) => {
  const { rows } = await pool.query(
    'SELECT id, username, role, disabled, must_change_password, created_at FROM users ORDER BY id'
  )
  res.json({ users: rows })
})

r.post('/', async (req, res) => {
  const { username, password, role = 'user' } = req.body || {}
  if (!username || !password || password.length < 8)
    return res.status(400).json({ error: '用户名必填,密码至少 8 位' })
  if (!['admin', 'user'].includes(role)) return res.status(400).json({ error: '角色非法' })
  try {
    const { rows } = await pool.query(
      'INSERT INTO users (username, password_hash, role, must_change_password) VALUES ($1,$2,$3,TRUE) RETURNING id',
      [username, await bcrypt.hash(password, 10), role]
    )
    await audit(req.user.id, 'create_user', `user:${rows[0].id}`, { username, role })
    res.json({ id: rows[0].id })
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: '用户名已存在' })
    throw e
  }
})

r.patch('/:id', async (req, res) => {
  const id = Number(req.params.id)
  const { disabled, resetPassword, role } = req.body || {}
  if (id === req.user.id && (disabled || (role && role !== 'admin')))
    return res.status(400).json({ error: '不能禁用或降级自己' })
  if (typeof disabled === 'boolean')
    await pool.query('UPDATE users SET disabled=$1 WHERE id=$2', [disabled, id])
  if (role && ['admin', 'user'].includes(role))
    await pool.query('UPDATE users SET role=$1 WHERE id=$2', [role, id])
  if (resetPassword) {
    if (resetPassword.length < 8) return res.status(400).json({ error: '密码至少 8 位' })
    // 重置密码同时吊销目标用户已签发的全部 JWT
    await pool.query(
      'UPDATE users SET password_hash=$1, must_change_password=TRUE, token_version = token_version + 1 WHERE id=$2',
      [await bcrypt.hash(resetPassword, 10), id])
  }
  await audit(req.user.id, 'update_user', `user:${id}`, { disabled, role, resetPassword: !!resetPassword })
  res.json({ ok: true })
})

export default r
