// 赛季倒计时自检:node test/season.test.js
import assert from 'node:assert/strict'

// config.js 启动即校验这两项,自检不碰 DB/鉴权,给占位即可
process.env.JWT_SECRET ||= 'test-only'
process.env.SECRETS_KEY ||= '0'.repeat(64)

const { config } = await import('../src/config.js')
const { getSeasonInfo } = await import('../src/apex.js')

// 推算模式(未配 APEX_SEASON_*):赛季区间必须包住 now,
// split 落在 1..2,段末在 now 之后且不超过赛季末
for (const iso of ['2024-02-13T17:00:00Z', '2026-10-22T12:34:56Z', '2027-06-01T00:00:00Z']) {
  const now = Date.parse(iso)
  const { source, season: s } = getSeasonInfo(now)
  assert.equal(source, 'est')
  assert.ok(Date.parse(s.startsAt) <= now && now < Date.parse(s.endsAt), `区间未包住 ${iso}`)
  assert.ok(s.split >= 1 && s.split <= 2, `split 越界 ${iso}`)
  assert.ok(Date.parse(s.splitEndsAt) > now, `段末已过 ${iso}`)
  assert.ok(Date.parse(s.splitEndsAt) <= Date.parse(s.endsAt), `段末超出赛季末 ${iso}`)
  assert.match(s.name, /^Season \d+$/)
}

// config 模式(.env 显式配置)优先于推算。config 在模块加载时读 env,
// 这里直接改对象,免起第二个进程。
Object.assign(config, {
  apexSeasonName: 'Season 99',
  apexSeasonSplit: 2,
  apexSeasonStartsAt: '2026-10-01T09:00:00Z',
  apexSeasonSplitEndsAt: '2026-11-15T09:00:00Z',
  apexSeasonEndsAt: '2026-12-30T09:00:00Z',
  apexSeasonSource: 'EA 公告 · 2026-10-23 核对',
})
const cfg = getSeasonInfo(Date.parse('2026-10-22T00:00:00Z'))
assert.equal(cfg.source, 'config')
assert.equal(cfg.season.name, 'Season 99')
assert.equal(cfg.season.split, 2)
assert.equal(cfg.season.endsAt, '2026-12-30T09:00:00.000Z')
assert.equal(cfg.season.splitEndsAt, '2026-11-15T09:00:00.000Z')
assert.equal(cfg.season.sourceNote, 'EA 公告 · 2026-10-23 核对')

// 结束时间缺失/不可解析时必须退回推算,不能把 NaN 当倒计时目标发给前端
config.apexSeasonEndsAt = '不是时间'
assert.equal(getSeasonInfo(Date.now()).source, 'est')

console.log('season ok')
