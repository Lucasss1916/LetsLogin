// LetsLogin 前端
const $ = (id) => document.getElementById(id)
const show = (id) => document.getElementById(id).classList.remove('hidden')
const hide = (id) => document.getElementById(id).classList.add('hidden')

const state = { token: localStorage.getItem('ll_token') || null, user: null, totpTimer: null, viewAcc: null }

// ---------- 基础请求 ----------
async function api(method, path, body) {
  const opt = { method, headers: {} }
  if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body) }
  if (state.token) opt.headers['Authorization'] = 'Bearer ' + state.token
  const res = await fetch('/api' + path, opt)
  const text = await res.text()
  const json = text ? JSON.parse(text) : {}
  if (!res.ok) {
    // token 过期/被吊销 → 清凭证回登录页
    if (res.status === 401 && path !== '/auth/login' && path !== '/auth/change-password') {
      state.token = null; localStorage.removeItem('ll_token'); clearInterval(state.totpTimer); showAuth()
    }
    const e = new Error(json.error || ('请求失败 ' + res.status)); e.status = res.status; throw e
  }
  return json
}

// ---------- 视图切换 ----------
function showAuth() {
  hide('view-app'); hide('view-change-pw'); show('view-login')
}
function showChangePw() { hide('view-app'); hide('view-login'); show('view-change-pw') }
function showApp() { hide('view-login'); hide('view-change-pw'); show('view-app') }

function toast(msg, ok=true) {
  const t = $('toast'); t.textContent = msg; t.className = 'toast ' + (ok ? 'ok' : 'err')
  clearTimeout(t._tm); t._tm = setTimeout(() => t.classList.add('hidden'), 2600)
}
// 请求进行中:禁用按钮并显示"提交中…",防止重复提交
function loading(btn, busy) {
  if (!btn) return
  if (busy) { btn.dataset.old = btn.innerHTML; btn.disabled = true; btn.innerHTML = '提交中…' }
  else if (btn.dataset.old) { btn.innerHTML = btn.dataset.old; btn.disabled = false; delete btn.dataset.old }
}
// 复制到剪贴板带反馈
async function copyText(txt) {
  try { await navigator.clipboard.writeText(String(txt)); toast('已复制到剪贴板') }
  catch { toast('复制失败,请手动选择', false) }
}

// ---------- 登录 ----------
$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault(); hide('login-error')
  const btn = e.target.querySelector('button[type=submit]'); loading(btn, true)
  try {
    const { token, user } = await api('POST', '/auth/login', {
      username: $('login-username').value.trim(), password: $('login-password').value,
    })
    state.token = token; localStorage.setItem('ll_token', token); state.user = user; renderUser()
    if (user.mustChangePassword) showChangePw(); else { bootApp(); showApp() }
  } catch (err) { const el = $('login-error'); el.textContent = err.message; show('login-error') }
  finally { loading(btn, false) }
})

// 强制改密
$('change-pw-form').addEventListener('submit', async (e) => {
  e.preventDefault(); hide('cp-error')
  const cpBtn = e.target.querySelector('button[type=submit]'); loading(cpBtn, true)
  try {
    const r = await api('POST', '/auth/change-password', {
      oldPassword: $('cp-old').value, newPassword: $('cp-new').value,
    })
    // 改密后旧 JWT 已吊销,用返回的新 token 继续
    if (r.token) { state.token = r.token; localStorage.setItem('ll_token', r.token) }
    state.user.mustChangePassword = false; toast('密码已修改'); bootApp(); showApp()
  } catch (err) { const el = $('cp-error'); el.textContent = err.message; show('cp-error') }
  finally { loading(cpBtn, false) }
})

// 退出: 先尽力结束自己占用的会话(防长期占用),再清凭证
$('btn-logout').addEventListener('click', async () => {
  try { await api('POST', '/accounts/sessions/end-all') } catch { /* 尽力而为 */ }
  state.token = null; localStorage.removeItem('ll_token')
  clearInterval(state.totpTimer); state.user = null; showAuth()
})

// ---------- 渲染 ----------
function renderUser() {
  $('whoami').textContent = state.user.username + (state.user.role === 'admin' ? ' (管理员)' : '')
  const usersBtn = state.user.role === 'admin'
  usersBtn ? show('btn-users') : hide('btn-users')
}

async function bootApp() {
  renderUser()
  if (state.user.role === 'admin') show('btn-users'); else hide('btn-users')
  await loadAccounts()
}

