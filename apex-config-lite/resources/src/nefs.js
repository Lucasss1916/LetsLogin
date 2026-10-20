'use strict'
/* Neutralino 运行时桥: 提供 window.apexApi(与 Electron 版同接口)
 * 加载顺序: neutralino.js → fflate → engine.js → 本文件 → app.js
 */
;(async function (global) {
  const NL = global.Neutralino
  const SEP = (global.NL_OS === 'Windows') ? '\\' : '/'

  /* ---------- 路径工具 ---------- */
  const p = {
    sep: SEP,
    join(...parts) {
      const partsList = parts.filter((part) => part !== '' && part != null)
      if (!partsList.length) return ''
      let joined = partsList.join(SEP)
      if (SEP === '\\') joined = joined.replace(/\\{2,}/g, '\\')
      else joined = joined.replace(/\/{2,}/g, '/')
      return joined
    },
    dirname(path) {
      const index = path.lastIndexOf(SEP)
      if (index <= 0) return path
      return path.slice(0, index)
    },
    basename(path) { return path.slice(path.lastIndexOf(SEP) + 1) },
    extname(path) {
      const name = this.basename(path)
      const dot = name.lastIndexOf('.')
      return dot > 0 ? name.slice(dot) : ''
    },
    normalize(path) {
      if (SEP === '\\') return path.replace(/\\{2,}/g, '\\')
      return path.replace(/\/{2,}/g, '/')
    },
    relSlash(base, full) {
      let rel = full.slice(base.length)
      rel = rel.replace(/^[\\/]/, '')
      return rel.split(SEP).join('/')
    },
  }

  /* ---------- Neutralino 文件系统适配 ---------- */
  const fs = {
    async exists(path) {
      try { await NL.filesystem.getStats(path); return true } catch { return false }
    },
    async isDir(path) {
      try { const stat = await NL.filesystem.getStats(path); return !!stat.isDirectory } catch { return false }
    },
    async stat(path) {
      const stat = await NL.filesystem.getStats(path)
      return { size: stat.size || 0, mtimeMs: stat.modifiedAt || 0, isFile: !!stat.isFile }
    },
    async mkdirp(dir) {
      const norm = String(dir).replace(/[\\/]+/g, SEP)
      const parts = norm.split(SEP).filter(Boolean)
      let cur = ''
      let skipFirstCreate = false
      if (/^[A-Za-z]:/.test(parts[0] || '')) {
        cur = parts.shift()          // Windows 盘符根(C:), 不对盘符调 createDirectory
        skipFirstCreate = true
      }
      else if (norm.startsWith(SEP)) { cur = SEP }
      for (const part of parts) {
        cur = cur ? cur + SEP + part : part
        if (cur.endsWith(':') || cur === SEP) continue
        try { await NL.filesystem.createDirectory(cur) } catch { /* 已存在则忽略 */ }
      }
      if (skipFirstCreate) { try { await NL.filesystem.createDirectory(dir) } catch { } }
    },
    async readBinary(path) { return new Uint8Array(await NL.filesystem.readBinaryFile(path)) },
    async readText(path) { return NL.filesystem.readFile(path) },
    async writeBinary(path, data) {
      const buffer = (data instanceof ArrayBuffer) ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
      try { await NL.filesystem.writeBinaryFile(path, buffer) }
      catch (err) { await NL.filesystem.writeBinaryFile(path, new Uint8Array(buffer)) }
    },
    async writeText(path, text) { await NL.filesystem.writeFile(path, text) },
    async rename(from, to) { await NL.filesystem.move(from, to) },
    async unlink(path) { await NL.filesystem.remove(path) },
    async listDir(dir) {
      const entries = await NL.filesystem.readDirectory(dir)
      // v6: {entry, path, type}; 去掉自身/父级
      return entries
        .filter((e) => e.entry !== '.' && e.entry !== '..')
        .map((e) => ({ name: e.entry, type: (String(e.type || '').toUpperCase().includes('DIR') ? 'dir' : 'file') }))
    },
  }

  /* ---------- 哈希 / 压缩 ---------- */
  async function sha256(bytes) {
    const digest = await crypto.subtle.digest('SHA-256', bytes.buffer ? bytes : new Uint8Array(bytes))
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
  }
  const zip = { zipSync: global.fflate.zipSync, unzipSync: global.fflate.unzipSync }

  /* ---------- 引擎组装 ---------- */
  const engine = global.ApexEngine.create({
    fs, p, sha256, zip,
    env: { async home() { return (await NL.os.getEnv(global.NL_OS === 'Windows' ? 'USERPROFILE' : 'HOME')) || '' } },
  })

  /* ---------- 分享广场(fetch 直连, 服务端已开 CORS) ---------- */
  function normalizeBase(base) {
    let s = String(base || '').trim()
    if (!s) throw new Error('请填写服务器地址(例如 http://127.0.0.1:3080)')
    if (!/^https?:\/\//i.test(s)) s = 'http://' + s
    return s.replace(/\/+$/, '')
  }
  async function plazaRequest(base, method, path, { token, body } = {}) {
    const headers = { 'Content-Type': 'application/json' }
    if (token) headers.Authorization = `Bearer ${token}`
    let resp
    try {
      resp = await fetch(normalizeBase(base) + path, {
        method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
      })
    } catch (err) {
      throw new Error(`无法连接服务器(${err.message}); 请确认地址与 LetsLogin 服务是否在运行`)
    }
    let data = null
    try { data = await resp.json() } catch { }
    if (!resp.ok) {
      const err = new Error((data && data.error) || `服务器返回 HTTP ${resp.status}`)
      err.status = resp.status
      throw err
    }
    return data
  }

  /* ---------- apexApi 垫片(与 Electron 版接口一致) ---------- */
  const stateListeners = []
  const handlers = {
    appInfo: async () => ({ version: engine.ToolVersion, platform: global.NL_OS }),
    detectDirs: async () => engine.candidateDirs(),
    resolveDir: (payload = {}) => engine.resolveDir(payload.explicit, !!payload.createDir),
    readDetail: (payload = {}) => engine.readDetail(payload),
    listBackups: (payload = {}) => engine.listBackups(payload),
    backup: (payload = {}) => engine.backup(payload),
    restore: (payload = {}) => engine.restoreZip(payload),
    exportConfig: (payload = {}) => engine.exportConfig(payload),
    importShare: (payload = {}) => engine.importShare(payload),
    shareInfo: (payload = {}) => engine.shareInfo(payload),

    'plaza:login': (payload = {}) => plazaRequest(payload.base, 'POST', '/api/auth/login', { body: { username: payload.username, password: payload.password } }),
    'plaza:list': (payload = {}) => plazaRequest(payload.base, 'GET', `/api/apex/configs?limit=${payload.limit || 12}&offset=${payload.offset || 0}&search=${encodeURIComponent(payload.search || '')}`, { token: payload.token }),
    'plaza:get': (payload = {}) => plazaRequest(payload.base, 'GET', `/api/apex/configs/${Number(payload.id)}${payload.count ? '?count=1' : ''}`, { token: payload.token }),
    'plaza:delete': (payload = {}) => plazaRequest(payload.base, 'DELETE', `/api/apex/configs/${Number(payload.id)}`, { token: payload.token }),
    'plaza:download': async (payload = {}) => {
      const data = await plazaRequest(payload.base, 'GET', `/api/apex/configs/${Number(payload.id)}?count=1`, { token: payload.token })
      await fs.writeText(payload.savePath, data.config.payload + '\n')
      return { ok: true, path: payload.savePath, label: data.config.title }
    },
    'plaza:import': async (payload = {}) => {
      const data = await plazaRequest(payload.base, 'GET', `/api/apex/configs/${Number(payload.id)}?count=1`, { token: payload.token })
      const result = await engine.importPayload({ raw: data.config.payload, dir: payload.dir })
      return { ...result, from: '分享广场' }
    },
  }

  // 发布直传(不落盘): 直接从快照构建分享对象
  async function buildPayloadNoWrite(dir, label, note) {
    const dirPath = await engine.resolveDir(dir, false)
    const { items } = await engine.snapshot(dirPath)
    if (!items.length) throw new Error(`目录中没有可识别的配置文件(.cfg/.txt/.ini): ${dirPath}`)
    const files = {}
    for (const it of items) files[it.name] = { b64: global.ApexEngine.toB64(it.data), sha256: it.hex }
    const stampNow = global.ApexEngine.stamp()
    return {
      kind: 'apexcfg', format: 1, tool_version: engine.ToolVersion, game: 'Apex Legends',
      created_at: new Date().toISOString().replace(/\.\d+Z$/, '+00:00'),
      label: label || `Apex 配置 ${stampNow}`, note: note || '',
      preview: engine.newPreview(items), files,
    }
  }
  handlers['plaza:publish'] = async (payload = {}) => {
    let raw = ''
    if (payload.sharePath) raw = await fs.readText(payload.sharePath)
    else raw = JSON.stringify(await buildPayloadNoWrite(payload.dir, payload.title, payload.notes))
    return plazaRequest(payload.base, 'POST', '/api/apex/configs', { token: payload.token, body: { title: payload.title, notes: payload.notes, payload: raw } })
  }

  /* ---------- ready 队列 ---------- */
  let readyResolve = null
  const readyPromise = new Promise((resolve) => { readyResolve = resolve })
  async function gated(handler, payload) {
    await readyPromise
    return handler(payload)
  }

  global.apexApi = {
    invoke: (op, payload = {}) => {
      const handler = handlers[op]
      if (!handler) return Promise.reject(new Error(`未知操作: ${op}`))
      try { return gated(handler, payload) } catch (err) { return Promise.reject(err) }
    },
    pickSave: async (opts = {}) => {
      await readyPromise
      const path = await NL.os.showSaveDialog(opts.title || '保存', { defaultPath: opts.defaultPath, filters: opts.filters })
      return path || null
    },
    pickOpen: async (opts = {}) => {
      await readyPromise
      const list = await NL.os.showOpenDialog(opts.title || '选择文件', { filters: opts.filters, multiSelections: false })
      return (list && list.length) ? list[0] : null
    },
    openPath: async (target) => { await readyPromise; await NL.os.open(target); return target },
    window: {
      minimize: () => NL.window.minimize(),
      toggleMaximize: async () => {
        if (await NL.window.isMaximized()) await NL.window.unmaximize()
        else await NL.window.maximize()
        const maximized = await NL.window.isMaximized()
        stateListeners.forEach((cb) => cb({ maximized }))
      },
      close: () => NL.app.exit(),
      onState: (callback) => stateListeners.push(callback),
    },
  }

  /* ---------- 启动 ---------- */
  NL.init()
  if (NL.window && NL.window.setDraggableRegion) {
    NL.events.on('ready', async () => {
      try { await NL.window.setDraggableRegion('titlebar', { exclude: [document.getElementById('btn-wmin'), document.getElementById('btn-wmax'), document.getElementById('btn-wclose')] }) }
      catch { /* 拖拽失败仅影响标题栏手感 */ }
      readyResolve()
    })
  }
  else { NL.events.on('ready', readyResolve) }
  NL.events.on('serverOffline', () => global.setStatus && global.setStatus('Neutralino 内部服务离线, 请重启应用', 'err'))
  NL.events.on('windowClose', async () => { await NL.app.exit() })
})(window)
