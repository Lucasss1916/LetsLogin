'use strict'
/* 渲染层逻辑: 只做取数与展示, 配置核心在主进程 backend.js */
const $ = (id) => document.getElementById(id)

const state = {
  dir: '',
  rows: [],            // 当前配置的全部键值行 [{file, group, key, value}]
  groupFilter: '全部',
  backups: [],         // 备份行
  selectedBackup: null,
  sharePath: '',
}

const GROUPS = ['全部', '键位', '灵敏度', '画质', '其他']

/* ---------- 小工具 ---------- */
function esc(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

function groupTag(group) {
  const cls = { 键位: 'bind', 灵敏度: 'sens', 画质: 'video', 其他: 'other' }[group] || 'other'
  return `<span class="tag ${cls}">${esc(group)}</span>`
}

function classifyGroup(fileName, key) {
  if (/videoconfig/i.test(fileName)) return '画质'
  const low = key.toLowerCase()
  if (low.includes('bind')) return '键位'
  if (low.includes('sens')) return '灵敏度'
  return '其他'
}

function setStatus(message, kind = 'info') {
  const bar = $('statusbar')
  bar.classList.remove('err', 'ok')
  if (kind === 'err') bar.classList.add('err')
  if (kind === 'ok') bar.classList.add('ok')
  $('status-text').textContent = message
}

let toastTimer = null
function showToast(message) {
  const toast = $('toast')
  toast.textContent = message
  toast.classList.remove('hidden')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 3600)
}

function confirmModal(title, text) {
  return new Promise((resolve) => {
    $('modal-title').textContent = title
    $('modal-text').textContent = text
    $('modal-mask').classList.remove('hidden')
    const done = (answer) => {
      $('modal-mask').classList.add('hidden')
      $('modal-ok').onclick = null
      $('modal-cancel').onclick = null
      resolve(answer)
    }
    $('modal-ok').onclick = () => done(true)
    $('modal-cancel').onclick = () => done(false)
  })
}

/* ---------- 配置页 ---------- */
function buildGroupChips() {
  const counts = { 全部: state.rows.length }
  for (const g of GROUPS.slice(1)) counts[g] = 0
  for (const row of state.rows) counts[row.group] = (counts[row.group] || 0) + 1
  $('cfg-chips').innerHTML = GROUPS.map((g) =>
    `<button class="chip${g === state.groupFilter ? ' active' : ''}" data-group="${esc(g)}">${esc(g)} ${counts[g] ?? 0}</button>`
  ).join('')
}

function renderCfgTable() {
  const keyword = $('cfg-filter').value.trim().toLowerCase()
  const rows = state.rows.filter((r) => {
    if (state.groupFilter !== '全部' && r.group !== state.groupFilter) return false
    if (!keyword) return true
    return r.key.toLowerCase().includes(keyword) || String(r.value).toLowerCase().includes(keyword)
  })
  $('cfg-count').textContent = `显示 ${rows.length} / ${state.rows.length} 项`
  if (!state.rows.length) {
    $('cfg-table-wrap').innerHTML = '<div class="empty-tip">目录中没有解析到任何键值; 请确认配置目录, 或点「刷新」</div>'
    return
  }
  if (!rows.length) {
    $('cfg-table-wrap').innerHTML = '<div class="empty-tip">没有匹配筛选条件的项</div>'
    return
  }
  const body = rows.map((r) => `
    <tr>
      <td class="file-cell">${esc(r.file)}</td>
      <td>${groupTag(r.group)}</td>
      <td class="kv-key">${esc(r.key)}</td>
      <td class="kv-val">${esc(r.value)}</td>
    </tr>`).join('')
  $('cfg-table-wrap').innerHTML = `
    <table>
      <thead><tr><th style="width:170px">文件</th><th style="width:88px">分组</th><th style="width:36%">键</th><th>值</th></tr></thead>
      <tbody>${body}</tbody>
    </table>`
}

async function loadDetail() {
  setStatus('读取配置中…')
  const detail = await window.apexApi.invoke('readDetail', { dir: $('dir-input').value.trim() })
  state.dir = detail.dir
  $('dir-input').value = detail.dir
  state.rows = []
  for (const file of detail.files || []) {
    for (const [key, value] of file.rows) {
      state.rows.push({ file: file.name, group: classifyGroup(file.name, key), key, value })
    }
  }
  buildGroupChips()
  renderCfgTable()
  const warnText = (detail.warnings || []).length ? '; ' + detail.warnings.join('; ') : ''
  setStatus(`已加载 ${detail.dir} · ${state.rows.length} 项设置${warnText}`, 'ok')
}