let allUsers = []
async function loadUsers() {
  const { users } = await api('GET', '/users'); allUsers = users
  const tbody = renderUsers(); if (!tbody) return
}
function renderUsers() {
  const table = $('user-table')
  if (allUsers.length === 0) { table.innerHTML = ''; show('user-placeholder'); return }
  hide('user-placeholder')
  table.innerHTML =
    '<thead><tr><th>ID</th><th>用户名</th><th>角色</th><th>状态</th><th>操作</th></tr></thead><tbody>' +
    allUsers.map(u => `<tr>
      <td>${u.id}</td><td>${esc(u.username)}</td>
      <td><span class="tag ${u.role === 'admin' ? 'blue' : 'green'}">${u.role === 'admin' ? '管理员' : '用户'}</span></td>
      <td>${u.disabled ? '<span class="tag red">已禁用</span>' : '<span class="tag yellow">正常</span>'}</td>
      <td><button class="ghost sm" data-edit-user="${u.id}">编辑</button></td>
    </tr>`).join('') + '</tbody>'
}

async function loadAccounts() {
  const { accounts } = await api('GET', '/accounts')
  const list = $('account-list')
  if (accounts.length === 0) { list.innerHTML = '<div class="empty">暂无账号,点击右上角"新增账号"</div>'; return }
  list.innerHTML = accounts.map(a => `
    <div class="acc-card" data-open="${a.id}">
      <div class="acc-name">${esc(a.name)}
        <span class="badge">${a.visibility === 'private' ? '私有' : a.visibility === 'all' ? '全员' : '指定'}</span>
        ${a.disabled ? '<span class="badge off">停用</span>' : ''}
      </div>
      ${a.platform ? `<div class="acc-sub">${esc(a.platform)}</div>` : ''}
      <div class="acc-sub">${esc(a.login_username)}${a.owner_id !== state.user.id ? ` · ${esc(a.owner_username || '')}` : ''}</div>
      ${a.writable ? '' : '<div class="acc-sub muted">共同访问</div>'}
    </div>`).join('')
}

// ---------- 事件委托 ----------
document.addEventListener('click', async (e) => {
  // 关闭弹层
  if (e.target.matches('[data-close]')) closeModals()

  // 账号卡片
  const open = e.target.closest('[data-open]')
  if (open) { await openAccount(Number(open.dataset.open)); return }

  // 用户编辑
  const ue = e.target.closest('[data-edit-user]')
  if (ue) openUserForm(Number(ue.dataset.editUser))
})

function closeModals() { ['modal-account', 'modal-view', 'modal-user'].forEach(id => hide(id)) }

// ---------- 账号操作 ----------
async function openAccount(id) {
  try {
    const a = await api('GET', '/accounts/' + id)
    state.viewAcc = a
    $('view-title').textContent = a.name
    $('view-platform').textContent = a.platform || '—'
    $('view-login').textContent = a.login_username
    $('view-password').textContent = '••••••••'; $('view-password').dataset.revealed = '0'
    $('btn-reveal').textContent = '显示'
    $('view-note').textContent = a.note || '—'
    renderTotp(a.totp, a.totp_remaining)
    // 会话区: 依据后端返回的当前占用状态渲染
    renderSession(a.activeSession)
    hide('view-error')
    show('modal-view')
  } catch (err) { toast(err.message, false) }
}

function renderTotp(code, remaining) {
  clearInterval(state.totpTimer)
  const el = $('view-totp'), r = $('view-remaining')
  let secs = Math.max(remaining, 0)
  el.textContent = code == null ? '未配置' : code
  r.textContent = code == null ? '' : String(secs).padStart(2, '0') + 's'
  el.classList.toggle('warn', code != null && secs < 5) // 临近周期切换变橙色
  if (code == null) return
  // 每秒刷新剩余秒数;跨周期后拉取最新动态码
  state.totpTimer = setInterval(() => {
    secs--
    if (secs >= 0) { r.textContent = String(secs).padStart(2, '0') + 's'; el.classList.toggle('warn', secs < 5); return }
    if (state.viewAcc) api('GET', '/accounts/' + state.viewAcc.id).then(a => {
      state.viewAcc = a; renderTotp(a.totp, a.totp_remaining)
    }).catch(() => {})
  }, 1000)
}

