'use strict'
// Apex 配置核心逻辑 (Node 版)
// 与 PowerShell 控制台版 apex_cfg_tool.ps1 行为对齐: 同一份 manifest/.apexcfg 格式(kind/format)、
// 同样的校验规则(sha256/路径穿越/后缀白名单/数量体积上限)与安全包机制。
// 本文件不依赖 Electron, 可用 node test/backend.test.js 独立测试。
const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')
const AdmZip = require('adm-zip')

const ToolVersion = '2.2.0'
const FormatVersion = 1
const MaxFileBytes = 8 * 1024 * 1024   // 单文件上限
const MaxTotalBytes = 32 * 1024 * 1024 // 单次快照总体积上限
const MaxFiles = 64                    // 单个备份包/分享文件条目上限
const BackupPrefix = 'apex-backup-'
const IncludeSuffix = ['.cfg', '.txt', '.ini']

const toHex = (buf) => crypto.createHash('sha256').update(buf).digest('hex')
const utcIso = () => new Date().toISOString().replace(/\.\d+Z$/, '+00:00')

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

// ---------- 目录定位 ----------
function candidateDirs() {
  const home = os.homedir()
  return [
    path.join(home, 'Saved Games', 'Respawn', 'Apex', 'local'),
    path.join(home, 'Documents', 'Respawn', 'Apex', 'local'),
    path.join(home, 'OneDrive', 'Documents', 'Respawn', 'Apex', 'local'),
  ]
}

function resolveDir(explicit = '', createDir = false) {
  const raw = String(explicit || '').trim()
  if (raw) {
    let full = raw
    if (full === '~') full = os.homedir()
    else if (full.startsWith('~/') || full.startsWith('~\\')) full = path.join(os.homedir(), full.slice(2))
    full = path.resolve(full)
    if (createDir) fs.mkdirSync(full, { recursive: true })
    if (!fs.existsSync(full) || !fs.statSync(full).isDirectory()) throw new Error(`目录不存在: ${full}`)
    return full
  }
  const found = candidateDirs().filter((d) => fs.existsSync(d))
  if (found.length) return found[0]
  if (createDir) {
    const made = candidateDirs()[0]
    fs.mkdirSync(made, { recursive: true })
    return made
  }
  throw new Error(`未找到 Apex 配置目录,已尝试:\n  ${candidateDirs().join('\n  ')}\n请手动填入配置目录路径`)
}

function backupsDirOf(localDir) {
  return path.join(path.dirname(path.resolve(localDir)), 'apex-backups')
}

// ---------- 快照 ----------
function listConfigFiles(dir) {
  const found = []
  const walk = (cur) => {
    let entries = []
    try { entries = fs.readdirSync(cur, { withFileTypes: true }) } catch { return }
    for (const ent of entries) {
      const full = path.join(cur, ent.name)
      if (ent.isDirectory()) walk(full)
      else if (ent.isFile() && IncludeSuffix.includes(path.extname(ent.name).toLowerCase())) found.push(full)
    }
  }
  walk(dir)
  return found.sort()
}

function snapshot(dir) {
  const items = []
  const warnings = []
  let total = 0
  for (const filePath of listConfigFiles(dir)) {
    const data = fs.readFileSync(filePath)
    total += data.length
    if (total > MaxTotalBytes) throw new Error(`配置文件总体积超过上限 ${formatSize(MaxTotalBytes)}`)
    if (data.length > MaxFileBytes) {
      warnings.push(`警告: 跳过过大文件(${formatSize(data.length)}): ${path.basename(filePath)}`)
      total -= data.length
      continue
    }
    const rel = path.relative(path.resolve(dir), filePath).split(path.sep).join('/')
    items.push({ name: rel, data, size: data.length, sha256: toHex(data) })
  }
  return { items, warnings }
}

function fingerprintOf(items) {
  const lines = [...items].sort((a, b) => (a.name < b.name ? -1 : 1)).map((it) => `${it.name}:${it.sha256}`).join('\n')
  return crypto.createHash('sha256').update(lines, 'utf8').digest('hex')
}

function newManifest(kind, items, fingerprint) {
  return {
    kind,
    tool_version: ToolVersion,
    created_at: utcIso(),
    fingerprint,
    files: items.map((it) => ({ name: it.name, size: it.size, sha256: it.sha256 })),
  }
}

function writeBackupZip(zipPath, items, manifest) {
  const zip = new AdmZip()
  zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'))
  for (const it of items) zip.addFile('files/' + it.name, it.data)
  fs.mkdirSync(path.dirname(zipPath), { recursive: true })
  zip.writeZip(zipPath)
}

