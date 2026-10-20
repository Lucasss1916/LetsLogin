'use strict'
/* 轻量版引擎自测(直接跑 resources/src/engine.js, 通过 Node 适配器驱动) */
const fs = require('fs')
const os = require('os')
const path = require('path')
const assert = require('assert')
const { makeCtx } = require('./nodefs')
require('../resources/src/engine.js')

const engine = global.ApexEngine.create(makeCtx())

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-lite-test-'))
const cfgDir = path.join(root, 'Saved Games', 'Respawn', 'Apex', 'local')
fs.mkdirSync(cfgDir, { recursive: true })
fs.writeFileSync(path.join(cfgDir, 'settings.cfg'), '"mouse_sensitivity" "1.8"\n"binding_jump" "space"\n')
fs.writeFileSync(path.join(cfgDir, 'videoconfig.txt'), '"setting.defaultres" "2560"\n"setting.fps_max" "240"\n')

const step = async (name, fn) => { await fn(); console.log(`PASS  ${name}`) }
const expectThrow = async (promise, pattern) => {
  try { await promise } catch (err) {
    assert.ok(pattern.test(err.message), `异常信息应匹配 ${pattern}, 实际: ${err && err.message}`)
    return
  }
  throw new Error('应当拦截')
}

;(async () => {
  await step('明细读取(全部键值)', async () => {
    const detail = await engine.readDetail({ dir: cfgDir })
    assert.strictEqual(detail.files.length, 2)
    const rows = Object.fromEntries(detail.files.map((f) => [f.name, Object.fromEntries(f.rows)]))
    assert.strictEqual(rows['settings.cfg'].mouse_sensitivity, '1.8')
    assert.strictEqual(rows['videoconfig.txt']['setting.fps_max'], '240')
  })

  await step('备份 + 指纹去重', async () => {
    const first = await engine.backup({ dir: cfgDir, keep: 20 })
    assert.strictEqual(first.skipped, false)
    const again = await engine.backup({ dir: cfgDir, keep: 20 })
    assert.strictEqual(again.skipped, true)
    const list = await engine.listBackups({ dir: cfgDir })
    assert.strictEqual(list.rows.length, 1)
  })

  await step('修改后再备份 + 轮转 keep=2', async () => {
    fs.writeFileSync(path.join(cfgDir, 'settings.cfg'), '"mouse_sensitivity" "2.4"\n"binding_jump" "space"\n')
    await engine.backup({ dir: cfgDir, keep: 2 })
    fs.writeFileSync(path.join(cfgDir, 'settings.cfg'), '"mouse_sensitivity" "3.0"\n"binding_jump" "space"\n')
    await engine.backup({ dir: cfgDir, keep: 2 })
    const list = await engine.listBackups({ dir: cfgDir })
    assert.strictEqual(list.rows.length, 2, `期望轮转只留2份, 实际 ${list.rows.length}`)
  })

  await step('恢复备份(含一致跳过) + 自动安全包', async () => {
    const list = await engine.listBackups({ dir: cfgDir })
    const oldest = list.rows[list.rows.length - 1]
    assert.ok(fs.readFileSync(path.join(cfgDir, 'settings.cfg'), 'utf8').includes('"3.0"'))
    const result = await engine.restoreZip({ zipPath: oldest.path, dir: cfgDir })
    assert.strictEqual(result.written.length, 1)
    assert.strictEqual(result.identical.length, 1)
    assert.ok(result.safety, '应生成 pre-restore 安全包')
    assert.ok(fs.readFileSync(path.join(cfgDir, 'settings.cfg'), 'utf8').includes('"2.4"'))
    const after = await engine.listBackups({ dir: cfgDir })
    assert.ok(after.rows.some((row) => row.name.startsWith('pre-restore-')))
  })

  await step('导出 .apexcfg (格式互通)', async () => {
    const out = path.join(root, 'share.apexcfg')
    const result = await engine.exportConfig({ dir: cfgDir, outPath: out, label: '测试 2.4', note: '自动化' })
    assert.ok(fs.existsSync(result.path))
    const parsed = JSON.parse(fs.readFileSync(out, 'utf8'))
    assert.strictEqual(parsed.kind, 'apexcfg')
    assert.strictEqual(parsed.format, 1)
    assert.ok(parsed.files['settings.cfg'].b64.length > 0)
    assert.ok(parsed.preview.binds_count >= 1)
  })

  await step('导入到全新目录 + 内容一致', async () => {
    const freshDir = path.join(root, 'out', 'Respawn', 'Apex', 'local')
    const result = await engine.importShare({ sharePath: path.join(root, 'share.apexcfg'), dir: freshDir })
    assert.strictEqual(result.written.length, 2)
    assert.strictEqual(result.safety, null)
    assert.ok(fs.readFileSync(path.join(cfgDir, 'settings.cfg')).equals(fs.readFileSync(path.join(freshDir, 'settings.cfg'))))
  })

  await step('篡改 b64 → 校验拦截', async () => {
    const raw = JSON.parse(fs.readFileSync(path.join(root, 'share.apexcfg'), 'utf8'))
    raw.files['settings.cfg'].b64 = Buffer.from('broken').toString('base64')
    const tampered = path.join(root, 'tampered.apexcfg')
    fs.writeFileSync(tampered, JSON.stringify(raw))
    await expectThrow(engine.importShare({ sharePath: tampered, dir: cfgDir }), /校验失败/)
  })

  await step('路径穿越 → 拦截', async () => {
    const data = Buffer.from('evil')
    const evilPath = path.join(root, 'evil.apexcfg')
    fs.writeFileSync(evilPath, JSON.stringify({
      kind: 'apexcfg', format: 1,
      files: { '../evil.cfg': { b64: data.toString('base64'), sha256: require('crypto').createHash('sha256').update(data).digest('hex') } },
    }))
    await expectThrow(engine.importShare({ sharePath: evilPath, dir: cfgDir }), /非法文件名/)
  })

  await step('buildSharePayload 直发布对象 → importPayload 导入', async () => {
    const { payload } = await engine.buildSharePayload({ dir: cfgDir, label: '广场直发', note: 'test', outPath: 'unused://x' })
    assert.strictEqual(payload.kind, 'apexcfg')
    assert.strictEqual(payload.format, 1)
    const freshDir = path.join(root, 'out2', 'Respawn', 'Apex', 'local')
    const result = await engine.importPayload({ raw: JSON.stringify(payload), dir: freshDir })
    assert.strictEqual(result.written.length, 2)
    assert.strictEqual(result.label, '广场直发')
    assert.ok(fs.readFileSync(path.join(freshDir, 'settings.cfg'), 'utf8').includes('"2.4"'))
  })

  await step('importPayload 篡改拦截', async () => {
    const { payload } = await engine.buildSharePayload({ dir: cfgDir, label: 'x', outPath: 'unused://x' })
    payload.files['settings.cfg'].b64 = Buffer.from('tampered!').toString('base64')
    await expectThrow(engine.importPayload({ raw: JSON.stringify(payload), dir: cfgDir }), /校验失败/)
  })

  await step('多余条目上限(64)拦截', async () => {
    const crypto = require('crypto')
    const files = {}
    for (let i = 0; i < 65; i += 1) {
      const data = Buffer.from(`x${i}`)
      files[`f${i}.cfg`] = { b64: data.toString('base64'), sha256: crypto.createHash('sha256').update(data).digest('hex') }
    }
    await expectThrow(engine.importPayload({ raw: JSON.stringify({ kind: 'apexcfg', format: 1, files }), dir: cfgDir }), /上限/)
  })

  fs.rmSync(root, { recursive: true, force: true })
  console.log('\n全部自测通过 ✓')
})().catch((err) => { console.error('FAILED:', err); process.exit(1) })
