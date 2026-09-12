import express from 'express'
import { migrate } from './db.js'
import authRoutes from './routes/auth.js'
import userRoutes from './routes/users.js'
import accountRoutes from './routes/accounts.js'

const app = express()
import { config } from './config.js'

app.use(express.json())
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
