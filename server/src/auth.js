import jwt from 'jsonwebtoken'
import { pool } from './db.js'
import { config } from './config.js'

export function signToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, role: user.role, v: user.token_version ?? 1 },
    config.jwtSecret,
    { expiresIn: '12h' }
  )
}

// 认证:校验 JWT 签名 + 吊销状态(改密/重置后 token_version 自增,旧 token 即失效)
export async function requireAuth(req, res, next) {
  const h = req.headers.authorization || ''
  const token = h.startsWith('Bearer ') ? h.slice(7) : null
  if (!token) return res.status(401).json({ error: '未登录' })
  let payload
  try {
    payload = jwt.verify(token, config.jwtSecret)
  } catch {
    return res.status(401).json({ error: '登录已过期' })
  }
  try {
    const { rows } = await pool.query('SELECT token_version FROM users WHERE id = $1', [payload.id])
    const user = rows[0]
    if (!user || (payload.v ?? 1) !== user.token_version) {
      return res.status(401).json({ error: '登录已失效,请重新登录' })
    }
    req.user = payload
    next()
  } catch (e) {
    next(e)
  }
}

export function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: '需要管理员权限' })
  next()
}
