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

// 短时间格式(MM-DD HH:mm),后台表格通用
function fmtHM(value) {
  const d = new Date(value)
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
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

// 邀请码注册(与登录同视图切换)
const showLoginView = () => { show('login-form'); hide('register-form'); hide('login-error'); hide('register-error') }
const showRegisterView = () => { show('register-form'); hide('login-form'); hide('login-error'); hide('register-error') }
$('goto-register').addEventListener('click', (e) => { e.preventDefault(); showRegisterView() })
$('goto-login').addEventListener('click', (e) => { e.preventDefault(); showLoginView() })

// 邀请码输入自动格式化为大写 4-4-4(过滤非法字符;码表剔除 I L O 0 1)
$('reg-invite').addEventListener('input', (e) => {
  const raw = e.target.value.toUpperCase().replace(/[^A-HJKMN-Z2-9]/gi, '').slice(0, 12)
  e.target.value = raw.length > 8 ? `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8)}`
    : raw.length > 4 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw
})

$('register-form').addEventListener('submit', async (e) => {
  e.preventDefault(); hide('register-error')
  const pw = $('reg-password').value, pw2 = $('reg-password2').value
  const err = (msg) => { const el = $('register-error'); el.textContent = msg; show('register-error') }
  if (pw !== pw2) return err('两次输入的密码不一致')
  const btn = e.target.querySelector('button[type=submit]'); loading(btn, true)
  try {
    const { token, user } = await api('POST', '/auth/register', {
      username: $('reg-username').value.trim(),
      password: pw,
      inviteCode: $('reg-invite').value.trim(),
    })
    state.token = token; localStorage.setItem('ll_token', token); state.user = user; renderUser()
    bootApp(); showApp()
  } catch (e2) { err(e2.message) } finally { loading(btn, false) }
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
}

// 统一面板切换:accounts(账号)/ users(用户管理,仅管理员)/ apex(地图轮换)
function setPanel(name) {
  ;['panel-accounts', 'panel-users', 'panel-apex', 'panel-apexcfg'].forEach(hide)
  show('panel-' + name)
  const isAdmin = state.user?.role === 'admin'
  $('btn-users').classList.toggle('hidden', !(isAdmin && name === 'accounts'))
  $('btn-back-accounts').classList.toggle('hidden', name === 'accounts')
  if (name === 'apex') startRotation(); else stopRotation()
}

async function bootApp() {
  renderUser()
  setPanel('accounts')
  await loadGames()
  await loadAccounts()
}

let allGames = []
async function loadGames() {
  const { games } = await api('GET', '/games'); allGames = games
}
// 根据某游戏的段位阶梯生成下拉选项(v 为存储的段位标签,空=未定级)
function rankOptions(game) {
  const opts = [{ v: '', label: '未定级' }]
  if (!game) return opts
  for (const t of game.rank_tiers || []) {
    if (t.sub > 0) { for (let i = 1; i <= t.sub; i++) opts.push({ v: `${t.tier}${i}`, label: `${t.tier}${i}` }) }
    else opts.push({ v: t.tier, label: t.tier })
  }
  return opts
}

// 账号表单中待编辑的游戏行数据
let formGames = []
function renderFormGames() {
  const box = $('acc-games')
  if (!box) return
  box.innerHTML = formGames.map((g, i) => `
    <div class="ag-row">
      <select class="ag-game" data-i="${i}">
        ${allGames.map(x => `<option value="${x.id}" ${g.gameId === x.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}
      </select>
      <select class="ag-rank" data-i="${i}">
        ${rankOptions(allGames.find(x => x.id === g.gameId)).map(o => `<option value="${esc(o.v)}" ${g.rank === o.v ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}
      </select>
      <button type="button" class="ghost sm ag-remove" data-i="${i}">✕</button>
    </div>`).join('')
}
$('btn-add-game').addEventListener('click', () => {
  formGames.push({ gameId: allGames[0]?.id || null, rank: '' })
  renderFormGames()
})
$('acc-games').addEventListener('change', (e) => {
  const i = e.target.dataset.i
  if (i === undefined) return
  if (e.target.classList.contains('ag-game')) {
    formGames[i].gameId = Number(e.target.value); formGames[i].rank = ''
    renderFormGames() // 重建段位下拉
  } else if (e.target.classList.contains('ag-rank')) {
    formGames[i].rank = e.target.value
  }
})

let allUsers = []
async function loadUsers() {
  const { users } = await api('GET', '/users'); allUsers = users
  const tbody = renderUsers(); if (!tbody) return
}
const userSel = new Set() // 勾选中的用户 id
function renderUsers() {
  const table = $('user-table')
  if (allUsers.length === 0) { table.innerHTML = ''; show('user-placeholder'); updateBulkBar(); return }
  hide('user-placeholder')
  const allChecked = allUsers.length > 0 && allUsers.every(u => userSel.has(u.id))
  table.innerHTML =
    '<thead><tr><th><input type="checkbox" id="sel-all"' + (allChecked ? ' checked' : '') + '></th><th>ID</th><th>用户名</th><th>角色</th><th>状态</th><th>操作</th></tr></thead><tbody>' +
    allUsers.map(u => `<tr>
      <td><input type="checkbox" data-sel-user="${u.id}"${userSel.has(u.id) ? ' checked' : ''}></td>
      <td>${u.id}</td><td>${esc(u.username)}</td>
      <td><span class="tag ${u.role === 'admin' ? 'blue' : 'green'}">${u.role === 'admin' ? '管理员' : '用户'}</span></td>
      <td>${u.disabled ? '<span class="tag red">已禁用</span>' : '<span class="tag yellow">正常</span>'}</td>
      <td><button class="ghost sm" data-edit-user="${u.id}">编辑</button>
          <button class="ghost sm danger" data-del-user="${u.id}">删除</button></td>
    </tr>`).join('') + '</tbody>'
  updateBulkBar()
}

function updateBulkBar() {
  const bar = $('user-bulk-bar')
  if (!bar) return
  bar.hidden = userSel.size === 0
  $('bulk-count').textContent = `已选 ${userSel.size} 个用户`
}

function filteredSelection() {
  const ids = [...userSel]
  const skipped = ids.filter(id => id === state.user.id)
  return { ids: ids.filter(id => id !== state.user.id), skippedSelf: skipped.length > 0 }
}

async function bulkUsers(action, ids) {
  const d = await api('POST', '/users/bulk', { action, ids })
  const tag = { disable: '禁用', enable: '启用', delete: '删除' }[action]
  const errs = d.results.filter(r => !r.ok)
  if (errs.length) toast(`${tag}完成:成功 ${d.okCount},失败 ${d.failCount}(如:${errs[0].error})`, d.okCount > 0)
  else toast(`${tag}完成,共 ${d.okCount} 个用户`)
  userSel.clear()
  await loadUsers()
}

$('user-table').addEventListener('change', (e) => {
  if (e.target.id === 'sel-all') {
    const on = e.target.checked
    userSel.clear()
    if (on) allUsers.forEach(u => userSel.add(u.id))
    document.querySelectorAll('[data-sel-user]').forEach(cb => { cb.checked = on })
  } else if (e.target.dataset.selUser) {
    const id = Number(e.target.dataset.selUser)
    if (userSel.has(id)) userSel.delete(id); else userSel.add(id)
  }
  updateBulkBar()
})

$('btn-bulk-disable').addEventListener('click', async () => {
  const { ids, skippedSelf } = filteredSelection()
  if (!ids.length) return
  if (skippedSelf) toast('已自动跳过你自己', false)
  await bulkUsers('disable', ids)
})
$('btn-bulk-enable').addEventListener('click', async () => {
  const { ids } = filteredSelection()
  if (ids.length) await bulkUsers('enable', ids)
})
$('btn-bulk-delete').addEventListener('click', async () => {
  const { ids, skippedSelf } = filteredSelection()
  if (!ids.length) { toast('不能删除自己,请另选用户', false); return }
  if (!confirm(`确认删除选中的 ${ids.length} 个用户?\n其名下密码账号、共享关系与会话记录将一并删除,不可恢复`)) return
  if (skippedSelf) toast('不能删除自己,已自动跳过', false)
  await bulkUsers('delete', ids)
})

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
      ${a.games && a.games.length ? `<div class="acc-games">${a.games.map(g => `<span class="badge">${esc(g.gameName)} · ${esc(g.rank)}</span>`).join('')}</div>` : ''}
      <div class="acc-sub">
        ${a.writable
          ? `<button type="button" class="ghost sm acc-edit" data-edit-account="${a.id}">✎ 编辑</button>`
          : '<span class="muted">共同访问</span>'}
      </div>
    </div>`).join('')
}

// ---------- 事件委托 ----------
document.addEventListener('click', async (e) => {
  // 关闭弹层
  if (e.target.matches('[data-close]')) closeModals()

  // 账号表单游戏行移除
  const rem = e.target.closest('.ag-remove')
  if (rem) { formGames.splice(Number(rem.dataset.i), 1); renderFormGames(); return }

  // 编辑账号按钮优先:它位于账号卡片内部,需先于卡片点击处理
  const ea = e.target.closest('[data-edit-account]')
  if (ea) { try { await editAccount(Number(ea.dataset.editAccount)) } catch (err) { toast(err.message, false) } return }

  // 账号卡片
  const open = e.target.closest('[data-open]')
  if (open) { await openAccount(Number(open.dataset.open)); return }

  // 用户编辑
  const ue = e.target.closest('[data-edit-user]')
  if (ue) { openUserForm(Number(ue.dataset.editUser)); return }

  // 用户删除(单条)
  const ud = e.target.closest('[data-del-user]')
  if (ud) {
    const u = allUsers.find(x => x.id === Number(ud.dataset.delUser))
    if (!u) return
    if (u.id === state.user.id) { toast('不能删除自己的账号', false); return }
    if (confirm(`确认删除用户 ${u.username}?\n其名下密码账号、共享关系与会话记录将一并删除,不可恢复`)) {
      await bulkUsers('delete', [u.id])
    }
    return
  }
})

function closeModals() { ['modal-account', 'modal-view', 'modal-user', 'modal-invite'].forEach(id => hide(id)) }

// ---------- 账号操作 ----------
async function openAccount(id) {
  try {
    const a = await api('GET', '/accounts/' + id)
    state.viewAcc = a
    $('view-title').textContent = a.name
    $('view-platform').textContent = a.platform || '—'
    $('view-login-name').textContent = a.login_username
    $('view-password').textContent = '••••••••'; $('view-password').dataset.revealed = '0'
    $('btn-reveal').textContent = '显示'
    $('view-note').textContent = a.note || '—'
    // 游戏与段位 + 上号游戏选择(有游戏时才显示)
    const games = a.games || []
    $('view-games').innerHTML = games.length
      ? games.map(g => `<span class="badge">${esc(g.gameName)} · ${esc(g.rank)}</span>`).join('')
      : '<span class="muted">未绑定游戏</span>'
    ;(function() {
      const row = $('session-game-row'), sg = $('session-game')
      row.classList.toggle('hidden', games.length === 0)
      sg.innerHTML = games.map(g => `<option value="${g.id}">${esc(g.gameName)}(${esc(g.rank)})</option>`).join('')
    })()
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
  const sg = $('session-game')
  const gameId = sg.options.length ? Number(sg.value) : null
  try {
    const r = await api('POST', `/accounts/${state.viewAcc.id}/sessions`, { gameId })
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
  formGames = []; renderFormGames()
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
  formGames = (a.games || []).map(g => ({ gameId: g.gameId, rank: g.rank || '' }))
  renderFormGames()
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
  payload.games = formGames.filter(g => g.gameId).map(g => ({ gameId: g.gameId, rank: g.rank }))
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

// ---------- Apex 地图轮换 ----------
let rotationData = null
let rotationTimer = null
let rotationRefreshing = false
let rotationPlatform = 'PC' // 亚服默认:PC(东京节点);PS4/X1 为主机池
const PLATFORM_LABEL = { PC: '亚服 · PC', PS4: 'PlayStation', X1: 'Xbox' }

function startRotation() {
  loadRotation()
  clearInterval(rotationTimer)
  rotationTimer = setInterval(tickRotation, 1000)
}
function stopRotation() {
  clearInterval(rotationTimer)
  rotationTimer = null
}

// 当前地图剩余秒数 = 后端快照剩余 - 响应已流逝时间
function rotationRemaining(mode) {
  const elapsed = (Date.now() - rotationData.responseAt) / 1000
  return Math.max(0, Math.round(mode.current.remainingSecs - elapsed))
}

function formatCountdown(secs) {
  const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), s = secs % 60
  const mm = String(m).padStart(2, '0'), ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

async function loadRotation() {
  try {
    const data = await api('GET', '/apex/maprotation?platform=' + rotationPlatform)
    rotationData = { ...data, responseAt: Date.now() }
    hide('apex-error')
    renderRotation()
  } catch (err) { $('apex-error').textContent = err.message; show('apex-error') }
}

// 区/平台切换(亚服 · PC 默认);同平台全球各连接区轮换一致
$('platform-chips').addEventListener('click', (e) => {
  const chip = e.target.closest('.platform-chip')
  if (!chip || chip.dataset.platform === rotationPlatform) return
  rotationPlatform = chip.dataset.platform
  document.querySelectorAll('.platform-chip').forEach(c => c.classList.toggle('active', c === chip))
  loadRotation()
})

function renderRotation() {
  const data = rotationData
  $('apex-fallback-note').classList.toggle('hidden', data.source !== 'fallback')
  $('apex-source').textContent = data.source === 'api'
    ? (data.staleNotice ? `官方 API(刚才请求失败,展示缓存数据) · ${PLATFORM_LABEL[rotationPlatform]}` : `数据源:apexstatus 官方 API · ${PLATFORM_LABEL[rotationPlatform]}`)
    : `按标准轮换周期推算 · 配置 APEX_API_KEY 后为官方数据 · ${PLATFORM_LABEL[rotationPlatform]}`
  const grid = $('rotation-grid')
  if (!data.modes.length) { grid.innerHTML = '<div class="empty">暂无轮换数据</div>'; return }
  grid.innerHTML = data.modes.map(mode => {
    const c = mode.current
    const progress = c.durationSecs > 0 ? Math.min(100, (1 - c.remainingSecs / c.durationSecs) * 100) : 0
    return `
      <article class="rotation-card">
        <div class="rotation-banner">
          ${c.image ? `<img src="${esc(c.image)}" alt="${esc(c.map)}" onerror="this.remove()" />` : ''}
          <span class="badge rotation-mode">${esc(mode.name)}</span>
          <div class="rotation-name">${esc(c.map)}</div>
          ${c.event ? `<div class="rotation-event">${esc(c.event)}</div>` : ''}
        </div>
        <div class="rotation-meta">
          <div class="rotation-countdown">
            <span class="label-txt">距下场轮换</span>
            <strong data-countdown="${esc(mode.key)}">${formatCountdown(rotationRemaining(mode))}</strong>
          </div>
          <div class="rotation-bar"><div class="rotation-bar-fill" data-fill="${esc(mode.key)}" style="width:${progress}%"></div></div>
          <div class="rotation-next">下一张地图<b>${esc(mode.next?.map || '待公布')}</b></div>
        </div>
      </article>`
  }).join('')
}

// 每秒刷新倒计时与进度条;有模式归零时自动拉取下一轮数据
function tickRotation() {
  if (!rotationData) return
  let anyEnded = false
  for (const mode of rotationData.modes) {
    const remaining = rotationRemaining(mode)
    const countdownEl = document.querySelector(`[data-countdown="${mode.key}"]`)
    const fillEl = document.querySelector(`[data-fill="${mode.key}"]`)
    if (countdownEl) countdownEl.textContent = formatCountdown(remaining)
    if (fillEl && mode.current.durationSecs > 0) {
      fillEl.style.width = Math.min(100, (1 - remaining / mode.current.durationSecs) * 100) + '%'
    }
    if (remaining <= 0) anyEnded = true
  }
  if (anyEnded && !rotationRefreshing) {
    rotationRefreshing = true
    loadRotation().finally(() => { rotationRefreshing = false })
  }
}

// ---------- 管理后台(用户 / 邀请码 / 审计日志) ----------
let adminTab = 'users'

function switchAdminTab(tab) {
  adminTab = tab
  document.querySelectorAll('[data-admin-tab]').forEach(b => b.classList.toggle('active', b.dataset.adminTab === tab))
  ;['admin-users', 'admin-invites', 'admin-audit'].forEach(id => $(id).classList.toggle('hidden', id !== 'admin-' + tab))
  $('btn-new-user').classList.toggle('hidden', tab !== 'users')
  $('btn-new-invite').classList.toggle('hidden', tab !== 'invites')
  if (tab === 'users') loadUsers().catch(() => {})
  if (tab === 'invites') loadInvites().catch(() => {})
  if (tab === 'audit') loadAudit(true).catch(() => {})
}

document.querySelectorAll('[data-admin-tab]').forEach(b =>
  b.addEventListener('click', () => switchAdminTab(b.dataset.adminTab)))

// 邀请码管理
let inviteList = []
let inviteSmtpOk = false

async function loadInvites() {
  const d = await api('GET', '/invites')
  inviteList = d.invites || []
  inviteSmtpOk = Boolean(d.smtpConfigured)
  $('iv-email').closest('label').classList.toggle('hidden', !inviteSmtpOk)
  renderInvites()
}

function inviteStatus(inv) {
  if (inv.disabled) return { text: '已禁用', cls: 'red' }
  if (inv.expires_at && new Date(inv.expires_at) < new Date()) return { text: '已过期', cls: 'yellow' }
  if (inv.used_count >= inv.max_uses) return { text: '已用完', cls: 'yellow' }
  return { text: '可用', cls: 'green' }
}

function renderInvites() {
  const table = $('invite-table'), empty = $('invite-placeholder')
  if (!inviteList.length) {
    table.innerHTML = ''
    empty.textContent = '还没有邀请码,点上面「+ 生成邀请码」'
    empty.classList.remove('hidden')
    return
  }
  empty.classList.add('hidden')
  table.innerHTML =
    '<thead><tr><th>邀请码</th><th>备注</th><th>用量</th><th>状态</th><th>有效期</th><th>创建人</th><th>操作</th></tr></thead><tbody>' +
    inviteList.map(inv => {
      const st = inviteStatus(inv)
      const expire = inv.expires_at ? fmtHM(inv.expires_at) : '永久'
      return `<tr>
      <td><code class="invite-code">${esc(inv.code)}</code></td>
      <td>${esc(inv.note || '—')}</td>
      <td>${inv.used_count}/${inv.max_uses}</td>
      <td><span class="tag ${st.cls}">${st.text}</span>${inv.email_status_disp || ''}</td>
      <td>${expire}</td>
      <td>${esc(inv.created_by_name || '—')}</td>
      <td class="row-actions">
        <button class="ghost sm" data-inv-copy="${inv.id}">复制</button>
        <button class="ghost sm" data-inv-toggle="${inv.id}">${inv.disabled ? '启用' : '禁用'}</button>
        <button class="ghost sm danger" data-inv-del="${inv.id}">删除</button>
      </td></tr>`
    }).join('') + '</tbody>'
}

$('invite-table').addEventListener('click', async (e) => {
  const cpy = e.target.closest('[data-inv-copy]')
  if (cpy) { const inv = inviteList.find(x => x.id === Number(cpy.dataset.invCopy)); return copyText(inv.code) }
  const tog = e.target.closest('[data-inv-toggle]')
  if (tog) {
    const inv = inviteList.find(x => x.id === Number(tog.dataset.invToggle))
    try { await api('PATCH', '/invites/' + inv.id, { disabled: !inv.disabled }); toast('已更新'); await loadInvites() }
    catch (err) { toast(err.message, false) }
    return
  }
  const del = e.target.closest('[data-inv-del]')
  if (del) {
    if (!confirm('确认删除该邀请码?已发出的码将立即失效')) return
    try { await api('DELETE', '/invites/' + del.dataset.invDel); toast('已删除'); await loadInvites() }
    catch (err) { toast(err.message, false) }
  }
})

let lastInviteCode = ''
$('btn-new-invite').addEventListener('click', () => {
  $('invite-form').reset(); hide('invite-result'); hide('invite-error'); $('btn-copy-invite').hidden = true
  $('iv-max-uses').value = 1
  show('modal-invite')
})

$('invite-form').addEventListener('submit', async (e) => {
  e.preventDefault(); hide('invite-error'); hide('invite-result')
  const body = { note: $('iv-note').value.trim(), maxUses: Number($('iv-max-uses').value) || 1 }
  if ($('iv-days').value) body.expiresInDays = Number($('iv-days').value)
  const email = $('iv-email').value.trim()
  if (email) body.email = email
  const btn = e.target.querySelector('button[type=submit]'); loading(btn, true)
  try {
    const inv = await api('POST', '/invites', body)
    lastInviteCode = inv.code
    const res = $('invite-result')
    res.innerHTML = `✔ 已生成 <code class="invite-code">${esc(inv.code)}</code>${inv.emailStatus ? `<div class="muted" style="margin-top:6px">${esc(inv.emailStatus)}</div>` : ''}`
    res.classList.remove('hidden')
    $('btn-copy-invite').hidden = false
    toast('邀请码已生成')
    if (adminTab === 'invites') loadInvites().catch(() => {})
  } catch (err) {
    const el = $('invite-error'); el.textContent = err.message; show('invite-error')
  } finally { loading(btn, false) }
})

$('btn-copy-invite').addEventListener('click', () => lastInviteCode && copyText(lastInviteCode))

// 审计日志台账
let auditItems = []
const auditState = { offset: 0, hasMore: false }

async function loadAudit(reset = false) {
  const q = `?limit=50&offset=${reset ? 0 : auditState.offset}`
  const d = await api('GET', '/admin/audit' + q)
  auditItems = reset ? d.logs : auditItems.concat(d.logs)
  auditState.offset = auditItems.length
  auditState.hasMore = d.hasMore
  renderAudit()
}

function renderAudit() {
  const table = $('audit-table'), empty = $('audit-empty')
  $('audit-more').classList.toggle('hidden', !auditState.hasMore)
  if (!auditItems.length) {
    table.innerHTML = ''
    empty.textContent = '暂无审计记录'
    empty.classList.remove('hidden')
    return
  }
  empty.classList.add('hidden')
  table.innerHTML =
    '<thead><tr><th>时间</th><th>操作人</th><th>动作</th><th>对象</th></tr></thead><tbody>' +
    auditItems.map(a => {
      const meta = Object.keys(a.meta || {}).length ? esc(JSON.stringify(a.meta)) : ''
      return `<tr title="${meta}">
      <td>${fmtHM(a.created_at)}</td>
      <td>${esc(a.actor || '匿名/系统')}</td>
      <td><span class="tag blue">${esc(a.action)}</span></td>
      <td>${esc(a.target || '—')}</td></tr>`
    }).join('') + '</tbody>'
}

$('audit-more').addEventListener('click', () => loadAudit().catch(() => {}))

// 用户管理
$('btn-users').addEventListener('click', async () => {
  setPanel('users')
  switchAdminTab('users') // 进入后台重置到默认子面板并加载
})
$('btn-back-accounts').addEventListener('click', () => setPanel('accounts'))
$('btn-apex').addEventListener('click', () => setPanel('apex'))
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

// ---------- Apex 配置分享广场 ----------

let cfgItems = []                      // 已加载的列表数据(增量累积)
let cfgPublishPayload = ''             // 待发布的 .apexcfg 原始文本
let cfgSearchTimer = null

const cfgState = { offset: 0, hasMore: false, keyword: '' }
const CFG_PAGE_SIZE = 12
const CFG_MAX_PAYLOAD = 512 * 1024

const cfgShow = (el) => el.classList.remove('hidden')
const cfgHide = (el) => el.classList.add('hidden')

function cfgFormatSens(sens) {
  const entries = Object.entries(sens || {})
  const pick = entries.find(([key]) => key.includes('mouse_sensitivity')) || entries[0]
  if (!pick) return ''
  const num = Number(pick[1])
  return `灵敏度 ${Number.isFinite(num) ? num : pick[1]}`
}

function cfgFormatResolution(video) {
  const w = video && (video['setting.defaultres'] || video.defaultres)
  const h = video && (video['setting.defaultresheight'] || video.defaultresheight)
  if (!w || !h) return ''
  return `${Number(w)}×${Number(h)}`
}

function cfgChips(config) {
  const p = config.preview || {}
  const chips = []
  const sens = cfgFormatSens(p.sensitivity)
  if (sens) chips.push(sens)
  if (typeof p.binds_count === 'number' && p.binds_count > 0) chips.push(`键位 ${p.binds_count} 项`)
  const res = cfgFormatResolution(p.video)
  if (res) chips.push(res)
  chips.push(`${config.file_count} 个文件`)
  return chips
}

function renderCfgList() {
  const listEl = $('cfg-list'), emptyEl = $('cfg-empty')
  $('cfg-more').classList.toggle('hidden', !cfgState.hasMore)
  if (cfgItems.length === 0) {
    listEl.innerHTML = ''
    emptyEl.textContent = cfgState.keyword ? '没有匹配的分享,换个关键词试试' : '还没有人分享配置,你先来一个?'
    cfgShow(emptyEl)
    return
  }
  cfgHide(emptyEl)
  const isAdmin = state.user?.role === 'admin'
  const myId = state.user?.id
  // 一次性 innerHTML 拼接渲染, 避免逐卡片操作 DOM 造成多次 reflow
  listEl.innerHTML = cfgItems.map(c => `
    <article class="rotation-card cfg-card">
      <div class="cfg-card-head">
        <strong class="cfg-card-title">${esc(c.title)}</strong>
        ${(c.user_id === myId || isAdmin) ? `<button type="button" class="ghost sm" data-cfg-del="${c.id}" title="删除">✕</button>` : ''}
      </div>
      <div class="cfg-sub">${esc(c.author)} · ${fmtHM(c.created_at)} · 下载 ${c.downloads} 次</div>
      <div class="cfg-chips">${cfgChips(c).map(t => `<span class="badge">${esc(t)}</span>`).join('')}</div>
      ${c.notes ? `<div class="cfg-notes">${esc(c.notes)}</div>` : ''}
      <div class="cfg-actions">
        <button type="button" class="primary sm" data-cfg-dl="${c.id}">⇩ 下载 .apexcfg</button>
        <button type="button" class="ghost sm" data-cfg-toggle="${c.id}">明细</button>
      </div>
      <div class="cfg-detail hidden" id="cfg-detail-${c.id}"><span class="cfg-detail-hint">点击「明细」查看具体键位 / 画质 / 全部设置</span></div>
    </article>`).join('')
}

async function loadCfgConfigs(reset = false) {
  const errorEl = $('cfg-error')
  try {
    cfgHide(errorEl)
    const q = new URLSearchParams({ limit: CFG_PAGE_SIZE, offset: reset ? 0 : cfgState.offset })
    if (cfgState.keyword) q.set('search', cfgState.keyword)
    const data = await api('GET', '/apex/configs?' + q.toString())
    cfgState.hasMore = data.hasMore
    cfgItems = reset ? data.configs : cfgItems.concat(data.configs)
    cfgState.offset = cfgItems.length
    renderCfgList()
  } catch (err) { errorEl.textContent = err.message; cfgShow(errorEl) }
}

function cfgSanitizeFilename(name) {
  const cleaned = String(name).replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim()
  return (cleaned || 'apex-config').slice(0, 60)
}

async function downloadCfg(id) {
  try {
    // ?count=1 让服务端计下载次数;payload 只在详情接口返回(列表不传正文)
    const { config } = await api('GET', `/apex/configs/${id}?count=1`)
    const blob = new Blob([config.payload], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = cfgSanitizeFilename(config.title) + '.apexcfg'
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 2000)
    toast(`已下载 ${a.download},在图形版「分享配置」页或控制台菜单「5 导入分享文件」应用`)
  } catch (err) { toast(err.message, false) }
}

async function deleteCfg(id, btn) {
  if (!confirm('确认删除这条分享?')) return
  loading(btn, true)
  try {
    await api('DELETE', '/apex/configs/' + id)
    cfgItems = cfgItems.filter(c => c.id !== id)
    renderCfgList()
    toast('已删除')
  } catch (err) { toast(err.message, false) }
  finally { loading(btn, false) }
}

// 前端先做一次结构校验, 与服务端同规则, 避免明显错误多跑一次网络
function cfgSummarize(data) {
  if (data.kind !== 'apexcfg' || data.format !== 1) throw new Error('不是 .apexcfg 格式,请用工具 export 导出')
  const files = data.files && typeof data.files === 'object' ? Object.keys(data.files) : []
  if (!files.length) throw new Error('配置里没有任何文件内容')
  const parts = []
  const sens = cfgFormatSens(data.preview?.sensitivity)
  if (sens) parts.push(sens)
  parts.push(`${files.length} 个文件`)
  return parts.join(' · ')
}

// 面板懒加载:首次点开才请求列表, 平时零开销
$('btn-apexcfg').addEventListener('click', () => {
  setPanel('apexcfg')
  loadCfgConfigs(true)
})

$('cfg-list').addEventListener('click', (e) => {
  const dl = e.target.closest('[data-cfg-dl]')
  if (dl) return downloadCfg(Number(dl.dataset.cfgDl))
  const del = e.target.closest('[data-cfg-del]')
  if (del) return deleteCfg(Number(del.dataset.cfgDel), del)
  const toggle = e.target.closest('[data-cfg-toggle]')
  if (toggle) return cfgToggleDetail(Number(toggle.dataset.cfgToggle))
  // 展开明细里的「查看原文」
  const rt = e.target.closest('[data-cfg-raw]')
  if (rt) {
    const pre = $('cfg-raw-' + rt.dataset.cfgRaw)
    if (pre) {
      pre.classList.toggle('hidden')
      rt.textContent = pre.classList.contains('hidden') ? '查看原文' : '收起原文'
    }
  }
})

// 明细缓存:id → 渲染好的 HTML(点击后首次解码, 不重复请求)
const cfgDetailCache = {}

function cfgParsePairsText(text) {
  const rows = []
  const qMap = new Map()        // 非 bind 的 "a" "b" 引号对
  const bindRows = []
  const bindKeys = new Set()    // bind 行吸收的键,避免引号对兜底重复收录
  const reQuoted = /"([^"\r\n]+)"\s+"([^"\r\n]*)"/g
  let m
  for (const line of text.split(/\r?\n/)) {
    // bind 行(如 bind "w" "+forward"):单独标记为 bind,供分组与中文对照
    const bindline = line.match(/^\s*bind\s+"([^"]+)"\s+"([^"]*)"/i)
    if (bindline) {
      const k = bindline[1].trim(), v = bindline[2].trim()
      bindKeys.add(k)
      bindRows.push([k, v, 'bind'])
      continue
    }
    const bm = line.match(/^\s*([A-Za-z0-9_.-]+)\s+(-?[A-Za-z0-9_.]+)\s*$/)
    if (bm) qMap.set(bm[1].trim(), bm[2].trim())
  }
  while ((m = reQuoted.exec(text))) {
    const k = m[1].trim(), v = m[2].trim()
    if (!bindKeys.has(k)) qMap.set(k, v)
  }
  for (const [k, v] of qMap) rows.push([k, v])
  rows.push(...bindRows)
  return rows
}

// 从 .apexcfg 正文解码出每个文件的键值行(与工具端 Get-FilePairs 同规则)
function cfgDecodePayloadFiles(payloadText) {
  const share = JSON.parse(payloadText)
  const files = []
  for (const [name, meta] of Object.entries(share.files || {})) {
    const bytes = Uint8Array.from(atob(meta.b64), ch => ch.charCodeAt(0))
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
    files.push({ name, rows: cfgParsePairsText(text), raw: text })
  }
  return files
}

// ---------- 键位中英对照表 ----------
function cfgKeyZh(key) {
  const k = String(key).toUpperCase()
  if (/^[A-Z]$/.test(k)) return k + ' 键'
  if (/^([1-9]|0)$/.test(k)) return '数字键 ' + k
  if (/^F(?:[1-9]|1[0-2])$/.test(k)) return '功能键 ' + k
  const named = {
    SPACE: '空格', TAB: 'Tab 键', CAPSLOCK: '大写锁定', SHIFT: 'Shift', CTRL: 'Ctrl', ALT: 'Alt',
    LSHIFT: '左 Shift', RSHIFT: '右 Shift', LCTRL: '左 Ctrl', RCTRL: '右 Ctrl', LALT: '左 Alt', RALT: '右 Alt',
    INS: '插入 Ins', DEL: '删除 Del', HOME: 'Home', END: 'End',
    PGUP: '翻页上 PgUp', PGDN: '翻页下 PgDn', PAUSE: '暂停键',
    LEFTARROW: '方向 ←', RIGHTARROW: '方向 →', UPARROW: '方向 ↑', DOWNARROW: '方向 ↓',
  }
  if (named[k]) return named[k]
  if (k.startsWith('MOUSE')) {
    const n = k.slice(5)
    if (n === '1') return '鼠标左键'
    if (n === '2') return '鼠标右键'
    if (n === '3') return '鼠标中键'
    return '鼠标侧键 ' + n
  }
  if (k === 'WHEELUP' || k === 'MWHEELUP') return '滚轮上'
  if (k === 'WHEELDOWN' || k === 'MWHEELDOWN') return '滚轮下'
  if (k.startsWith('KP_')) {
    const sub = { INS: '0', END: '1', DOWNARROW: '2', PGDN: '3', LEFTARROW: '4', '5': '5', RIGHTARROW: '6', HOME: '7', UPARROW: '8', PGUP: '9', DEL: '.', SLASH: '/', MULTIPLY: '*', MINUS: '-', PLUS: '+', ENTER: 'Enter' }
    const s = sub[k.slice(3)]
    if (s) return '小键盘 ' + s
  }
  return ''
}

const CFG_BIND_ZH = {
  '+forward': '前进', '+back': '后退', '+moveleft': '左平移', '+moveright': '右平移',
  '+jump': '跳跃', '+duck': '蹲下', '+speed': '静步走', '+sprint': '冲刺',
  '+attack': '主攻击(开火)', '+attack2': '次要攻击', '+zoom': '瞄准(ADS)', '+reload': '装填弹药',
  '+melee': '近战攻击', '+use': '交互(拾取/开门/扶人)',
  '+tactical': '战术技能', '+ultimate': '终极技能', '+ping': '标点 / 快速标记',
  '+invnext': '切换下一把武器', '+invprev': '切换上一把武器',
  '+slot1': '切到 1 号武器', '+slot2': '切到 2 号武器', '+slot3': '切到 3 号武器',
  '+invnextnpg': '切换下一把武器(小键盘兼容)', '+inspect': '检视武器',
  '+scores': '计分板', '+map': '打开地图', '+toggle_duck': '蹲下(切换式)',
}

function cfgBindZh(cmd) {
  const t = String(cmd).trim().replace(/^"|"$/g, '').split(/\s+/)[0]
  return CFG_BIND_ZH[t.toLowerCase()] || CFG_BIND_ZH[t] || ''
}

const CFG_DETAIL_ROW_CAP = 400

function cfgBuildDetailHtml(payloadText) {
  let files
  try { files = cfgDecodePayloadFiles(payloadText) }
  catch { return '<div class="cfg-kv-title">配置内容无法解析(损坏或不完整)</div>' }
  return files.map(({ name, rows, raw }, fIdx) => {
    const isVideo = /videoconfig/i.test(name)
    const binds = rows.filter(r => r[2] === 'bind')
    const groups = isVideo
      ? [['画质 / 视频设置', rows]]
      : [
          ['键位对照(原文 + 中文)', binds],
          ['灵敏度 (sensitivity)', rows.filter(r => r[2] !== 'bind' && /sens/i.test(r[0]))],
          ['其他设置', rows.filter(r => r[2] !== 'bind' && !/sens/i.test(r[0]))],
        ]
    const html = groups.filter(g => g[1].length > 0).map(([title, groupRows]) => {
      const isBinds = title.startsWith('键位')
      const body = groupRows.slice(0, CFG_DETAIL_ROW_CAP).map(r => {
        if (isBinds) {
          const keyZh = cfgKeyZh(r[0])
          const cmdZh = cfgBindZh(r[1])
          return `<div class="kv-row3"><span class="kv-key">${esc(r[0])}${keyZh ? `<em>${esc(keyZh)}</em>` : ''}</span><span class="kv-cmd">${esc(r[1])}</span><span class="kv-zh">${cmdZh ? esc(cmdZh) : '<i>自定义指令</i>'}</span></div>`
        }
        return `<div class="kv-row"><span class="kv-k">${esc(r[0])}</span><span class="kv-v">${esc(r[1])}</span></div>`
      }).join('')
      const more = groupRows.length > CFG_DETAIL_ROW_CAP
        ? `<div class="cfg-kv-title">…其余 ${groupRows.length - CFG_DETAIL_ROW_CAP} 行省略</div>`
        : ''
      return `<div class="cfg-kv-group"><div class="cfg-kv-title">${esc(title)} · ${groupRows.length} 项${isBinds ? '(先英文原文,后中文对照)' : ''}</div>${body}${more}</div>`
    }).join('')
    return `<div class="cfg-file"><h4>${esc(name)} <button type="button" class="ghost sm" data-cfg-raw="${fIdx}">查看原文</button></h4>` +
      `<pre class="cfg-raw hidden" id="cfg-raw-${fIdx}">${esc(raw)}</pre>${html || '<div class="cfg-kv-title">(空)</div>'}</div>`
  }).join('')
}

async function cfgToggleDetail(id) {
  const el = $('cfg-detail-' + id)
  if (!el.classList.contains('hidden')) { el.classList.add('hidden'); return }
  el.classList.remove('hidden')
  if (cfgDetailCache[id]) { el.innerHTML = cfgDetailCache[id]; return }
  el.textContent = '解码中…'
  try {
    // 详情接口才携带 payload 正文;不带 count=1, 不会虚增下载次数
    const { config } = await api('GET', '/apex/configs/' + id)
    cfgDetailCache[id] = cfgBuildDetailHtml(config.payload)
    el.innerHTML = cfgDetailCache[id]
  } catch (err) { el.textContent = '加载失败: ' + err.message }
}

$('cfg-more').addEventListener('click', () => loadCfgConfigs())

// 搜索 300ms 防抖, 输入期间不打接口
$('cfg-search').addEventListener('input', (e) => {
  clearTimeout(cfgSearchTimer)
  cfgSearchTimer = setTimeout(() => {
    cfgState.keyword = e.target.value.trim()
    loadCfgConfigs(true)
  }, 300)
})

$('cfg-file').addEventListener('change', async (e) => {
  const file = e.target.files[0]
  const summaryEl = $('cfg-file-summary'), errorEl = $('cfg-publish-error')
  cfgPublishPayload = ''
  cfgHide(summaryEl)
  cfgHide(errorEl)
  if (!file) return
  if (file.size > CFG_MAX_PAYLOAD) {
    errorEl.textContent = '文件超过 512KB,不是有效的配置包(请用工具 export 导出)'
    cfgShow(errorEl)
    e.target.value = ''
    return
  }
  try {
    const text = await file.text()
    const parsed = JSON.parse(text)
    summaryEl.textContent = '✔ ' + cfgSummarize(parsed)
    cfgShow(summaryEl)
    cfgPublishPayload = text
    if (!$('cfg-title').value && parsed.label) $('cfg-title').value = String(parsed.label).slice(0, 60)
  } catch (err) {
    errorEl.textContent = err.name === 'SyntaxError' ? '文件不是有效 JSON' : err.message
    cfgShow(errorEl)
    e.target.value = ''
  }
})

$('cfg-publish-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const errorEl = $('cfg-publish-error')
  cfgHide(errorEl)
  if (!cfgPublishPayload) {
    errorEl.textContent = '请先选择 .apexcfg 文件'
    cfgShow(errorEl)
    return
  }
  const btn = e.target.querySelector('button[type=submit]')
  loading(btn, true)
  try {
    const parsed = JSON.parse(cfgPublishPayload)
    await api('POST', '/apex/configs', {
      title: $('cfg-title').value.trim() || parsed.label || '未命名配置',
      notes: $('cfg-notes').value.trim(),
      payload: cfgPublishPayload,
    })
    toast('已发布到分享广场')
    $('cfg-publish-form').reset()
    cfgPublishPayload = ''
    cfgHide($('cfg-file-summary'))
    await loadCfgConfigs(true)
  } catch (err) {
    errorEl.textContent = err.message
    cfgShow(errorEl)
  } finally { loading(btn, false) }
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