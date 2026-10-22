import { config } from './config.js'

// ————————————————————————————————————————————————
// Apex 地图轮换数据源
//   1) 配置 APEX_API_KEY(apexstatus / mozambiquehe 免费 key)→ 官方数据,
//      服务端缓存 10 分钟(免费档每日 200 次限额,10 分钟约需 144 次/天)
//   2) 未配置/调用失败 → 按 Apex 标准 BR 轮换周期本地推算兜底
// 统一输出:{ source, fetchedAtMs, modes: [{ key, name, current: {map,image,remainingSecs,durationSecs,event}, next: {map,image} }] }
// ————————————————————————————————————————————————

const ROTATION_API_URL = 'https://api.apexlegendsstatus.com/maprotation?version=2'
const CACHE_TTL_MS = 10 * 60 * 1000
const FETCH_TIMEOUT_MS = 8000

// Apex 轮换按「平台」分池(PC / PS4 / X1),同平台全球各连接区(东京/法兰克福等)一致;
// 亚洲玩家默认为 PC 端(亚服即 platform=PC)。外部值一律归一化,防 URL 注入。
const PLATFORMS = ['PC', 'PS4', 'X1']
const DEFAULT_PLATFORM = 'PC'

export function normalizePlatform(value) {
  const p = String(value || '').toUpperCase()
  return PLATFORMS.includes(p) ? p : DEFAULT_PLATFORM
}

// 兜底推算(无 APEX_API_KEY 时):按社区口径的排位轮换规则计算。
// 口径来源:apex 社区桌面组件(2026-10):排位三图池、270 分钟一槽、anchor=2026-05-25 16:00(+08:00);
// 大逃杀公共池按 slot 复用同池、2 小时一换。赛季 split 后只需更新下面三个常量,
// 或直接配置 APEX_API_KEY 走官方数据(免维护,推荐)。
const FALLBACK_ANCHOR_MS = Date.parse('2026-05-25T16:00:00+08:00')
const FALLBACK_POOL = ['残月 Broken Moon', '风暴点 Storm Point', '奥林匹斯 Olympus']
const BR_PERIOD_MS = 2 * 60 * 60 * 1000
const RANKED_PERIOD_MS = 270 * 60 * 1000

function fallbackSlot(nowMs, periodMs) {
  const anchored = Math.max(0, nowMs - FALLBACK_ANCHOR_MS)
  const idx = Math.floor(anchored / periodMs) % FALLBACK_POOL.length
  const remainingSecs = Math.max(1, Math.floor((periodMs - (anchored % periodMs)) / 1000))
  return {
    map: FALLBACK_POOL[idx],
    next_map: FALLBACK_POOL[(idx + 1) % FALLBACK_POOL.length],
    remainingSecs,
    durationSecs: Math.floor(periodMs / 1000),
  }
}

function fallbackRotation(nowMs) {
  const br = fallbackSlot(nowMs, BR_PERIOD_MS)
  const rk = fallbackSlot(nowMs, RANKED_PERIOD_MS)
  return [
    {
      key: 'battle_royale',
      name: '大逃杀(推算)',
      current: { map: br.map, image: '', remainingSecs: br.remainingSecs, durationSecs: br.durationSecs, event: null },
      next: { map: br.next_map, image: '' },
    },
    {
      key: 'ranked',
      name: '排位(推算)',
      current: { map: rk.map, image: '', remainingSecs: rk.remainingSecs, durationSecs: rk.durationSecs, event: null },
      next: { map: rk.next_map, image: '' },
    },
  ]
}

// 远程字段兼容:v2 为 map/remainingSecs/DurationSecs,老端点/变体为 mapName 等,统一防御
function pickImage(item) {
  return item?.asset || item?.image || ''
}

function normalizeMode(key, name, raw) {
  const cur = raw?.current
  if (!cur) return null
  const next = raw?.next
  return {
    key,
    name,
    current: {
      map: cur.map ?? cur.mapName ?? '未知',
      image: pickImage(cur),
      remainingSecs: Number(cur.remainingSecs) || 0,
      durationSecs: Number(cur.DurationSecs ?? cur.durationSecs) || 0,
      event: cur.event || null,
    },
    next: next ? { map: next.map ?? next.mapName ?? '待公布', image: pickImage(next) } : null,
  }
}