async function loadBackups() {
  const data = await window.apexApi.invoke('listBackups', { dir: $('dir-input').value.trim() })
  state.backups = data.rows || []
  state.selectedBackup = null
  renderBackupTable()
}

function renderBackupTable() {
  if (!state.backups.length) {
    $('bk-table-wrap').innerHTML = '<div class="empty-tip">备份夹是空的 — 点「① 备份当前配置」创建第一份备份</div>'
    return
  }
  const body = state.backups.map((b, i) => `
    <tr data-index="${i}" class="${state.selectedBackup === i ? 'selected' : ''}">
      <td class="kv-key">${esc(b.name)}</td>
      <td>${esc(b.time)}</td>
      <td>${esc(b.fileCount)}</td>
      <td>${esc(b.sizeText)}</td>
      <td>${b.kind === '手动备份' ? esc(b.kind) : `<span class="tag safety">${esc(b.kind)}</span>`}</td>
      <td class="kv-key">${esc(b.fingerprint || '')}</td>
    </tr>`).join('')
  $('bk-table-wrap').innerHTML = `
    <table>
      <thead><tr><th style="width:30%">备份文件</th><th style="width:170px">时间</th><th style="width:64px">文件数</th><th style="width:84px">大小</th><th style="width:110px">类型</th><th>指纹</th></tr></thead>
      <tbody>${body}</tbody>
    </table>`
}

/* ---------- 动作 ---------- */
async function doBackup() {
  try {
    setStatus('备份中…')
    const result = await window.apexApi.invoke('backup', {
      dir: $('dir-input').value.trim(),
      keep: Number($('keep-input').value) || 20,
      force: false,
    })
    await loadBackups()
    if (result.skipped) {
      setStatus(result.message, 'ok')
      showToast('配置无变化, 已跳过备份')
    } else {
      setStatus(`备份完成: ${result.path} (文件 ${result.files}, 清理旧备份 ${result.removed} 份)`, 'ok')
      showToast('备份完成 ✓')
    }
  } catch (err) { setStatus(`备份失败: ${err.message}`, 'err') }
}

async function doRestore() {
  if (state.selectedBackup === null) {
    setStatus('请先在列表中选中一个备份包', 'err')
    return
  }
  const target = state.backups[state.selectedBackup]
  const yes = await confirmModal('确认恢复', `用 [${target.name}] 覆盖当前配置?\n\n恢复前会自动为当前状态生成安全包(pre-restore-*.zip), 出问题随时恢复回去。`)
  if (!yes) return
  try {
    setStatus('恢复中…')
    const result = await window.apexApi.invoke('restore', { zipPath: target.path, dir: $('dir-input').value.trim() })
    await Promise.all([loadDetail(), loadBackups()])
    setStatus(`恢复完成 (写入 ${result.written.length}, 已一致 ${result.identical.length}); 安全包: ${result.safety ? result.safety.split(/[\\/]/).pop() : '无'}`, 'ok')
    showToast('恢复完成 ✓')
  } catch (err) { setStatus(`恢复失败: ${err.message}`, 'err') }
}

async function doExport() {
  try {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')
    const outPath = await window.apexApi.pickSave({
      title: '导出分享文件',
      defaultPath: `apex-export-${stamp}.apexcfg`,
      filters: [{ name: 'Apex 配置分享', extensions: ['apexcfg'] }],
    })
    if (!outPath) return
    setStatus('导出中…')
    const result = await window.apexApi.invoke('exportConfig', {
      dir: $('dir-input').value.trim(),
      outPath,
      label: $('share-label').value.trim(),
      note: $('share-note').value.trim(),
    })
    $('export-result').innerHTML = `<strong>${esc(result.label)}</strong><br>已导出: ${esc(result.path)}<br>包含 ${result.files} 个配置文件 — 可到网页「Apex 配置」面板发布到分享广场。`
    setStatus(`已导出: ${result.path}`, 'ok')
    showToast('导出完成 ✓')
  } catch (err) { setStatus(`导出失败: ${err.message}`, 'err') }
}

