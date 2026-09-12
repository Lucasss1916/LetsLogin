import { Router } from 'express'
import { pool, audit } from '../db.js'
import { requireAuth } from '../auth.js'
import { encryptSecret, decryptSecret } from '../crypto.js'
import { totpFor, validTotpSecret } from '../totp.js'
import { config } from '../config.js'

const r = Router()
r.use(requireAuth)

// 读取权限: 本人 / 管理员 / visibility='all' / visibility='selected' 且已被共享
// 写入权限: 本人 / 管理员
async function accountForId(id, user) {
  const { rows } = await pool.query(
    `SELECT a.*, u.username AS owner_username,
            EXISTS(SELECT 1 FROM account_shares s WHERE s.account_id = a.id AND s.user_id = $2) AS shared
     FROM accounts a JOIN users u ON u.id = a.owner_id
     WHERE a.id = $1`, [id, user.id])
  return rows[0] || null
}

function canRead(acc, user) {
  if (!acc) return false
  if (acc.owner_id === user.id || user.role === 'admin') return true
  if (acc.visibility === 'all') return true
  if (acc.visibility === 'selected') return acc.shared // 查询时填充
  return false
}

function canWrite(acc, user) {
  return acc && (acc.owner_id === user.id || user.role === 'admin')
}

// 账号列表(仅元数据,不含密码明文)
r.get('/', async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT a.id, a.name, a.platform, a.login_username, a.visibility, a.disabled,
            a.owner_id, u.username AS owner_username, a.created_at
     FROM accounts a JOIN users u ON u.id = a.owner_id
     WHERE a.owner_id = $1 OR $2 = 'admin' OR a.visibility = 'all' OR
           a.id IN (SELECT account_id FROM account_shares WHERE user_id = $1)
     ORDER BY a.id`, [_req.user.id, _req.user.role])
  // 标记当前用户是否可写(用于前端隐藏操作按钮)
  const accounts = rows.map(a => ({ ...a, writable: a.owner_id === _req.user.id || _req.user.role === 'admin' }))
  res.json({ accounts })
})

// 单账号详情(解密密码 + 生成当前 TOTP 动态码)
r.get('/:id', async (req, res) => {
  const acc = await accountForId(Number(req.params.id), req.user)
  if (!canRead(acc, req.user)) return res.status(403).json({ error: '无权访问该账号' })
  const totp = totpFor(acc.totp_enc ? decryptSecret(acc.totp_enc) : null)
  // 当前活跃占用会话(用于前端渲染占用状态)
  const sres = await pool.query(
    `SELECT s.id, s.user_id, u.username AS holder
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.account_id = $1 AND s.ended_at IS NULL
     ORDER BY s.started_at LIMIT 1`, [acc.id])
  const activeSession = sres.rows[0] || null
  await audit(req.user.id, 'view_account', `account:${acc.id}`, { name: acc.name })
  res.json({
    id: acc.id, name: acc.name, platform: acc.platform, login_username: acc.login_username,
    password: acc.password_enc ? decryptSecret(acc.password_enc) : null,
    note: acc.note, visibility: acc.visibility, disabled: acc.disabled,
    owner_id: acc.owner_id, owner_username: acc.owner_username,
    totp: totp.code, totp_remaining: totp.remaining,
    activeSession: activeSession ? { id: activeSession.id, holderId: activeSession.user_id, holder: activeSession.holder } : null,
  })
})

// 创建账号
r.post('/', async (req, res) => {
  const { name, platform = '', loginUsername, password, totpSecret = '', note = '', visibility = 'private', sharedUserIds } = req.body || {}
  let shareIds = []
  if (!name || !loginUsername || !password)
    return res.status(400).json({ error: '名称、登录名、密码必填' })
  if (!['private', 'all', 'selected'].includes(visibility))
    return res.status(400).json({ error: '可见性非法' })
  if (totpSecret && !validTotpSecret(totpSecret))
    return res.status(400).json({ error: '2FA Secret 无效' })
  if (Array.isArray(sharedUserIds) && visibility === 'selected') shareIds = sharedUserIds
  if (visibility === 'selected' && shareIds.length === 0)
    return res.status(400).json({ error: '选择指定可见需要至少共享给一个用户' })

  const password_enc = encryptSecret(password)
  const totp_enc = totpSecret ? encryptSecret(totpSecret) : null
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query(
      `INSERT INTO accounts (name, platform, login_username, password_enc, totp_enc, note, owner_id, visibility)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [name, platform, loginUsername, password_enc, totp_enc, note, req.user.id, visibility])
    const id = rows[0].id
    if (shareIds.length) {
      const valid = await client.query('SELECT id FROM users WHERE id = ANY($1)', [shareIds])
      const ids = valid.rows.map(x => x.id)
      for (const uid of ids) await client.query(
        'INSERT INTO account_shares (account_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, uid])
    }
    await client.query('COMMIT')
    await audit(req.user.id, 'create_account', `account:${id}`, { name, visibility })
    res.json({ id })
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }
})

