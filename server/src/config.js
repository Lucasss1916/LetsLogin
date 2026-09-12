export const config = {
  port: Number(process.env.PORT || 3000),
  databaseUrl: process.env.DATABASE_URL || 'postgres://letslogin:letslogin_pass@localhost:5432/letslogin',
  jwtSecret: process.env.JWT_SECRET,
  secretsKey: process.env.SECRETS_KEY,
  adminInitialPassword: process.env.ADMIN_INITIAL_PASSWORD || 'admin123',
  sessionTimeoutMinutes: Number(process.env.SESSION_TIMEOUT_MINUTES || 30),
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
