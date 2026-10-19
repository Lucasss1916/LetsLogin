import { config } from './config.js'

// ————————————————————————————————————————————————
// Apex 地图轮换数据源
//   1) 配置 APEX_API_KEY(apexstatus / mozambiquehe 免费 key)→ 官方数据,
//      服务端缓存 10 分钟(免费档每日 200 次限额,10 分钟约需 144 次/天)
//   2) 未配置/调用失败 → 按 Apex 标准 BR 轮换周期本地推算兜底
// 统一输出:{ source, fetchedAtMs, modes: [{ key, name, current: {map,image,remainingSecs,durationSecs,event}, next: {map,image} }] }
// ————————————————————————————————————————————————

const ROTATION_API_URL = 'https://api.mozambiquehe.re/maprotation?version=2'
const CACHE_TTL_MS = 10 * 60 * 1000
const FETCH_TIMEOUT_MS = 8000

// 兜底推算:大逃杀标准地图每 2 小时轮换一次,池内地图循环。
// 地图池随赛季 split 变化,赛季更替时需人工更新;配置 APEX_API_KEY 后自动改为官方数据、免维护。
const FALLBACK_PERIOD_SECS = 2 * 60 * 60
const FALLBACK_POOL = [
  { map: '风暴点 Storm Point', image: '' },
  { map: 'E区 E-District', image: '' },
  { map: '世界尽头 World\'s Edge', image: '' },
  { map: '诸王峡谷 Kings Canyon', image: '' },
]

function fallbackRotation(nowMs) {
  const nowSecs = Math.floor(nowMs / 1000)
  const idx = Math.floor(nowSecs / FALLBACK_PERIOD_SECS) % FALLBACK_POOL.length
  const remaining = FALLBACK_PERIOD_SECS - (nowSecs % FALLBACK_PERIOD_SECS)
  return {
    key: 'battle_royale',
    name: '大逃杀(推算)',
    current: {
      map: FALLBACK_POOL[idx].map,
      image: FALLBACK_POOL[idx].image,
      remainingSecs: remaining,
      durationSecs: FALLBACK_PERIOD_SECS,
      event: null,
    },
    next: { map: FALLBACK_POOL[(idx + 1) % FALLBACK_POOL.length].map, image: '' },
  }
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

async function fetchRemoteRotation() {
  const res = await fetch(ROTATION_API_URL, {
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
  return { source: 'api', modes }
}

let cache = { data: null, atMs: 0 }

export async function getMapRotation() {
  const nowMs = Date.now()
  if (cache.data && nowMs - cache.atMs < CACHE_TTL_MS) return cache.data

  if (config.apexApiKey) {
    try {
      const data = await fetchRemoteRotation()
      data.fetchedAtMs = nowMs
      cache = { data, atMs: nowMs }
      return data
    } catch (err) {
      // 请求失败时回退到过期缓存(实况可能滞后),并把原因带给前端提示
      if (cache.data) return { ...cache.data, fetchedAtMs: cache.atMs, staleNotice: err.message }
      throw err
    }
  }

  return { source: 'fallback', fetchedAtMs: nowMs, modes: [fallbackRotation(nowMs)] }
}
