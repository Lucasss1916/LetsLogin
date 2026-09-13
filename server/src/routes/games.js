import { Router } from 'express'
import { pool } from '../db.js'
import { requireAuth } from '../auth.js'

const r = Router()
r.use(requireAuth)

// 游戏目录(含段位阶梯定义),用于前端填充游戏/段位下拉
r.get('/', async (_req, res) => {
  const { rows } = await pool.query('SELECT id, name, rank_tiers FROM games ORDER BY id')
  res.json({ games: rows })
})

export default r