function uniqueDest(dir, base) {
  let dest = path.join(dir, base + '.zip')
  let serial = 2
  while (fs.existsSync(dest)) {
    dest = path.join(dir, `${base}-${serial}.zip`)
    serial += 1
  }
  return dest
}

function zipZips(backupDir) {
  try {
    return fs.readdirSync(backupDir).filter((f) => f.toLowerCase().endsWith('.zip'))
  } catch { return [] }
}

function readManifestFromZip(zipPath) {
  const zip = new AdmZip(zipPath)
  const entry = zip.getEntry('manifest.json')
  if (!entry) throw new Error('备份包缺少 manifest.json, 不是本工具生成的包')
  return JSON.parse(zip.readAsText(entry))
}

function newestBackup(backupDir) {
  const zips = zipZips(backupDir)
    .filter((name) => name.startsWith(BackupPrefix))
    .map((name) => path.join(backupDir, name))
    .filter((p) => { try { return fs.statSync(p).isFile() } catch { return false } })
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
  if (!zips.length) return null
  try {
    const manifest = readManifestFromZip(zips[0])
    return { name: path.basename(zips[0]), path: zips[0], fingerprint: String(manifest.fingerprint || '') }
  } catch { return null }
}

function rotateBackups(backupDir, keep) {
  const zips = zipZips(backupDir)
    .map((name) => path.join(backupDir, name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
  const removed = []
  for (const p of zips.slice(Math.max(0, keep))) {
    try { fs.unlinkSync(p); removed.push(path.basename(p)) } catch { /* 被占用时跳过 */ }
  }
  return removed
}

// ---------- 对外操作: 备份 / 列表 / 恢复 ----------
function backup(opts = {}) {
  const dir = resolveDir(opts.dir, false)
  const backupDir = backupsDirOf(dir)
  fs.mkdirSync(backupDir, { recursive: true })
  const { items, warnings } = snapshot(dir)
  if (!items.length) throw new Error(`目录中没有可识别的配置文件(${IncludeSuffix.join('/')}): ${dir}`)
  const fingerprint = fingerprintOf(items)
  const newest = newestBackup(backupDir)
  const keep = Math.max(1, Number(opts.keep) > 0 ? Number(opts.keep) : 20)
  if (newest && newest.fingerprint === fingerprint && !opts.force) {
    rotateBackups(backupDir, keep)
    return { ok: true, skipped: true, message: `配置无变化, 跳过备份(与 ${newest.name} 相同)`, path: newest.path, files: items.length, fingerprint: fingerprint.slice(0, 16), removed: 0, warnings }
  }
  const dest = uniqueDest(backupDir, BackupPrefix + stamp())
  writeBackupZip(dest, items, newManifest('backup', items, fingerprint))
  const removed = rotateBackups(backupDir, keep)
  return { ok: true, skipped: false, path: dest, files: items.length, fingerprint: fingerprint.slice(0, 16), removed, warnings }
}

function listBackups(opts = {}) {
  const dir = resolveDir(opts.dir, false)
  const backupDir = backupsDirOf(dir)
  const rows = []
  for (const name of zipZips(backupDir)) {
    const full = path.join(backupDir, name)
    let stat
    try { stat = fs.statSync(full) } catch { continue }
    let fileCount = ''
    let kind = '备份包'
    let fingerprint = ''
    try {
      const manifest = readManifestFromZip(full)
      fileCount = Array.isArray(manifest.files) ? manifest.files.length : ''
      const rawKind = String(manifest.kind || '')
      kind = rawKind === 'backup' ? '手动备份' : rawKind.startsWith('safety:') ? '安全包(自动)' : (rawKind || '未知')
      fingerprint = String(manifest.fingerprint || '').slice(0, 16)
    } catch { kind = '无法读取(损坏?)' }
    rows.push({ name, time: fmtTime(stat.mtime), fileCount, sizeText: formatSize(stat.size), kind, fingerprint, path: full, mtimeMs: stat.mtimeMs })
  }
  rows.sort((a, b) => b.mtimeMs - a.mtimeMs)
  rows.forEach((r) => { delete r.mtimeMs })
  return { dir, backupDir, rows }
}

function atomicWrite(target, data) {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const tmp = target + '.tmp'
  fs.writeFileSync(tmp, data)
  fs.renameSync(tmp, target)
}

function testConfigName(name) {
  const s = String(name || '')
  if (!s.trim()) return false
  if (s.includes('\0')) return false
  if (s.startsWith('/') || s.startsWith('\\')) return false
  const parts = s.split(/[\\/]/)
  if (parts.length > 4) return false
  for (const p of parts) { if (!p || p === '.' || p === '..') return false }
  return IncludeSuffix.includes(path.extname(s).toLowerCase())
}

// 共用的"校验→写入→复检"流程; 供恢复备份与应用分享文件复用
function writeVerifiedEntries(dir, entries) {
  const written = []
  const identical = []
  for (const entry of entries) {
    const target = path.join(dir, ...entry.name.split('/'))
    if (fs.existsSync(target)) {
      const current = fs.readFileSync(target)
      if (toHex(current) === toHex(entry.data)) { identical.push(entry.name); continue }
    }
    atomicWrite(target, entry.data)
    const recheck = fs.readFileSync(target)
    if (toHex(recheck) !== toHex(entry.data)) throw new Error(`写入后复检失败: ${entry.name}`)
    written.push(entry.name)
  }
  return { written, identical }
}

function makeSafetyBackup(dir, tag) {
  const { items } = snapshot(dir)
  if (!items.length) return null
  const backupDir = backupsDirOf(dir)
  fs.mkdirSync(backupDir, { recursive: true })
  const dest = uniqueDest(backupDir, `${tag}-${stamp()}`)
  writeBackupZip(dest, items, newManifest(`safety:${tag}`, items, fingerprintOf(items)))
  return dest
}

function restoreZip(opts = {}) {
  const zipPath = String(opts.zipPath || '')
  if (!fs.existsSync(zipPath)) throw new Error(`文件不存在: ${zipPath}`)
  const dir = resolveDir(opts.dir, true)
  const manifest = readManifestFromZip(zipPath)
  const kind = String(manifest.kind || '')
  if (kind !== 'backup' && !kind.startsWith('safety:')) {
    throw new Error(`不支持的备份包(kind=${kind || '空'}), 可能不是本工具生成`)
  }
  const metas = Array.isArray(manifest.files) ? manifest.files : []
  if (!metas.length) throw new Error('备份包内没有可恢复的配置文件')
  if (metas.length > MaxFiles) throw new Error(`文件数量超过上限 ${MaxFiles}`)
  const zip = new AdmZip(zipPath)
  const entries = metas.map((meta) => {
    if (!testConfigName(meta.name)) throw new Error(`非法文件名(路径穿越或后缀不在白名单): ${meta.name}`)
    const entry = zip.getEntry('files/' + meta.name)
    if (!entry) throw new Error(`备份包缺少文件: ${meta.name}`)
    const data = entry.getData()
    if (toHex(data) !== String(meta.sha256 || '').toLowerCase()) {
      throw new Error(`文件 ${meta.name} 校验失败: hash 与内容不一致`)
    }
    return { name: meta.name, data }
  })
  const safety = makeSafetyBackup(dir, 'pre-restore')
  const result = writeVerifiedEntries(dir, entries)
  return { ok: true, from: path.basename(zipPath), safety, ...result }
}

// ---------- 预览解析 (与网页/控制台一致的三段正则规则) ----------
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
  const sensitivity = {}
  const video = {}
  let binds = 0
  const filePairs = []
  for (const it of items) {
    const text = Buffer.from(it.data).toString('utf8')
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
  return {
    sensitivity,
    video,
    binds_count: binds,
    files: items.map((it) => it.name),
    file_pairs: filePairs,
  }
}

// ---------- 分享文件 ----------
function readShareFile(sharePath) {
  if (!fs.existsSync(sharePath)) throw new Error(`文件不存在: ${sharePath}`)
  let share
  try { share = JSON.parse(fs.readFileSync(sharePath, 'utf8')) } catch (err) {
    throw new Error(`分享文件不是有效 JSON: ${err.message}`)
  }
  if (!share || share.kind !== 'apexcfg' || share.format !== FormatVersion) {
    throw new Error('不支持的分享格式(kind/format 不符), 请让对方更新工具后重新导出')
  }
  return share
}

function shareInfo(sharePath) {
  const share = readShareFile(sharePath)
  return {
    label: share.label || '',
    note: share.note || '',
    game: share.game || '',
    tool_version: share.tool_version || '',
    created_at: share.created_at || '',
    files: Object.keys(share.files || {}),
    preview: share.preview || {},
  }
}

function exportConfig(opts = {}) {
  const { payload, target, warnings } = buildSharePayload(opts)
  fs.writeFileSync(target, JSON.stringify(payload, null, 2) + '\n', 'utf8')
  return { ok: true, path: path.resolve(target), label: payload.label, files: Object.keys(payload.files).length, preview: payload.preview, warnings }
}

// 构建分享对象但不落盘(供直接发布到分享广场)
function buildSharePayload(opts = {}) {
  const dir = resolveDir(opts.dir, false)
  const { items, warnings } = snapshot(dir)
  if (!items.length) throw new Error(`目录中没有可识别的配置文件(${IncludeSuffix.join('/')}): ${dir}`)
  let target = String(opts.outPath || '').trim()
  if (!target) target = `apex-export-${stamp()}.apexcfg`
  const label = String(opts.label || '').trim() || `Apex 配置 ${stamp()}`
  const files = {}
  for (const it of items) files[it.name] = { b64: Buffer.from(it.data).toString('base64'), sha256: it.sha256 }
  const payload = {
    kind: 'apexcfg',
    format: FormatVersion,
    tool_version: ToolVersion,
    game: 'Apex Legends',
    created_at: utcIso(),
    label,
    note: String(opts.note || ''),
    preview: newPreview(items),
    files,
  }
  return { payload, target, warnings }
}

// 应用分享文件(从文件路径)
function importShare(opts = {}) {
  const share = readShareFile(opts.sharePath)
  return applyShareObject(share, opts.dir)
}

// 应用分享内容(从 .apexcfg JSON 字符串, 供 GUI 广场"一键导入")
function importPayload(opts = {}) {
  const raw = String(opts.raw || '')
  if (!raw.trim()) throw new Error('分享内容为空')
  let share
  try { share = JSON.parse(raw) } catch (err) { throw new Error(`分享内容不是有效 JSON: ${err.message}`) }
  if (!share || share.kind !== 'apexcfg' || share.format !== FormatVersion) {
    throw new Error('不支持的分享格式(kind/format 不符), 请让对方更新工具后重新导出')
  }
  return applyShareObject(share, opts.dir)
}

function applyShareObject(share, dirExplicit) {
  const names = Object.keys(share.files || {})
  if (!names.length) throw new Error('分享文件中没有包含任何配置文件')
  if (names.length > MaxFiles) throw new Error(`文件数量超过上限 ${MaxFiles}`)
  const entries = names.map((name) => {
    if (!testConfigName(name)) throw new Error(`非法文件名(路径穿越或后缀不在白名单): ${name}`)
    const meta = share.files[name]
    if (!meta || typeof meta.b64 !== 'string') throw new Error(`分享文件缺少内容: ${name}`)
    const data = Buffer.from(meta.b64, 'base64')
    if (data.length > MaxFileBytes) throw new Error(`分享文件过大(>8.0MB): ${name}`)
    if (toHex(data) !== String(meta.sha256 || '').toLowerCase()) {
      throw new Error(`文件 ${name} 校验失败: hash 与内容不一致`)
    }
    return { name, data }
  })
  const dir = resolveDir(dirExplicit, true)
  const safety = makeSafetyBackup(dir, 'pre-import')
  const result = writeVerifiedEntries(dir, entries)
  return { ok: true, label: share.label || '', safety, ...result }
}

// ---------- GUI 数据源: 全部键值 ----------
function readDetail(opts = {}) {
  const dir = resolveDir(opts.dir, false)
  const { items, warnings } = snapshot(dir)
  if (!items.length) {
    return { dir, files: [], warnings, error: `目录内没有 ${IncludeSuffix.join('/')} 配置文件` }
  }
  const files = items.map((it) => {
    const text = Buffer.from(it.data).toString('utf8')
    return { name: it.name, size: it.size, rows: parsePairsText(text) }
  })
  return { dir, files, warnings }
}

function openPath(target) {
  // 主进程里用 shell.openPath; 此处返回校验后的路径
  const full = path.resolve(String(target || ''))
  if (!fs.existsSync(full)) throw new Error(`路径不存在: ${full}`)
  return full
}

module.exports = {
  ToolVersion, FormatVersion, MaxFiles, MaxFileBytes, MaxTotalBytes, BackupPrefix, IncludeSuffix,
  candidateDirs, resolveDir, backupsDirOf, snapshot, fingerprintOf, newManifest,
  parsePairsText, newPreview, testConfigName,
  backup, listBackups, restoreZip, exportConfig, importShare, importPayload, buildSharePayload, shareInfo, readDetail, openPath,
}
