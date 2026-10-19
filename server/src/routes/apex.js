import { Router } from 'express'
import { requireAuth } from '../auth.js'
import { getMapRotation } from '../apex.js'

const r = Router()
r.use(requireAuth)

// Apex 当前地图轮换与轮换时间(配置 APEX_API_KEY 用官方数据,否则本地推算)
r.get('/maprotation', async (_req, res) => {
  try {
    res.json(await getMapRotation())
  } catch (err) {
    res.status(502).json({ error: '获取 Apex 地图轮换失败:' + err.message })
  }
})

export default r
