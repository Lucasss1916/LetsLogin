'use strict'
/* backend.js 全链路自测(不依赖 Electron, 直接 node 运行): 备份/去重/恢复/导出/导入/篡改拦截/路径穿越拦截/轮转 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const assert = require('assert')
const backend = require('../backend')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-gui-test-'))
const cfgDir = path.join(root, 'Saved Games', 'Respawn', 'Apex', 'local')
fs.mkdirSync(cfgDir, { recursive: true })
fs.writeFileSync(path.join(cfgDir, 'settings.cfg'), '"mouse_sensitivity" "1.8"\n"binding_jump" "space"\n')
fs.writeFileSync(path.join(cfgDir, 'videoconfig.txt'), '"setting.defaultres" "2560"\n"setting.fps_max" "240"\n')

const step = (name, fn) => Promise.resolve().then(fn).then(() => console.log(`PASS  ${name}`))

;(async () => {
  await step('明细读取(全部键值)', async () => {
    const detail = backend.readDetail({ dir: cfgDir })
    assert.strictEqual(detail.files.length, 2)
    const rows = Object.fromEntries(detail.files.map((f) => [f.name, Object.fromEntries(f.rows)]))
    assert.strictEqual(rows['settings.cfg'].mouse_sensitivity, '1.8')
    assert.strictEqual(rows['videoconfig.txt'].setting_fps_max, undefined)
    assert.strictEqual(rows['videoconfig.txt']['setting.fps_max'], '240')
  })

  await step('备份 + 指纹去重', async () => {
    const first = backend.backup({ dir: cfgDir, keep: 20 })
    assert.strictEqual(first.skipped, false)
    const again = backend.backup({ dir: cfgDir, keep: 20 })
    assert.strictEqual(again.skipped, true)
    const list = backend.listBackups({ dir: cfgDir })
    assert.strictEqual(list.rows.length, 1)
  })

  await step('修改后再备份 + 轮转 keep=2', async () => {
    fs.writeFileSync(path.join(cfgDir, 'settings.cfg'), '"mouse_sensitivity" "2.4"\n"binding_jump" "space"\n')
    backend.backup({ dir: cfgDir, keep: 2 })
    fs.writeFileSync(path.join(cfgDir, 'settings.cfg'), '"mouse_sensitivity" "3.0"\n"binding_jump" "space"\n')
    backend.backup({ dir: cfgDir, keep: 2 })
    const list = backend.listBackups({ dir: cfgDir })
    assert.strictEqual(list.rows.length, 2, `期望轮转只留2份, 实际 ${list.rows.length}`)
  })

  await step('恢复备份(含一致跳过) + 自动安全包', async () => {
    const list = backend.listBackups({ dir: cfgDir })
    assert.ok(list.rows.length >= 2)
    const oldest = list.rows[list.rows.length - 1] // 轮转后保留的最旧备份(sens 2.4)
    const current = fs.readFileSync(path.join(cfgDir, 'settings.cfg'), 'utf8')
    assert.ok(current.includes('"3.0"'), `当前应为 3.0, 实际: ${current}`)
    const result = backend.restoreZip({ zipPath: oldest.path, dir: cfgDir })
    assert.strictEqual(result.written.length, 1, 'settings.cfg 改过, 应写入 1 个')
    assert.strictEqual(result.identical.length, 1, 'videoconfig.txt 未变, 应跳过 1 个')
    assert.ok(result.safety, '应生成 pre-restore 安全包')
    const content = fs.readFileSync(path.join(cfgDir, 'settings.cfg'), 'utf8')
    assert.ok(content.includes('"2.4"'), `恢复后应为 2.4, 实际: ${content}`)
    const after = backend.listBackups({ dir: cfgDir })
    assert.ok(after.rows.some((row) => row.name.startsWith('pre-restore-')), '备份夹应出现安全包')
  })

  await step('导出 .apexcfg (格式互通)', async () => {
    const out = path.join(root, 'share.apexcfg')
    const result = backend.exportConfig({ dir: cfgDir, outPath: out, label: '测试 1.8', note: '自动化' })
    assert.ok(fs.existsSync(result.path))
    const parsed = JSON.parse(fs.readFileSync(out, 'utf8'))
    assert.strictEqual(parsed.kind, 'apexcfg')
    assert.strictEqual(parsed.format, 1)
    assert.strictEqual(parsed.label, '测试 1.8')
    assert.ok(parsed.files['settings.cfg'].b64.length > 0)
    assert.ok(parsed.preview.file_pairs.length >= 2)
    assert.ok(parsed.preview.binds_count >= 1)
  })

  await step('导入到全新目录(空目录自动创建)', async () => {
    const freshDir = path.join(root, 'out', 'Respawn', 'Apex', 'local')
    const result = backend.importShare({ sharePath: path.join(root, 'share.apexcfg'), dir: freshDir })
    assert.strictEqual(result.written.length, 2)
    assert.strictEqual(result.safety, null, '空目录导入无需安全包')
    const a = fs.readFileSync(path.join(cfgDir, 'settings.cfg'))
    const b = fs.readFileSync(path.join(freshDir, 'settings.cfg'))
    assert.ok(a.equals(b))
  })

  await step('篡改 b64 → 校验拦截', async () => {
    const sharePath = path.join(root, 'tampered.apexcfg')
    const parsed = JSON.parse(fs.readFileSync(path.join(root, 'share.apexcfg'), 'utf8'))
    parsed.files['settings.cfg'].b64 = Buffer.from('broken content').toString('base64')
    fs.writeFileSync(sharePath, JSON.stringify(parsed))
    assert.throws(() => backend.importShare({ sharePath, dir: cfgDir }), /校验失败/, '应拒绝篡改内容')
  })

  await step('路径穿越文件名 → 拦截', async () => {
    const evilPath = path.join(root, 'evil.apexcfg')
    const data = Buffer.from('evil')
    fs.writeFileSync(evilPath, JSON.stringify({
      kind: 'apexcfg', format: 1,
      files: { '../evil.cfg': { b64: data.toString('base64'), sha256: require('crypto').createHash('sha256').update(data).digest('hex') } },
    }))
    assert.throws(() => backend.importShare({ sharePath: evilPath, dir: cfgDir }), /非法文件名/, '应拒绝路径穿越')
  })

  await step('多余条目上限(64)拦截', async () => {
    const files = {}
    const crypto = require('crypto')
    for (let i = 0; i < 65; i += 1) {
      const data = Buffer.from(`x${i}`)
      files[`f${i}.cfg`] = { b64: data.toString('base64'), sha256: crypto.createHash('sha256').update(data).digest('hex') }
    }
    const tooMany = path.join(root, 'toomany.apexcfg')
    fs.writeFileSync(tooMany, JSON.stringify({ kind: 'apexcfg', format: 1, files }))
    assert.throws(() => backend.importShare({ sharePath: tooMany, dir: cfgDir }), /上限/, '应拒绝超过 64 个文件')
  })

  await step('分享对象直发布(buildSharePayload) → importPayload 直导入', async () => {
    const { payload } = backend.buildSharePayload({ dir: cfgDir, label: '广场直发', note: 'test' })
    assert.strictEqual(payload.kind, 'apexcfg')
    assert.strictEqual(payload.format, 1)
    const freshDir = path.join(root, 'out2', 'Respawn', 'Apex', 'local')
    const result = backend.importPayload({ raw: JSON.stringify(payload), dir: freshDir })
    assert.strictEqual(result.written.length, 2)
    assert.ok(result.safety === null, '空目录无需安全包')
    assert.strictEqual(result.label, '广场直发')
    const raw = fs.readFileSync(path.join(freshDir, 'settings.cfg'), 'utf8')
    assert.ok(raw.includes('"2.4"'))
  })

  await step('importPayload 篡改拦截', async () => {
    const { payload } = backend.buildSharePayload({ dir: cfgDir, label: 'x' })
    payload.files['settings.cfg'].b64 = Buffer.from('tampered!').toString('base64')
    assert.throws(() => backend.importPayload({ raw: JSON.stringify(payload), dir: cfgDir }), /校验失败/)
  })

  fs.rmSync(root, { recursive: true, force: true })
  console.log('\n全部自测通过 ✓')
})().catch((err) => {
  console.error('FAILED:', err)
  process.exit(1)
})
