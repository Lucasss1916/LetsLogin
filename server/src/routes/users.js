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

// 删除用户的事务清理链:sessions(NO ACTION)→ accounts(级联 shares/games/configs)
// → audit/invite 归引用置空 → 删用户行。调用方已校验 self 与最后管理员保护。
async function deleteUserOne(client, id) {
  await client.query(
    'DELETE FROM sessions WHERE user_id=$1 OR account_id IN (SELECT id FROM accounts WHERE owner_id=$1)', [id])
  await client.query('DELETE FROM accounts WHERE owner_id=$1', [id])
  await client.query('UPDATE audit_logs SET actor_id=NULL WHERE actor_id=$1', [id])
  await client.query('UPDATE invite_codes SET created_by=NULL WHERE created_by=$1', [id])
  await client.query('DELETE FROM users WHERE id=$1', [id])
}

r.delete('/:id', async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '非法用户 ID' })
  if (id === req.user.id) return res.status(400).json({ error: '不能删除自己的账号' })

  const c = await pool.connect()
  try {
    await c.query('BEGIN')
    const [target] = (await c.query('SELECT username, role FROM users WHERE id=$1', [id])).rows
    if (!target) throw new Error('用户不存在或已被删除')
    if (target.role === 'admin') {
      const { rows: [{ n }] } = await c.query("SELECT COUNT(*)::int AS n FROM users WHERE role='admin'")
      if (n <= 1) throw new Error('系统必须保留至少一位管理员')
    }
    await deleteUserOne(c, id)
    await c.query('COMMIT')
    await audit(req.user.id, 'user_delete', `user:${id}`, { username: target.username })
    res.json({ ok: true })
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {})
    res.status(400).json({ error: e.message })
  } finally {
    c.release()
  }
})

// 批量操作:disable / enable / delete。逐项独立处理并返回逐条结果,
// self 与"最后一个管理员"由各自分支保护,失败的项不影响其余项。
r.post('/bulk', async (req, res) => {
  const { action, ids } = req.body || {}
  const idList = [...new Set((Array.isArray(ids) ? ids : []).map(Number).filter(n => Number.isInteger(n) && n > 0))]
  if (!['disable', 'enable', 'delete'].includes(action)) return res.status(400).json({ error: '无效的操作类型' })
  if (!idList.length) return res.status(400).json({ error: '请先勾选要操作的用户' })

  const results = []
  for (const id of idList) {
    if (action === 'delete') {
      if (id === req.user.id) { results.push({ id, ok: false, error: '不能删除自己' }); continue }
      const c = await pool.connect()
      try {
        await c.query('BEGIN')
        const [target] = (await c.query('SELECT username, role FROM users WHERE id=$1', [id])).rows
        if (!target) throw new Error('用户不存在')
        if (target.role === 'admin') {
          const { rows: [{ n }] } = await c.query("SELECT COUNT(*)::int AS n FROM users WHERE role='admin'")
          if (n <= 1) throw new Error('系统必须保留至少一位管理员')
        }
        await deleteUserOne(c, id)
        await c.query('COMMIT')
        await audit(req.user.id, 'user_delete', `user:${id}`, { username: target.username, bulk: true })
        results.push({ id, ok: true })
      } catch (e) {
        await c.query('ROLLBACK').catch(() => {})
        results.push({ id, ok: false, error: e.message })
      } finally {
        c.release()
      }
    } else {
      if (action === 'disable' && id === req.user.id) { results.push({ id, ok: false, error: '不能禁用自己' }); continue }
      const [target] = (await pool.query('SELECT username FROM users WHERE id=$1', [id])).rows
      if (!target) { results.push({ id, ok: false, error: '用户不存在' }); continue }
      await pool.query('UPDATE users SET disabled=$1 WHERE id=$2', [action === 'disable', id])
      await audit(req.user.id, action === 'disable' ? 'user_disable' : 'user_enable', `user:${id}`, { username: target.username, bulk: true })
      results.push({ id, ok: true })
    }
  }
  const okCount = results.filter(r => r.ok).length
  res.json({ results, okCount, failCount: results.length - okCount })
})

export default r
