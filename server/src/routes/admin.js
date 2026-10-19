import { Router } from 'express'
import { pool } from '../db.js'
import { requireAuth, requireAdmin } from '../auth.js'

const r = Router()
r.use(requireAuth)
r.use(requireAdmin)

// 审计日志台账(管理后台);action 过滤后端预留,前端先按分页浏览
r.get('/audit', async (req, res) => {
  const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 50, 1), 200)
  const offset = Math.max(Number.parseInt(req.query.offset, 10) || 0, 0)
  const action = String(req.query.action || '').trim().slice(0, 40)
  const params = []
  let where = ''
  if (action) {
    params.push(action)
    where = `WHERE a.action = $${params.length}`
  }
  params.push(limit + 1, offset)
  const { rows } = await pool.query(
    `SELECT a.id, a.action, a.target, a.meta, a.created_at, u.username AS actor
     FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id
     ${where}
     ORDER BY a.id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`, params)
  res.json({ logs: rows.slice(0, limit), hasMore: rows.length > limit })
})

export default r