async function doPickShare() {
  try {
    const picked = await window.apexApi.pickOpen({
      title: '选择要导入的 .apexcfg 分享文件',
      filters: [
        { name: 'Apex 配置分享', extensions: ['apexcfg'] },
        { name: 'JSON', extensions: ['json'] },
      ],
    })
    if (!picked) return
    state.sharePath = picked
    const info = await window.apexApi.invoke('shareInfo', { sharePath: picked })
    const sens = info.preview && info.preview.sensitivity ? info.preview.sensitivity : {}
    const sensText = Object.entries(sens).slice(0, 4).map(([k, v]) => `${k}=${v}`).join(', ')
    $('share-info').innerHTML = `
      <strong>${esc(info.label || '(无标题)')}</strong><br>
      文件: ${esc(info.files.join(', '))}${info.files.length > 3 ? ` 等 ${info.files.length} 个` : ''}<br>
      ${sensText ? `灵敏度: ${esc(sensText)}<br>` : ''}
      键位条目: ${esc(info.preview && info.preview.binds_count != null ? info.preview.binds_count : '?')}<br>
      导出时间: ${esc(String(info.created_at || '').replace('T', ' '))}`
    $('btn-import').disabled = false
    setStatus('分享文件已就绪, 点击「应用该配置」以导入', 'ok')
  } catch (err) { setStatus(`读取分享文件失败: ${err.message}`, 'err') }
}

async function doImport() {
  if (!state.sharePath) return
  const yes = await confirmModal('确认导入', '应用该配置会覆盖同名键的设置。\n\n应用前会自动为当前配置生成安全包(pre-import-*.zip), 出问题随时恢复回去。\n\n确定应用?')
  if (!yes) return
  try {
    setStatus('导入中…')
    const result = await window.apexApi.invoke('importShare', { sharePath: state.sharePath, dir: $('dir-input').value.trim() })
    await Promise.all([loadDetail(), loadBackups()])
    switchTab('config')
    setStatus(`导入完成 (写入 ${result.written.length}, 已一致 ${result.identical.length}); 安全包: ${result.safety ? result.safety.split(/[\\/]/).pop() : '无'}`, 'ok')
    showToast('导入完成 ✓ 重启 Apex 生效')
  } catch (err) { setStatus(`导入失败: ${err.message}`, 'err') }
}

async function reloadAll() {
  try {
    await loadDetail()
    await loadBackups()
  } catch (err) { setStatus(err.message, 'err') }
}

/* ---------- 事件绑定 ---------- */
function switchTab(name) {
  document.querySelectorAll('.nav-item').forEach((el) => el.classList.toggle('active', el.dataset.tab === name))
  document.querySelectorAll('.tab').forEach((el) => el.classList.toggle('active', el.id === `tab-${name}`))
}

$('nav').addEventListener('click', (event) => {
  const item = event.target.closest('.nav-item')
  if (item) switchTab(item.dataset.tab)
})

$('btn-detect').addEventListener('click', async () => {
  try {
    const dir = await window.apexApi.invoke('resolveDir', { explicit: '', createDir: false })
    $('dir-input').value = dir
    await reloadAll()
  } catch (err) { setStatus(`未自动找到配置目录: ${err.message.split('\n')[0]}; 可手动填入路径后点「刷新」`, 'err') }
})

$('btn-reload').addEventListener('click', reloadAll)

$('btn-open-dir').addEventListener('click', async () => {
  try {
    const dir = await window.apexApi.invoke('resolveDir', { explicit: $('dir-input').value.trim(), createDir: false })
    await window.apexApi.openPath(dir)
  } catch (err) { setStatus(`打开目录失败: ${err.message}`, 'err') }
})

$('dir-input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') reloadAll()
})

$('cfg-filter').addEventListener('input', renderCfgTable)

$('cfg-chips').addEventListener('click', (event) => {
  const chip = event.target.closest('.chip')
  if (!chip) return
  state.groupFilter = chip.dataset.group
  buildGroupChips()
  renderCfgTable()
})

$('bk-table-wrap').addEventListener('click', (event) => {
  const row = event.target.closest('tr[data-index]')
  if (!row) return
  state.selectedBackup = Number(row.dataset.index)
  renderBackupTable()
})

$('btn-backup').addEventListener('click', doBackup)
$('btn-restore').addEventListener('click', doRestore)

$('btn-open-backups').addEventListener('click', async () => {
  try {
    const data = await window.apexApi.invoke('listBackups', { dir: $('dir-input').value.trim() })
    await window.apexApi.openPath(data.backupDir)
  } catch (err) { setStatus(`打开备份夹失败: ${err.message}`, 'err') }
})