async function fetchRemoteRotation(platform) {
  const res = await fetch(`${ROTATION_API_URL}&platform=${platform}`, {
    headers: { Authorization: config.apexApiKey },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!res.ok) {
    const hint = (await res.text()).slice(0, 140).replace(/\s+/g, ' ')
    throw new Error(`数据源返回 ${res.status}:${hint}`)
  }
  const raw = await res.json()
  const modes = [
    normalizeMode('battle_royale', '大逃杀', raw.battle_royale),
    normalizeMode('ranked', '排位', raw.ranked),
    normalizeMode('ltm', '限时模式', raw.ltm),
  ].filter(Boolean)
  if (!modes.length) throw new Error('数据源响应中没有可用模式')
  return { source: 'api', platform, modes }
}

let cache = { data: null, atMs: 0, platform: DEFAULT_PLATFORM }

export async function getMapRotation(rawPlatform = DEFAULT_PLATFORM) {
  const platform = normalizePlatform(rawPlatform)
  const nowMs = Date.now()
  if (cache.data && cache.platform === platform && nowMs - cache.atMs < CACHE_TTL_MS) return cache.data

  if (config.apexApiKey) {
    try {
      const data = await fetchRemoteRotation(platform)
      data.fetchedAtMs = nowMs
      cache = { data, atMs: nowMs, platform }
      return data
    } catch (err) {
      // 请求失败时回退到过期缓存(实况可能滞后),并把原因带给前端提示
      if (cache.data) return { ...cache.data, fetchedAtMs: cache.atMs, staleNotice: err.message }
      throw err
    }
  }

  // 兜底推算:各平台同池;platform 不影响计算
  return { source: 'fallback', fetchedAtMs: nowMs, platform, modes: fallbackRotation(nowMs) }
}

// ————————————————————————————————————————————————
// Apex 赛季倒计时
//   1) .env 显式配置(APEX_SEASON_NAME + APEX_SEASON_ENDS_AT 必填)→ 权威精确
//   2) 未配置 → 按社区口径推算:Season 23 起点 2024-02-13、90 天一赛季、
//      一赛季两段各 45 天(存在短赛季漂移,UI 明示"推算")
// 统一输出:{ source, fetchedAtMs, season: { name, split, startsAt, splitEndsAt, endsAt } }
// 时间均为 ISO 字符串;startsAt/splitEndsAt 允许为 null(config 模式下可不配)
// ————————————————————————————————————————————————
const SEASON_EST_ANCHOR_MS = Date.parse('2024-02-13T17:00:00Z') // Season 23 上线时刻
const SEASON_EST_DAYS = 90
const SEASON_EST_SPLITS = 2

function estimateSeason(nowMs) {
  const totalMs = SEASON_EST_DAYS * 86400 * 1000
  const index = Math.max(0, Math.floor((nowMs - SEASON_EST_ANCHOR_MS) / totalMs))
  const startsAtMs = SEASON_EST_ANCHOR_MS + index * totalMs
  const splitLenMs = totalMs / SEASON_EST_SPLITS
  const split = Math.min(SEASON_EST_SPLITS, Math.floor((nowMs - startsAtMs) / splitLenMs) + 1)
  return {
    name: `Season ${23 + index}`,
    split,
    startsAt: new Date(startsAtMs).toISOString(),
    splitEndsAt: new Date(startsAtMs + split * splitLenMs).toISOString(),
    endsAt: new Date(startsAtMs + totalMs).toISOString(),
  }
}

export function getSeasonInfo(nowMs = Date.now()) {
  const cfgName = config.apexSeasonName
  const endsAtMs = Date.parse(config.apexSeasonEndsAt || '')
  if (cfgName && Number.isFinite(endsAtMs)) {
    const startsAtMs = Date.parse(config.apexSeasonStartsAt || '')
    const splitEndsAtMs = Date.parse(config.apexSeasonSplitEndsAt || '')
    return {
      source: 'config',
      fetchedAtMs: nowMs,
      season: {
        name: cfgName,
        split: config.apexSeasonSplit || null,
        startsAt: Number.isFinite(startsAtMs) ? new Date(startsAtMs).toISOString() : null,
        splitEndsAt: Number.isFinite(splitEndsAtMs) ? new Date(splitEndsAtMs).toISOString() : null,
        endsAt: new Date(endsAtMs).toISOString(),
      },
    }
  }
  return { source: 'est', fetchedAtMs: nowMs, season: estimateSeason(nowMs) }
}
