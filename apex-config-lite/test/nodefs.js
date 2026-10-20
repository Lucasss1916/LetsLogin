'use strict'
/* Node 环境的引擎适配器(与 resources/src/nefs.js 提供给浏览器的接口一致) */
const fs = require('fs')
const fsp = fs.promises
const path = require('path')
const crypto = require('crypto')
const os = require('os')
const fflate = require('fflate')

const SEP = path.sep
const p = {
  sep: SEP,
  join: (...parts) => path.join(...parts),
  dirname: (x) => path.dirname(x),
  basename: (x) => path.basename(x),
  extname: (x) => path.extname(x),
  normalize: (x) => path.normalize(x),
  relSlash: (base, full) => path.relative(base, full).split(path.sep).join('/'),
}

const fsx = {
  async exists(x) { try { await fsp.access(x); return true } catch { return false } },
  async isDir(x) { return (await fsp.stat(x)).isDirectory() },
  async stat(x) { const stat = await fsp.stat(x); return { size: stat.size, mtimeMs: stat.mtimeMs, isFile: stat.isFile() } },
  mkdirp: (x) => fsp.mkdir(x, { recursive: true }),
  async readBinary(x) { return new Uint8Array(await fsp.readFile(x)) },
  readText: (x) => fsp.readFile(x, 'utf8'),
  writeBinary: (x, data) => fsp.writeFile(x, Buffer.from(data)),
  writeText: (x, t) => fsp.writeFile(x, t, 'utf8'),
  rename: (a, b) => fsp.rename(a, b),
  unlink: (x) => fsp.unlink(x),
  async listDir(dir) {
    return (await fsp.readdir(dir, { withFileTypes: true })).map((e) => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file' }))
  },
}

async function sha256(bytes) {
  return crypto.createHash('sha256').update(Buffer.from(bytes)).digest('hex')
}

const zip = {
  zipSync: (entries) => fflate.zipSync(entries, { level: 0 }),
  unzipSync: (bytes) => fflate.unzipSync(bytes),
}

function makeCtx() {
  return { fs: fsx, p, sha256, zip, env: { home: () => os.homedir() } }
}

module.exports = { makeCtx }
