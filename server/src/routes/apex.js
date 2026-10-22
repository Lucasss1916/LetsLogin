import { Router } from 'express'
import { requireAuth } from '../auth.js'
import { getMapRotation, getSeasonInfo } from '../apex.js'

const r = Router()
r.use(requireAuth)

// Apex 当前地图轮换与轮换时间(按区/平台读取:PC=亚服默认,PS4/X1 主机;未配 key 走本地推算)
r.get('/maprotation', async (req, res) => {
  try {
    res.json(await getMapRotation(req.query.platform))
  } catch (err) {
    res.status(502).json({ error: '获取 Apex 地图轮换失败:' + err.message })
  }
})

// Apex 赛季倒计时(.env 配置 APEX_SEASON_* 校准;未配置按社区口径推算)
r.get('/season', (req, res) => {
  res.json(getSeasonInfo())
})

export default r
