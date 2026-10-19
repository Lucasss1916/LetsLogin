import nodemailer from 'nodemailer'
import { config } from './config.js'

// SMTP 只为系统通知邮件服务(邀请码送达);未配置时不影响主流程,相关按钮前端隐藏
export function smtpConfigured() {
  return Boolean(config.smtpHost && config.smtpPort && config.smtpFrom)
}

let transporter = null

function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.smtpHost,
      port: config.smtpPort,
      secure: config.smtpPort === 465, // 465=SSL,587/25=STARTTLS
      auth: config.smtpUser ? { user: config.smtpUser, pass: config.smtpPass } : undefined,
      connectionTimeout: 8000,
    })
  }
  return transporter
}

export async function sendInviteMail(to, code, note = '') {
  if (!smtpConfigured()) throw new Error('SMTP 未配置:请在 .env 设置 SMTP_HOST / SMTP_PORT / SMTP_FROM(见 docs/email-server.md)')
  const info = await getTransporter().sendMail({
    from: config.smtpFrom,
    to,
    subject: `[Let's Log !n] 你的注册邀请码:${code}`,
    text: `你的注册邀请码:${code}\n\n在 Let's Log !n 登录页选择「邀请码注册」,输入该邀请码设置账号。\n${note ? `备注:${note}\n` : ''}请勿外传。`,
    html: `
      <div style="font-family:Consolas,monospace;background:#0d121f;color:#e2eeff;padding:26px;border:1px solid #00f0ff55">
        <p style="margin:0 0 6px;color:#00f0ff;letter-spacing:2px">// INVITE CODE</p>
        <p style="margin:0 0 18px;font-size:30px;font-weight:700;color:#ffffff;letter-spacing:6px">${code}</p>
        <p style="margin:0 0 6px">在登录页选择「邀请码注册」,使用邀请码完成注册。</p>
        ${note ? `<p style="margin:0;color:#ff0055">备注:${note}</p>` : ''}
        <p style="margin:14px 0 0;color:#6f829d">请勿外传该邮件。</p>
      </div>`,
  })
  return info.messageId
}