// 依据当前占用状态渲染会话区:
//   无人占用 → 显示「签出」;本人占用 → 显示占用提示+「签入」;他人占用 → 禁用
function renderSession(as) {
  const active = $('session-active'), start = $('btn-session-start'), end = $('btn-session-end'), force = $('btn-force-end')
  if (!as) {
    active.classList.add('hidden'); start.classList.remove('hidden'); end.classList.add('hidden'); force.classList.add('hidden')
    return
  }
  hide('btn-session-start'); force.classList.add('hidden')
  if (as.holderId === state.user.id) {
    active.textContent = `⏳ 你正在占用${state.viewAcc.name},请及时签入`
    active.classList.remove('hidden'); end.classList.remove('hidden')
  } else {
    active.textContent = `🔒 已被 ${as.holder} 占用中`
    active.classList.remove('hidden'); end.classList.add('hidden')
    // 管理员可强制签入被他人长期占用的账号
    if (state.user.role === 'admin') force.classList.remove('hidden')
  }
}

$('btn-force-end').addEventListener('click', async () => {
  const btn = $('btn-force-end'); loading(btn, true)
  try { await api('POST', `/accounts/${state.viewAcc.id}/sessions/force-end`); toast('已强制签入'); renderSession(null) }
  catch (err) { toast(err.message, false) }
  finally { loading(btn, false) }
})

$('btn-reveal').addEventListener('click', () => {
  const pw = $('view-password')
  const revealed = pw.dataset.revealed === '1'
  if (revealed) { pw.textContent = '••••••••'; pw.dataset.revealed = '0'; $('btn-reveal').textContent = '显示' }
  else { pw.textContent = state.viewAcc.password || '(空)'; pw.dataset.revealed = '1'; $('btn-reveal').textContent = '隐藏' }
})

$('btn-copy-pw').addEventListener('click', () => {
  const pw = state.viewAcc.password
  if (!pw) return toast('没有可复制的密码', false)
  copyText(pw)
})
$('btn-copy-totp').addEventListener('click', () => {
  const code = $('view-totp').textContent
  if (!code || code === '未配置' || code === '—') return toast('没有可复制的动态码', false)
  copyText(code)
})

$('btn-session-start').addEventListener('click', async () => {
  const btn = $('btn-session-start'); loading(btn, true)
  try {
    const r = await api('POST', `/accounts/${state.viewAcc.id}/sessions`)
    hide('btn-session-start'); show('btn-session-end'); show('session-active')
    $('session-active').textContent = `⏳ 已占用${state.viewAcc.name}(${r.expiresInMinutes} 分钟超时)`
  } catch (err) { toast(err.message, false) }
  finally { loading(btn, false) }
})
$('btn-session-end').addEventListener('click', async () => {
  const btn = $('btn-session-end'); loading(btn, true)
  try { await api('POST', `/accounts/${state.viewAcc.id}/sessions/end`); toast('已签入')
    renderSession(null) }
  catch (err) { toast(err.message, false) }
  finally { loading(btn, false) }
})

// ---------- 账号表单(新增/编辑) ----------
$('btn-new-account').addEventListener('click', () => {
  $('account-form').reset(); $('acc-id').value = ''
  $('acc-title').textContent = '新增账号'; $('btn-delete-account').hidden = true
  $('acc-password').setAttribute('required', ''); $('acc-password').placeholder = ''
  hide('acc-error'); show('modal-account')
})
async function editAccount(id) {
  const a = await api('GET', '/accounts/' + id)
  $('acc-id').value = id; $('acc-title').textContent = '编辑: ' + a.name
  $('acc-name').value = a.name; $('acc-platform').value = a.platform || ''
  $('acc-login').value = a.login_username; $('acc-password').value = ''; $('acc-password').removeAttribute('required')
  $('acc-password').placeholder = '留空不修改'; $('acc-totp').value = ''; $('acc-note').value = a.note || ''
  $('acc-visibility').value = a.visibility
  $('acc-share').value = ''
  if (a.visibility === 'selected') show('share-row'); else hide('share-row')
  $('btn-delete-account').hidden = false; hide('acc-error'); show('modal-account')
}
$('acc-visibility').addEventListener('change', (e) => {
  e.target.value === 'selected' ? show('share-row') : hide('share-row')
})
$('account-form').addEventListener('submit', async (e) => {
  e.preventDefault(); hide('acc-error')
  const btn = e.target.querySelector('button[type=submit]'); loading(btn, true)
  const id = $('acc-id').value
  const payload = {
    name: $('acc-name').value.trim(), platform: $('acc-platform').value.trim(),
    loginUsername: $('acc-login').value.trim(), note: $('acc-note').value.trim(),
    visibility: $('acc-visibility').value,
  }
  const pw = $('acc-password').value
  if (pw) payload.password = pw
  const totp = $('acc-totp').value.trim()
  if (totp) payload.totpSecret = totp
  if (payload.visibility === 'selected') {
    payload.sharedUserIds = $('acc-share').value.split(',').map(s => Number(s.trim())).filter(Boolean)
  }
  try {
    if (id) { await api('PATCH', '/accounts/' + id, payload); toast('已保存') }
    else { await api('POST', '/accounts', payload); toast('已创建') }
    closeModals(); await loadAccounts()
  } catch (err) { const el = $('acc-error'); el.textContent = err.message; show('acc-error') }
  finally { loading(btn, false) }
})
$('btn-delete-account').addEventListener('click', async () => {
  const id = $('acc-id').value
  if (!confirm('确认删除该账号?此操作不可恢复')) return
  const btn = $('btn-delete-account'); loading(btn, true)
  try { await api('DELETE', '/accounts/' + id); toast('已删除'); closeModals(); await loadAccounts() }
  catch (err) { toast(err.message, false) }
  finally { loading(btn, false) }
})