$('btn-export').addEventListener('click', doExport)
$('btn-pick-share').addEventListener('click', doPickShare)
$('btn-import').addEventListener('click', doImport)

$('dir-input').focus()
;(async function init() {
  const info = await window.apexApi.invoke('appInfo')
  $('side-version').textContent = `v${info.version} · 引擎互通版`
  await reloadAll()
})().catch((err) => setStatus(err.message, 'err'))

/* ================= 自绘窗口控制 (frameless) ================= */
window.apexApi.window.onState((state) => {
  $('btn-wmax').classList.toggle('maximized', !!(state && state.maximized))
})
$('btn-wmin').addEventListener('click', () => window.apexApi.window.minimize())
$('btn-wmax').addEventListener('click', () => window.apexApi.window.toggleMaximize())
$('btn-wclose').addEventListener('click', () => window.apexApi.window.close())

/* ================= 分享广场 (LetsLogin 网页功能) ================= */
const plazaState = { base: '', token: '', user: null, items: [], offset: 0, hasMore: false, search: '', detail: null }

const PZ_TITLE_MAX = 60
const PZ_NOTES_MAX = 300

function plazaAuthed() { return !!(plazaState.token && plazaState.user) }

function plazaSetLoginView() {
  $('pz-main').classList.toggle('hidden', !plazaAuthed())
  $('pz-locked').classList.toggle('hidden', plazaAuthed())
  $('btn-pz-logout').classList.toggle('hidden', !plazaAuthed())
  $('btn-pz-login').textContent = plazaAuthed() ? '已登录' : '登 录'
}

function isAuthError(message) {
  return typeof message === 'string' && /未登录|登录已过期|登录已失效/.test(message)
}

function plazaError(err) {
  if (isAuthError(err.message)) {
    plazaState.token = ''
    plazaState.user = null
    plazaSetLoginView()
    setStatus('登录已过期, 请重新登录', 'err')
  }
  else setStatus(err.message, 'err')
}

