'use strict'
// LetsLogin 分享广场 HTTP 客户端(主进程内 fetch, 无 CORS 限制)
// 契约与 server/src/routes/apex-configs.js / auth.js 对齐:
//   Bearer 鉴权; GET /api/apex/configs?limit&offset&search; GET /:id[?count=1];
//   POST /api/apex/configs {title,notes,payload}; DELETE /:id
function normalizeBase(base) {
  let s = String(base || '').trim()
  if (!s) throw new Error('请填写服务器地址(例如 http://127.0.0.1:3080)')
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s
  return s.replace(/\/+$/, '')
}

async function request(base, method, path, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  let resp
  try {
    resp = await fetch(normalizeBase(base) + path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  } catch (err) {
    throw new Error(`无法连接服务器(${err.message}); 请确认地址与 LetsLogin 服务是否在运行`)
  }
  let data = null
  try { data = await resp.json() } catch { /* 非 JSON 响应按下面的错误处理 */ }
  if (!resp.ok) {
    const err = new Error((data && data.error) || `服务器返回 HTTP ${resp.status}`)
    err.status = resp.status
    throw err
  }
  return data
}

const login = (base, username, password) =>
  request(base, 'POST', '/api/auth/login', { body: { username, password } })

const listConfigs = (base, token, { limit = 12, offset = 0, search = '' } = {}) =>
  request(base, 'GET', `/api/apex/configs?limit=${limit}&offset=${offset}&search=${encodeURIComponent(search || '')}`, { token })

const getConfig = (base, token, id, count = false) =>
  request(base, 'GET', `/api/apex/configs/${Number(id)}${count ? '?count=1' : ''}`, { token })

const publishConfig = (base, token, body) =>
  request(base, 'POST', '/api/apex/configs', { token, body })

const deleteConfig = (base, token, id) =>
  request(base, 'DELETE', `/api/apex/configs/${Number(id)}`, { token })

module.exports = { normalizeBase, request, login, listConfigs, getConfig, publishConfig, deleteConfig }