// 双击卡片进入编辑(个人/管理员)
document.addEventListener('dblclick', async (e) => {
  const card = e.target.closest('[data-open]')
  if (!card) return
  // 需要知道 writable;再次请求详情
  const a = await api('GET', '/accounts/' + card.dataset.open)
  if (a && (a.owner_id === state.user.id || state.user.role === 'admin')) await editAccount(a.id)
})

// ---------- 用户管理 ----------
$('btn-users').addEventListener('click', async () => {
  hide('panel-accounts'); show('panel-users')
  show('btn-back-accounts'); hide('btn-users')
  try { await loadUsers() } catch (err) { toast(err.message, false) }
})
$('btn-back-accounts').addEventListener('click', () => {
  hide('panel-users'); show('panel-accounts'); hide('btn-back-accounts'); show('btn-users')
})
$('btn-new-user').addEventListener('click', () => {
  $('user-form').reset(); $('u-id').value = ''; $('user-title').textContent = '新增用户'
  $('u-username-row').classList.remove('hidden'); $('u-password').setAttribute('required', '')
  $('btn-disable-user').hidden = true; hide('u-error'); show('modal-user')
})
function openUserForm(id) {
  const u = allUsers.find(x => x.id === id)
  $('u-id').value = u.id; $('user-title').textContent = '编辑: ' + u.username
  $('u-username').value = u.username; $('u-password').value = ''; $('u-password').removeAttribute('required')
  $('u-password').placeholder = '留空不重置密码'; $('u-role').value = u.role
  $('btn-disable-user').hidden = false; $('btn-disable-user').textContent = u.disabled ? '启用' : '禁用'
  hide('u-error'); show('modal-user')
}
$('user-form').addEventListener('submit', async (e) => {
  e.preventDefault(); hide('u-error')
  const btn = e.target.querySelector('button[type=submit]'); loading(btn, true)
  const id = $('u-id').value
  const payload = { role: $('u-role').value }
  const pw = $('u-password').value
  if (pw) payload.resetPassword = pw
  try {
    if (id) { await api('PATCH', '/users/' + id, payload); toast('已保存') }
    else {
      payload.username = $('u-username').value.trim(); payload.password = pw
      await api('POST', '/users', payload); toast('已创建')
    }
    closeModals(); await loadUsers()
  } catch (err) { const el = $('u-error'); el.textContent = err.message; show('u-error') }
  finally { loading(btn, false) }
})
$('btn-disable-user').addEventListener('click', async () => {
  const id = $('u-id').value, u = allUsers.find(x => x.id === id)
  const action = u.disabled ? '启用' : '禁用'
  if (!confirm(`确认${action}用户 ${u.username}?`)) return
  const btn = $('btn-disable-user'); loading(btn, true)
  try { await api('PATCH', '/users/' + id, { disabled: !u.disabled }); toast('已' + action); closeModals(); await loadUsers() }
  catch (err) { toast(err.message, false) }
  finally { loading(btn, false) }
})

// 弹层关闭与 Esc
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModals() })

function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])) }

// ---------- 启动 ----------
async function init() {
  if (!state.token) { showAuth(); return }
  try {
    const me = await api('GET', '/auth/me')
    state.user = me; renderUser(); bootApp(); showApp()
  } catch {
    state.token = null; localStorage.removeItem('ll_token'); showAuth()
  }
}
init()