// 更新账号(仅本人/管理员)
r.patch('/:id', async (req, res) => {
  const acc = await accountForId(Number(req.params.id), req.user)
  if (!canWrite(acc, req.user)) return res.status(403).json({ error: '无权修改该账号' })
  const { name, platform, note, password, totpSecret, visibility, disabled, sharedUserIds } = req.body || {}
  if (visibility && !['private', 'all', 'selected'].includes(visibility))
    return res.status(400).json({ error: '可见性非法' })

  const sets = []
  const vals = []
  const push = (col, v) => { sets.push(`${col}=$${vals.length + 1}`); vals.push(v) }

  if (name !== undefined) push('name', name)
  if (platform !== undefined) push('platform', platform)
  if (note !== undefined) push('note', note)
  if (visibility !== undefined) push('visibility', visibility)
  if (typeof disabled === 'boolean') push('disabled', disabled)
  if (password !== undefined) push('password_enc', encryptSecret(password)) // null 时清空
  if (totpSecret !== undefined) push('totp_enc', totpSecret ? encryptSecret(totpSecret) : null)

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    if (sets.length) {
      vals.push(acc.id)
      await client.query(`UPDATE accounts SET ${sets.join(', ')} WHERE id=$${vals.length}`, vals)
    }
    // 同步共享列表:选中可见时按列表覆盖,切到 private/all 时清空
    const targetVisibility = visibility ?? acc.visibility
    if (targetVisibility === 'selected') {
      await client.query('DELETE FROM account_shares WHERE account_id=$1', [acc.id])
      if (Array.isArray(sharedUserIds)) {
        const valid = await client.query('SELECT id FROM users WHERE id = ANY($1)', [sharedUserIds])
        for (const uid of valid.rows) await client.query(
          'INSERT INTO account_shares (account_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [acc.id, uid.id])
      }
    } else {
      await client.query('DELETE FROM account_shares WHERE account_id=$1', [acc.id])
    }
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }
  await audit(req.user.id, 'update_account', `account:${acc.id}`, { name, visibility, disabled })
  res.json({ ok: true })
})

// 删除账号
r.delete('/:id', async (req, res) => {
  const acc = await accountForId(Number(req.params.id), req.user)
  if (!canWrite(acc, req.user)) return res.status(403).json({ error: '无权删除该账号' })
  await pool.query('DELETE FROM accounts WHERE id=$1', [acc.id])
  await audit(req.user.id, 'delete_account', `account:${acc.id}`, { name: acc.name })
  res.json({ ok: true })
})

// 开始会话(签出账号;同一账号同一时刻仅允许一个活跃会话)
r.post('/:id/sessions', async (req, res) => {
  const acc = await accountForId(Number(req.params.id), req.user)
  if (!canRead(acc, req.user)) return res.status(403).json({ error: '无权使用该账号' })
  if (acc.disabled) return res.status(400).json({ error: '该账号已被停用' })
  // 原子占用:依赖 uq_sessions_active 唯一约束(并发下仅一条成功),消除先查后插的竞态
  const ins = await pool.query(
    `INSERT INTO sessions (account_id, user_id)
     SELECT $1, $2
     WHERE NOT EXISTS (SELECT 1 FROM sessions WHERE account_id = $1 AND ended_at IS NULL)
     RETURNING id`, [acc.id, req.user.id])
  if (!ins.rows.length) {
    const holder = await pool.query(
      `SELECT u.username FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.account_id = $1 AND s.ended_at IS NULL LIMIT 1`, [acc.id])
    return res.status(409).json({ error: `该账号当前正被 ${holder.rows[0].username} 占用` })
  }
  await audit(req.user.id, 'session_start', `account:${acc.id}`, { session: ins.rows[0].id, name: acc.name })
  res.json({ session: ins.rows[0].id, account: acc.name, expiresInMinutes: config.sessionTimeoutMinutes })
})

// 结束会话(签入)
r.post('/:id/sessions/end', async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE sessions SET ended_at=now(), end_reason='manual'
     WHERE account_id=$1 AND user_id=$2 AND ended_at IS NULL RETURNING id`, [Number(req.params.id), req.user.id])
  if (!rows.length) return res.status(400).json({ error: '没有进行中的会话' })
  await audit(req.user.id, 'session_end', `account:${Number(req.params.id)}`, { session: rows[0].id })
  res.json({ ok: true })
})

// 强制结束他人会话(仅管理员): 用于账号被不会签入的用户长期占用时解锁
r.post('/:id/sessions/force-end', async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '需要管理员权限' })
  const { rows } = await pool.query(
    `UPDATE sessions SET ended_at = now(), end_reason = 'forced'
     WHERE account_id = $1 AND ended_at IS NULL RETURNING id`, [Number(req.params.id)])
  if (!rows.length) return res.status(400).json({ error: '该账号当前无占用会话' })
  await audit(req.user.id, 'session_force_end', `account:${Number(req.params.id)}`, { session: rows[0].id })
  res.json({ ok: true, session: rows[0].id })
})

// 结束当前用户全部在占会话(退出登录时调用,防止忘记签入导致账号被长期占用)
r.post('/sessions/end-all', async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE sessions SET ended_at = now(), end_reason = 'logout'
     WHERE user_id = $1 AND ended_at IS NULL RETURNING id`, [req.user.id])
  if (rows.length) await audit(req.user.id, 'session_end_all', null, { sessions: rows.map(x => x.id) })
  res.json({ ok: true, ended: rows.length })
})

// 会话列表(管理员可看全部,普通用户看自己的)
r.get('/sessions/all', async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '需要管理员权限' })
  const { rows } = await pool.query(
    `SELECT s.id, s.account_id, a.name AS account_name, s.user_id, u.username AS user_username,
            s.started_at, s.ended_at, s.end_reason
     FROM sessions s
     JOIN accounts a ON a.id = s.account_id
     JOIN users u ON u.id = s.user_id
     ORDER BY s.started_at DESC LIMIT 200`)
  res.json({ sessions: rows })
})

export default r