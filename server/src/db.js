import pg from 'pg'
import bcrypt from 'bcryptjs'
import { config } from './config.js'

export const pool = new pg.Pool({ connectionString: config.databaseUrl })

export async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin','user')),
      must_change_password BOOLEAN NOT NULL DEFAULT TRUE,
      disabled BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS accounts (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      platform TEXT DEFAULT '',
      login_username TEXT NOT NULL,
      password_enc JSONB NOT NULL,
      totp_enc JSONB,
      note TEXT DEFAULT '',
      owner_id INTEGER NOT NULL REFERENCES users(id),
      visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','all','selected')),
      disabled BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS account_shares (
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY (account_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id SERIAL PRIMARY KEY,
      account_id INTEGER NOT NULL REFERENCES accounts(id),
      user_id INTEGER NOT NULL REFERENCES users(id),
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      ended_at TIMESTAMPTZ,
      end_reason TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions(account_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, started_at DESC);
    -- 同一账号同时最多一条活跃会话(ended_at IS NULL),防止并发签出产生双占用
    CREATE UNIQUE INDEX IF NOT EXISTS uq_sessions_active ON sessions(account_id) WHERE ended_at IS NULL;
    CREATE TABLE IF NOT EXISTS audit_logs (
      id BIGSERIAL PRIMARY KEY,
      actor_id INTEGER REFERENCES users(id),
      action TEXT NOT NULL,
      target TEXT,
      meta JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    -- 游戏目录:固定游戏列表 + 段位阶梯定义(rank_tiers 形如 [{"tier":"白银","sub":4},...],
    -- sub 为小段数量,0 表示该段位不分小段,如大师/猎杀者)
    CREATE TABLE IF NOT EXISTS games (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      rank_tiers JSONB NOT NULL DEFAULT '[]'
    );
    -- 账号关联的游戏:一个账号可上多个游戏,各自标记当前段位(rank 为展示标签,如 "白银2")
    CREATE TABLE IF NOT EXISTS account_games (
      id SERIAL PRIMARY KEY,
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      rank TEXT NOT NULL DEFAULT '未定级',
      UNIQUE (account_id, game_id)
    );
  `)

  // 上号会话记录所选游戏(account_games),账号/游戏被删则置空
  await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS account_game_id INTEGER REFERENCES account_games(id) ON DELETE SET NULL`)

  // 修正 sessions→accounts 外键:删除账号时应级联清掉其占用/历史会话(否则 ON DELETE 会被 FK 拦截)
  await pool.query(`ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_account_id_fkey`)
  await pool.query(
    `ALTER TABLE sessions ADD CONSTRAINT sessions_account_id_fkey
       FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE`)

  // 预置游戏目录(目前只需 Apex 示例,空表才写入)
  const { rows: gameCount } = await pool.query('SELECT COUNT(*)::int AS n FROM games')
  if (gameCount[0].n === 0) {
    await pool.query(
      `INSERT INTO games (name, rank_tiers) VALUES ($1, $2)`,
      ['Apex 英雄', JSON.stringify([
        { tier: '入门', sub: 0 },
        { tier: '青铜', sub: 4 },
        { tier: '白银', sub: 4 },
        { tier: '黄金', sub: 4 },
        { tier: '白金', sub: 4 },
        { tier: '钻石', sub: 4 },
        { tier: '大师', sub: 0 },
        { tier: '猎杀者', sub: 0 },
      ])]
    )
    console.log('[migrate] 已预置游戏: Apex 英雄(含段位阶梯)')
  }

  // 旧表兼容:新增 token 版本号,用于改密/重置后吊销旧 JWT
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 1`)

  // 登录失败尝试(限流用,持久化到重启后仍生效;按期清理)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS login_attempts (
      id BIGSERIAL PRIMARY KEY,
      username TEXT NOT NULL,
      failed_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_login_attempts_user ON login_attempts(username, failed_at DESC);
  `)

  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM users')
  if (rows[0].n === 0) {
    const hash = await bcrypt.hash(config.adminInitialPassword, 10)
    await pool.query(
      `INSERT INTO users (username, password_hash, role, must_change_password) VALUES ('admin', $1, 'admin', TRUE)`,
      [hash]
    )
    console.log('[migrate] 已创建初始管理员 admin(首次登录强制改密)')
  }
}

export async function audit(actorId, action, target = null, meta = {}) {
  await pool.query(
    'INSERT INTO audit_logs (actor_id, action, target, meta) VALUES ($1,$2,$3,$4)',
    [actorId, action, target, meta]
  )
}