function pairsFromText(text) {
  const rows = []
  const quoted = new Map()
  const reQuoted = /"([^"\r\n]+)"\s+"([^"\r\n]*)"/g
  let m
  while ((m = reQuoted.exec(text))) quoted.set(m[1].trim(), m[2].trim())
  for (const [k, v] of quoted) rows.push([k, v])
  for (const line of text.split(/\r?\n/)) {
    const bare = line.match(/^\s*([A-Za-z0-9_.-]+)\s+(-?[A-Za-z0-9_.]+)\s*$/)
    if (bare && !quoted.has(bare[1].trim())) rows.push([bare[1].trim(), bare[2].trim()])
  }
  return rows
}

function briefChips(preview) {
  const chips = []
  const sens = (preview && preview.sensitivity) || {}
  for (const [k, v] of Object.entries(sens).slice(0, 3)) chips.push(`${k.slice(0, 26)} = ${v}`)
  if (preview && preview.binds_count != null) chips.push(`键位 ${preview.binds_count}`)
  return chips.map((t) => `<span class="pz-chip">${esc(t)}</span>`).join('')
}

function timeShort(iso) {
  return String(iso || '').replace('T', ' ').slice(0, 16)
}

function renderPlaza() {
  const wrap = $('pz-list')
  if (!plazaState.items.length) {
    wrap.innerHTML = '<div class="empty-tip">分享广场还没有配置, 点右上角「发布我的当前配置」当第一个分享的人</div>'
    return
  }
  wrap.innerHTML = plazaState.items.map((c) => {
    const mine = plazaState.user && c.author === plazaState.user.username
    const buttons = [
      `<button class="btn" data-pz-detail="${c.id}">查看明细</button>`,
      `<button class="btn primary" data-pz-import="${c.id}">⤒ 导入此配置</button>`,
      mine ? `<button class="btn ghost" data-pz-del="${c.id}">删除</button>` : '',
    ].join('')
    return `
      <div class="pz-card">
        <div class="pz-maininfo">
          <div class="pz-title">${esc(c.title)}</div>
          <div class="pz-sub">${esc(c.author || '')} · ${timeShort(c.created_at)} · 配置 ${c.file_count} 文件 · ${(c.payload_bytes / 1024).toFixed(1)}KB · 下载 ${c.downloads}${mine ? ' · 我发布的' : ''}</div>
          <div class="pz-chips">${briefChips(c.preview)}</div>
        </div>
        <div class="pz-actions">${buttons}</div>
      </div>`
  }).join('')
}

async function plazaLoad(reset = false) {
  const search = $('pz-search').value.trim()
  if (reset) { plazaState.offset = 0; plazaState.items = [] }
  try {
    const data = await window.apexApi.invoke('plaza:list', {
      base: plazaState.base, token: plazaState.token,
      limit: 12, offset: plazaState.offset, search,
    })
    const items = (data.configs || []).map((c) => ({ ...c, preview: c.preview || {} }))
    plazaState.items = reset ? items : plazaState.items.concat(items)
    plazaState.offset = plazaState.items.length
    plazaState.hasMore = !!data.hasMore
    $('pz-count').textContent = `已显示 ${plazaState.items.length} 条${search ? ` (搜索: ${search})` : ''}`
    $('btn-pz-more').classList.toggle('hidden', !plazaState.hasMore)
    renderPlaza()
  }
  catch (err) { plazaError(err) }
}

async function plazaLogin() {
  try {
    const base = $('pz-base').value.trim()
    const username = $('pz-user').value.trim()
    const password = $('pz-pass').value
    setStatus('登录中…')
    const result = await window.apexApi.invoke('plaza:login', { base, username, password })
    plazaState.base = base.replace(/\/+$/, '')
    plazaState.token = result.token
    plazaState.user = result.user
    localStorage.setItem('apex_gui_base', plazaState.base)
    plazaSetLoginView()
    $('pz-pass').value = ''
    setStatus(`登录成功: ${result.user.username}`, 'ok')
    await plazaLoad(true)
  }
  catch (err) { setStatus(`登录失败: ${err.message}`, 'err') }
}

function plazaLogout() {
  plazaState.token = ''
  plazaState.user = null
  plazaState.items = []
  plazaState.detail = null
  $('btn-pz-more').classList.add('hidden')
  $('pz-count').textContent = ''
  plazaSetLoginView()
  setStatus('已退出登录')
}

async function plazaPublish() {
  const title = $('share-label').value.trim() || ''
  const notes = $('share-note').value.trim()
  if (!title) { setStatus('请先在下方输入框填写标题 (也可以在「导出 / 导入」页填写)', 'err'); return }
  if (title.length > PZ_TITLE_MAX || notes.length > PZ_NOTES_MAX) {
    setStatus(`标题不超过 ${PZ_TITLE_MAX} 字, 备注不超过 ${PZ_NOTES_MAX} 字`, 'err')
    return
  }
  const yes = await confirmModal('发布到分享广场', `标题: ${title}\n所有人可见并可直接导入, 确定发布?`)
  if (!yes) return
  try {
    setStatus('发布中…')
    const result = await window.apexApi.invoke('plaza:publish', {
      base: plazaState.base, token: plazaState.token, title, notes,
      dir: $('dir-input').value.trim(),
    })
    await plazaLoad(true)
    switchTab('plaza')
    setStatus(`发布成功 (#${result.id}, ${result.fileCount} 个配置文件)`, 'ok')
    showToast('已发布到分享广场 ✓')
  }
  catch (err) { plazaError(err) }
}

let detailId = null

function renderDetailRows() {
  const detail = plazaState.detail
  if (!detail) return
  let files = []
  try {
    const share = JSON.parse(detail.payload)
    files = Object.entries(share.files || {}).map(([name, meta]) => ({
      name,
      rows: pairsFromText(new TextDecoder('utf-8', { fatal: false }).decode(Uint8Array.from(atob(meta.b64), (ch) => ch.charCodeAt(0)))),
    }))
  }
  catch {
    $('detail-rows').innerHTML = '<div class="empty-tip">配置内容无法解析</div>'
    return
  }
  const cap = 400
  $('detail-rows').innerHTML = files.map(({ name, rows }) => {
    const body = rows.slice(0, cap).map(([k, v]) => `
      <tr><td class="file-cell">${esc(name)}</td>
      <td class="kv-key">${esc(k)}</td>
      <td class="kv-val">${esc(v)}</td></tr>`).join('')
    const more = rows.length > cap ? `<div class="empty-tip">…其余 ${rows.length - cap} 行省略</div>` : ''
    return `<table><thead><tr><th style="width:160px">文件</th><th style="width:36%">键</th><th>值</th></tr></thead><tbody>${body}</tbody></table>${more}`
  }).join('')
}

async function plazaDetail(id) {
  try {
    setStatus('加载详情…')
    const data = await window.apexApi.invoke('plaza:get', { base: plazaState.base, token: plazaState.token, id })
    plazaState.detail = data.config
    detailId = id
    $('detail-title').textContent = data.config.title
    $('detail-meta').textContent = `${data.config.author || ''} · ${timeShort(data.config.created_at)} · ${data.config.file_count} 文件 · 下载 ${data.config.downloads}`
    $('detail-hint').textContent = `备注: ${data.config.notes || '—'}`
    renderDetailRows()
    $('detail-overlay').classList.remove('hidden')
    setStatus('')
  }
  catch (err) { plazaError(err) }
}

async function plazaImport(id) {
  const yes = await confirmModal('导入此配置', '将用分享的键位/设置覆盖本地(同名键)。\n\n应用前会自动为当前配置生成安全包(pre-import-*.zip), 可随时恢复。\n\n确定导入?')
  if (!yes) return
  try {
    setStatus('导入中…')
    const result = await window.apexApi.invoke('plaza:import', {
      base: plazaState.base, token: plazaState.token, id,
      dir: $('dir-input').value.trim(),
    })
    $('detail-overlay').classList.add('hidden')
    await Promise.all([loadDetail(), loadBackups()])
    switchTab('config')
    setStatus(`导入完成 (写入 ${result.written.length}, 已一致 ${result.identical.length}); 安全包: ${result.safety ? result.safety.split(/[\\/]/).pop() : '无'}`, 'ok')
    showToast('导入完成 ✓ 重启 Apex 生效')
  }
  catch (err) { plazaError(err) }
}

async function plazaDownload(id) {
  try {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')
    const savePath = await window.apexApi.pickSave({
      title: '下载分享配置',
      defaultPath: `apex-share-${stamp}.apexcfg`,
      filters: [{ name: 'Apex 配置分享', extensions: ['apexcfg'] }],
    })
    if (!savePath) return
    await window.apexApi.invoke('plaza:download', { base: plazaState.base, token: plazaState.token, id, savePath })
    setStatus(`已下载: ${savePath}`, 'ok')
    showToast('下载完成 ✓')
  }
  catch (err) { plazaError(err) }
}

async function plazaDelete(id) {
  const yes = await confirmModal('删除分享', '确定从分享广场删除这条配置?')
  if (!yes) return
  try {
    await window.apexApi.invoke('plaza:delete', { base: plazaState.base, token: plazaState.token, id })
    await plazaLoad(true)
    setStatus('已删除', 'ok')
  }
  catch (err) { plazaError(err) }
}

$('btn-pz-login').addEventListener('click', plazaLogin)
$('pz-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') plazaLogin() })
$('pz-user').addEventListener('keydown', (e) => { if (e.key === 'Enter') plazaLogin() })
$('btn-pz-logout').addEventListener('click', plazaLogout)
$('btn-pz-refresh').addEventListener('click', () => plazaLoad(true))
$('btn-pz-more').addEventListener('click', () => plazaLoad(false))
$('btn-pz-publish').addEventListener('click', plazaPublish)
$('pz-search').addEventListener('keydown', (e) => { if (e.key === 'Enter') plazaLoad(true) })
$('pz-list').addEventListener('click', (event) => {
  const detailBtn = event.target.closest('[data-pz-detail]')
  if (detailBtn) return plazaDetail(Number(detailBtn.dataset.pzDetail))
  const importBtn = event.target.closest('[data-pz-import]')
  if (importBtn) return plazaImport(Number(importBtn.dataset.pzImport))
  const delBtn = event.target.closest('[data-pz-del]')
  if (delBtn) return plazaDelete(Number(delBtn.dataset.pzDel))
})
$('btn-detail-close').addEventListener('click', () => $('detail-overlay').classList.add('hidden'))
$('btn-detail-download').addEventListener('click', () => { if (detailId) plazaDownload(detailId) })
$('btn-detail-import').addEventListener('click', () => { if (detailId) plazaImport(detailId) })
$('detail-overlay').addEventListener('click', (event) => {
  if (event.target.id === 'detail-overlay') $('detail-overlay').classList.add('hidden')
})

plazaSetLoginView()
$('pz-base').value = localStorage.getItem('apex_gui_base') || 'http://127.0.0.1:3080'
