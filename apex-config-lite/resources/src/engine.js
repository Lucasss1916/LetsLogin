'use strict'
/* ApexConfigTool Lite — 配置核心引擎(纯逻辑, 存储能力全部注入)
 * 与 PowerShell 控制台版 / Electron 版行为对齐: 同 manifest/.apexcfg 格式、同校验与安全包规则。
 * create({ fs, p, sha256, zip, env }) — fs/p/zip/env 由运行环境提供:
 *   浏览器(Neutralino): resources/src/nefs.js;  Node 自测: test/nodefs.js
 */
;(function (global) {
  const ToolVersion = '2.2.0'
  const FormatVersion = 1
  const MaxFileBytes = 8 * 1024 * 1024
  const MaxTotalBytes = 32 * 1024 * 1024
  const MaxFiles = 64
  const BackupPrefix = 'apex-backup-'
  const IncludeSuffix = ['.cfg', '.txt', '.ini']

  const bytesOf = (u8) => (u8 instanceof Uint8Array ? u8 : new Uint8Array(u8))

  function pad2(num) { return String(num).padStart(2, '0') }
  function stamp(d = new Date()) {
    return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`
  }
  function fmtTime(d) {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
  }
  function formatSize(num) {
    if (num >= 1048576) return `${(num / 1048576).toFixed(1)}MB`
    if (num >= 1024) return `${(num / 1024).toFixed(1)}KB`
    return `${Math.floor(num)}B`
  }

  function utf8(text) { return new TextEncoder().encode(text) }
  function fromUtf8(bytes) { return new TextDecoder('utf-8', { fatal: false }).decode(bytes) }
  function toB64(bytes) {
    const arr = bytesOf(bytes)
    let s = ''
    for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i])
    return btoa(s)
  }
  function fromB64(text) {
    const bin = atob(String(text).trim())
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  }

  function create(ctx) {
    const { fs, p, zip, env } = ctx
    const sha256 = ctx.sha256

    /* ---------- 目录定位 ---------- */
    function candidateDirs() {
      const home = env.home()
      const j = (...parts) => p.join(home, ...parts)
      return [
        j('Saved Games', 'Respawn', 'Apex', 'local'),
        j('Documents', 'Respawn', 'Apex', 'local'),
        j('OneDrive', 'Documents', 'Respawn', 'Apex', 'local'),
      ]
    }

    async function resolveDir(explicit = '', createDir = false) {
      const raw = String(explicit || '').trim()
      if (raw) {
        let full = raw
        if (full === '~') full = env.home()
        else if (/^~[\\/]/.test(full)) full = p.join(env.home(), full.slice(2))
        full = p.normalize(full)
        if (createDir) await fs.mkdirp(full)
        if (!(await fs.isDir(full))) throw new Error(`目录不存在: ${full}`)
        return full
      }
      for (const dir of candidateDirs()) {
        if (await fs.isDir(dir)) return dir
      }
      if (createDir) {
        const made = candidateDirs()[0]
        await fs.mkdirp(made)
        return made
      }
      throw new Error(`未找到 Apex 配置目录,已尝试:\n  ${candidateDirs().join('\n  ')}\n请手动填入配置目录路径`)
    }

    function backupsDirOf(localDir) {
      return p.join(p.dirname(localDir), 'apex-backups')
    }

    /* ---------- 快照 ---------- */
    async function listConfigFiles(dir) {
      const found = []
      async function walk(cur) {
        let entries = []
        try { entries = await fs.listDir(cur) } catch { return }
        for (const ent of entries) {
          const full = p.join(cur, ent.name)
          if (ent.type === 'dir') await walk(full)
          else if (IncludeSuffix.includes(p.extname(ent.name).toLowerCase())) found.push(full)
        }
      }
      await walk(dir)
      found.sort()
      return found
    }

    async function fingerprintOf(items) {
      const lines = [...items].sort((a, b) => (a.name < b.name ? -1 : 1)).map((it) => `${it.name}:${it.hex}`).join('\n')
      return await sha256(utf8(lines))
    }

    async function snapshot(dir) {
      const items = []
      const warnings = []
      let total = 0
      for (const filePath of await listConfigFiles(dir)) {
        const data = await fs.readBinary(filePath)
        total += data.length
        if (total > MaxTotalBytes) throw new Error(`配置文件总体积超过上限 ${formatSize(MaxTotalBytes)}`)
        if (data.length > MaxFileBytes) {
          warnings.push(`警告: 跳过大文件(${formatSize(data.length)}): ${p.basename(filePath)}`)
          total -= data.length
          continue
        }
        const rel = p.relSlash(dir, filePath)
        items.push({ name: rel, data, size: data.length, hex: await sha256(data) })
      }
      return { items, warnings }
    }

    function newManifest(kind, items, fingerprint) {
      return {
        kind,
        tool_version: ToolVersion,
        created_at: new Date().toISOString().replace(/\.\d+Z$/, '+00:00'),
        fingerprint,
        files: items.map((it) => ({ name: it.name, size: it.size, sha256: it.hex })),
      }
    }

    async function writeBackupZip(zipPath, items, manifest) {
      const entries = { 'manifest.json': utf8(JSON.stringify(manifest, null, 2)) }
      for (const it of items) entries['files/' + it.name] = it.data
      const zipped = zip.zipSync(entries)
      await fs.mkdirp(p.dirname(zipPath))
      await fs.writeBinary(zipPath, zipped)
    }

    async function uniqueDest(dir, base) {
      let dest = p.join(dir, base + '.zip')
      let serial = 2
      while (await fs.exists(dest)) {
        dest = p.join(dir, `${base}-${serial}.zip`)
        serial += 1
      }
      return dest
    }

    async function zipZipNames(backupDir) {
      try {
        return (await fs.listDir(backupDir)).filter((e) => e.type === 'file' && e.name.toLowerCase().endsWith('.zip')).map((e) => e.name)
      } catch { return [] }
    }

    async function readManifestFromZip(zipPath) {
      const bytes = await fs.readBinary(zipPath)
      const files = zip.unzipSync(bytes)
      if (!files['manifest.json']) throw new Error('备份包缺少 manifest.json, 不是本工具生成的包')
      return JSON.parse(fromUtf8(files['manifest.json']))
    }

    async function mtimeDesc(paths) {
      const rows = []
      for (const path of paths) {
        try { rows.push({ path, mtime: (await fs.stat(path)).mtimeMs }) } catch { }
      }
      return rows.sort((a, b) => b.mtime - a.mtime).map((r) => r.path)
    }

    async function newestBackup(backupDir) {
      const names = (await zipZipNames(backupDir)).filter((name) => name.startsWith(BackupPrefix))
      const sorted = await mtimeDesc(names.map((name) => p.join(backupDir, name)))
      if (!sorted.length) return null
      try {
        const manifest = await readManifestFromZip(sorted[0])
        return { name: p.basename(sorted[0]), path: sorted[0], fingerprint: String(manifest.fingerprint || '') }
      } catch { return null }
    }

    async function rotateBackups(backupDir, keep) {
      const all = await mtimeDesc((await zipZipNames(backupDir)).map((name) => p.join(backupDir, name)))
      const removed = []
      for (const path of all.slice(Math.max(0, keep))) {
        try { await fs.unlink(path); removed.push(p.basename(path)) } catch { /* 被占用时跳过 */ }
      }
      return removed
    }

    /* ---------- 对外操作 ---------- */
    async function backup(opts = {}) {
      const dir = await resolveDir(opts.dir, false)
      const backupDir = backupsDirOf(dir)
      await fs.mkdirp(backupDir)
      const { items, warnings } = await snapshot(dir)
      if (!items.length) throw new Error(`目录中没有可识别的配置文件(${IncludeSuffix.join('/')}): ${dir}`)
      const fingerprint = await fingerprintOf(items)
      const keep = Math.max(1, Number(opts.keep) > 0 ? Number(opts.keep) : 20)
      const newest = await newestBackup(backupDir)
      if (newest && newest.fingerprint === fingerprint && !opts.force) {
        await rotateBackups(backupDir, keep)
        return { ok: true, skipped: true, message: `配置无变化, 跳过备份(与 ${newest.name} 相同)`, path: newest.path, files: items.length, fingerprint: fingerprint.slice(0, 16), removed: 0, warnings }
      }
      const dest = await uniqueDest(backupDir, BackupPrefix + stamp())
      await writeBackupZip(dest, items, newManifest('backup', items, fingerprint))
      const removed = await rotateBackups(backupDir, keep)
      return { ok: true, skipped: false, path: dest, files: items.length, fingerprint: fingerprint.slice(0, 16), removed, warnings }
    }

    async function listBackups(opts = {}) {
      const dir = await resolveDir(opts.dir, false)
      const backupDir = backupsDirOf(dir)
      const rows = []
      for (const name of await zipZipNames(backupDir)) {
        const full = p.join(backupDir, name)
        let size = 0, mtimeMs = 0
        try { const st = await fs.stat(full); size = st.size; mtimeMs = st.mtimeMs } catch { continue }
        let fileCount = ''
        let kind = '备份包'
        let fingerprint = ''
        try {
          const manifest = await readManifestFromZip(full)
          fileCount = Array.isArray(manifest.files) ? manifest.files.length : ''
          const rawKind = String(manifest.kind || '')
          kind = rawKind === 'backup' ? '手动备份' : rawKind.startsWith('safety:') ? '安全包(自动)' : (rawKind || '未知')
          fingerprint = String(manifest.fingerprint || '').slice(0, 16)
        } catch { kind = '无法读取(损坏?)' }
        rows.push({ name, time: fmtTime(new Date(mtimeMs)), fileCount, sizeText: formatSize(size), kind, fingerprint, path: full, mtimeMs })
      }
      rows.sort((a, b) => b.mtimeMs - a.mtimeMs)
      rows.forEach((r) => { delete r.mtimeMs })
      return { dir, backupDir, rows }
    }

    async function writeVerifiedEntries(dir, entries) {
      const written = []
      const identical = []
      for (const entry of entries) {
        const target = p.join(dir, ...entry.name.split('/'))
        let same = false
        if (await fs.exists(target)) {
          try {
            const cur = await fs.readBinary(target)
            if (await sha256(cur) === entry.hex) same = true
          } catch { same = false }
        }
        if (same) { identical.push(entry.name); continue }
        const tmp = target + '.tmp'
        await fs.mkdirp(p.dirname(target))
        await fs.writeBinary(tmp, entry.data)
        await fs.rename(tmp, target)
        const recheck = await fs.readBinary(target)
        if (await sha256(recheck) !== entry.hex) throw new Error(`写入后复检失败: ${entry.name}`)
        written.push(entry.name)
      }
      return { written, identical }
    }

    function testConfigName(name) {
      const s = String(name || '')
      if (!s.trim()) return false
      if (s.includes('\0')) return false
      if (s.startsWith('/') || s.startsWith('\\')) return false
      const parts = s.split(/[\\/]/)
      if (parts.length > 4) return false
      for (const part of parts) { if (!part || part === '.' || part === '..') return false }
      const dot = s.lastIndexOf('.')
      return dot > 0 && IncludeSuffix.includes(s.slice(dot).toLowerCase())
    }

    async function makeSafetyBackup(dir, tag) {
      const { items } = await snapshot(dir)
      if (!items.length) return null
      const backupDir = backupsDirOf(dir)
      await fs.mkdirp(backupDir)
      const dest = await uniqueDest(backupDir, `${tag}-${stamp()}`)
      await writeBackupZip(dest, items, newManifest(`safety:${tag}`, items, await fingerprintOf(items)))
      return dest
    }

    async function restoreZip(opts = {}) {
      const zipPath = String(opts.zipPath || '')
      if (!(await fs.exists(zipPath))) throw new Error(`文件不存在: ${zipPath}`)
      const dir = await resolveDir(opts.dir, true)
      const manifest = await readManifestFromZip(zipPath)
      const kind = String(manifest.kind || '')
      if (kind !== 'backup' && !kind.startsWith('safety:')) {
        throw new Error(`不支持的备份包(kind=${kind || '空'}), 可能不是本工具生成`)
      }
      const metas = Array.isArray(manifest.files) ? manifest.files : []
      if (!metas.length) throw new Error('备份包内没有可恢复的配置文件')
      if (metas.length > MaxFiles) throw new Error(`文件数量超过上限 ${MaxFiles}`)
      const files = zip.unzipSync(await fs.readBinary(zipPath))
      const entries = []
      for (const meta of metas) {
        if (!testConfigName(meta.name)) throw new Error(`非法文件名(路径穿越或后缀不在白名单): ${meta.name}`)
        const data = files['files/' + meta.name]
        if (!data) throw new Error(`备份包缺少文件: ${meta.name}`)
        const hex = await sha256(data)
        if (hex !== String(meta.sha256 || '').toLowerCase()) {
          throw new Error(`文件 ${meta.name} 校验失败: hash 与内容不一致`)
        }
        entries.push({ name: meta.name, data, hex })
      }
      const safety = await makeSafetyBackup(dir, 'pre-restore')
      const result = await writeVerifiedEntries(dir, await Promise.all(entries))
      return { ok: true, from: p.basename(zipPath), safety, ...result }
    }

    /* ---------- 预览解析 ---------- */
    function parsePairsText(text) {
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

    function newPreview(items) {
      let binds = 0
      const sensitivity = {}
      const video = {}
      const filePairs = []
      for (const it of items) {
        const text = fromUtf8(it.data)
        const pairs = new Map(parsePairsText(text))
        const rows = []
        for (const [key, value] of pairs) {
          const low = key.toLowerCase()
          if (low.includes('bind') && low !== 'bind') binds += 1
          if (low.includes('sens')) sensitivity[low] = value
          if (low.includes('defaultres') || low === 'setting.fullscreen' || low === 'aspectratiowithletterbox') video[low] = value
          if (rows.length < 800) rows.push([key.slice(0, 80), String(value).slice(0, 120)])
        }
        binds += (text.match(/^[ \t]*bind\b/gm) || []).length
        filePairs.push({ name: it.name, rows })
      }
      return { sensitivity, video, binds_count: binds, files: items.map((it) => it.name), file_pairs: filePairs }
    }

    function readShareObject(rawText) {
      let share
      try { share = JSON.parse(rawText) } catch (err) { throw new Error(`分享文件不是有效 JSON: ${err.message}`) }
      if (!share || share.kind !== 'apexcfg' || share.format !== FormatVersion) {
        throw new Error('不支持的分享格式(kind/format 不符), 请让对方更新工具后重新导出')
      }
      return share
    }

    async function shareInfo(sharePath) {
      if (!(await fs.exists(sharePath))) throw new Error(`文件不存在: ${sharePath}`)
      const share = readShareObject(await fs.readText(sharePath))
      return {
        label: share.label || '', note: share.note || '', game: share.game || '',
        tool_version: share.tool_version || '', created_at: share.created_at || '',
        files: Object.keys(share.files || {}), preview: share.preview || {},
      }
    }

    async function buildSharePayload(opts = {}) {
      const dir = await resolveDir(opts.dir, false)
      const { items, warnings } = await snapshot(dir)
      if (!items.length) throw new Error(`目录中没有可识别的配置文件(${IncludeSuffix.join('/')}): ${dir}`)
      if (!opts.outPath) throw new Error('请先选择导出位置')
      const label = String(opts.label || '').trim() || `Apex 配置 ${stamp()}`
      const files = {}
      for (const it of items) files[it.name] = { b64: toB64(it.data), sha256: it.hex }
      const payload = {
        kind: 'apexcfg', format: FormatVersion, tool_version: ToolVersion,
        game: 'Apex Legends', created_at: new Date().toISOString().replace(/\.\d+Z$/, '+00:00'),
        label, note: String(opts.note || ''), preview: newPreview(items), files,
      }
      return { payload, target: opts.outPath, warnings }
    }

    async function exportConfig(opts = {}) {
      const { payload, target, warnings } = await buildSharePayload(opts)
      await fs.writeText(target, JSON.stringify(payload, null, 2) + '\n')
      return { ok: true, path: target, label: payload.label, files: Object.keys(payload.files).length, preview: payload.preview, warnings }
    }

    async function applyShareObject(share, dirExplicit) {
      const names = Object.keys(share.files || {})
      if (!names.length) throw new Error('分享文件中没有包含任何配置文件')
      if (names.length > MaxFiles) throw new Error(`文件数量超过上限 ${MaxFiles}`)
      const entries = []
      for (const name of names) {
        if (!testConfigName(name)) throw new Error(`非法文件名(路径穿越或后缀不在白名单): ${name}`)
        const meta = share.files[name]
        if (!meta || typeof meta.b64 !== 'string') throw new Error(`分享文件缺少内容: ${name}`)
        const data = fromB64(meta.b64)
        if (data.length > MaxFileBytes) throw new Error(`分享文件过大(>8.0MB): ${name}`)
        const hex = await sha256(data)
        if (hex !== String(meta.sha256 || '').toLowerCase()) {
          throw new Error(`文件 ${name} 校验失败: hash 与内容不一致`)
        }
        entries.push({ name, data, hex })
      }
      const dir = await resolveDir(dirExplicit, true)
      const safety = await makeSafetyBackup(dir, 'pre-import')
      const result = await writeVerifiedEntries(dir, entries)
      return { ok: true, label: share.label || '', safety, ...result }
    }

    async function importShare(opts = {}) {
      if (!(await fs.exists(opts.sharePath))) throw new Error(`文件不存在: ${opts.sharePath}`)
      const share = readShareObject(await fs.readText(opts.sharePath))
      return applyShareObject(share, opts.dir)
    }

    async function importPayload(opts = {}) {
      const raw = String(opts.raw || '')
      if (!raw.trim()) throw new Error('分享内容为空')
      return applyShareObject(readShareObject(raw), opts.dir)
    }

    async function readDetail(opts = {}) {
      const dir = await resolveDir(opts.dir, false)
      const { items, warnings } = await snapshot(dir)
      if (!items.length) {
        return { dir, files: [], warnings, error: `目录内没有 ${IncludeSuffix.join('/')} 配置文件` }
      }
      const files = items.map((it) => ({ name: it.name, size: it.size, rows: parsePairsText(fromUtf8(it.data)) }))
      return { dir, files, warnings }
    }

    return {
      ToolVersion, FormatVersion, MaxFiles, MaxFileBytes, MaxTotalBytes, BackupPrefix, IncludeSuffix,
      candidateDirs, resolveDir, backupsDirOf, snapshot, fingerprintOf, newManifest, parsePairsText, newPreview, testConfigName,
      backup, listBackups, restoreZip, exportConfig, buildSharePayload, importShare, importPayload, shareInfo, readDetail,
    }
  }

  global.ApexEngine = { create, utf8, fromUtf8, toB64, fromB64, stamp, fmtTime, formatSize }
})(typeof window !== 'undefined' ? window : globalThis)
