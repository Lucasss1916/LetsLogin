export const config = {
  port: Number(process.env.PORT || 3000),
  databaseUrl: process.env.DATABASE_URL || 'postgres://letslogin:letslogin_pass@localhost:5432/letslogin',
  jwtSecret: process.env.JWT_SECRET,
  secretsKey: process.env.SECRETS_KEY,
  adminInitialPassword: process.env.ADMIN_INITIAL_PASSWORD || 'admin123',
  sessionTimeoutMinutes: Number(process.env.SESSION_TIMEOUT_MINUTES || 30),
  apexApiKey: process.env.APEX_API_KEY || '',
  // Apex 赛季倒计时(可选精确校准;不配则按社区口径推算,UI 会标注"推算")
  apexSeasonName: process.env.APEX_SEASON_NAME || '',
  apexSeasonSplit: Number(process.env.APEX_SEASON_SPLIT || 0),
  apexSeasonStartsAt: process.env.APEX_SEASON_STARTS_AT || '',
  apexSeasonSplitEndsAt: process.env.APEX_SEASON_SPLIT_ENDS_AT || '',
  apexSeasonEndsAt: process.env.APEX_SEASON_ENDS_AT || '',
  // 这组时间是谁给的 / 何时核对的,直接展示在赛季卡上,免得过期了没人知道该找谁对
  apexSeasonSource: process.env.APEX_SEASON_SOURCE || '',
  // SMTP 发信(可选):配置后管理员生成邀请码可直发邮箱;推荐 465(SSL)/587(TLS)
  smtpHost: process.env.SMTP_HOST || '',
  smtpPort: Number(process.env.SMTP_PORT || 465),
  smtpUser: process.env.SMTP_USER || '',
  smtpPass: process.env.SMTP_PASS || '',
  smtpFrom: process.env.SMTP_FROM || '',
}

for (const [k, v] of Object.entries({ JWT_SECRET: config.jwtSecret, SECRETS_KEY: config.secretsKey })) {
  if (!v) {
    console.error(`缺少环境变量 ${k},参见 .env.example`)
    process.exit(1)
  }
}
if (!/^[0-9a-f]{64}$/i.test(config.secretsKey)) {
  console.error('SECRETS_KEY 必须是 64 个十六进制字符(openssl rand -hex 32)')
  process.exit(1)
}
