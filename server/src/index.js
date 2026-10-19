import express from 'express'
import { migrate } from './db.js'
import authRoutes from './routes/auth.js'
import userRoutes from './routes/users.js'
import accountRoutes from './routes/accounts.js'
import gameRoutes from './routes/games.js'
import apexRoutes from './routes/apex.js'
import inviteRoutes from './routes/invites.js'
import adminRoutes from './routes/admin.js'
import apexConfigRoutes from './routes/apex-configs.js'

// Express 4 不会捕获 async handler 里被 reject 的 Promise,若放任不管,
// 任何一次数据库错误都会导致进程退出(整服务不可用)。这里兜底:记录错误而非退出。
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err)
})

const app = express()
import { config } from './config.js'

// 分享的 .apexcfg 正文(base64)可达数百 KB, 默认 100KB 上限会直接 413
app.use(express.json({ limit: '1mb' }))
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS')
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  next()
})

app.get('/api/health', (req, res) => res.json({ ok: true }))
app.use('/api/auth', authRoutes)
app.use('/api/users', userRoutes)
app.use('/api/accounts', accountRoutes)
app.use('/api/games', gameRoutes)
// /api/apex/configs 挂在 /api/apex 之前:子路径优先命中专属路由, 不落到轮换路由
app.use('/api/apex/configs', apexConfigRoutes)
app.use('/api/apex', apexRoutes)
app.use('/api/invites', inviteRoutes)
app.use('/api/admin', adminRoutes)

app.use((err, req, res, next) => {
  console.error(err)
  res.status(500).json({ error: '服务器内部错误' })
})

migrate().then(() => {
  app.listen(config.port, () => console.log(`LetsLogin server 已启动, 端口 ${config.port}`))
}).catch(err => {
  console.error('数据库迁移失败:', err)
  process.exit(1)
})
