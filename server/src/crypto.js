import crypto from 'node:crypto'
import { config } from './config.js'

const KEY = Buffer.from(config.secretsKey, 'hex')

export function encryptSecret(plain) {
  if (plain == null) return null
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv)
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()])
  return {
    iv: iv.toString('hex'),
    tag: cipher.getAuthTag().toString('hex'),
    data: data.toString('hex'),
  }
}

export function decryptSecret(enc) {
  if (!enc) return null
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(enc.iv, 'hex'))
  decipher.setAuthTag(Buffer.from(enc.tag, 'hex'))
  return Buffer.concat([decipher.update(Buffer.from(enc.data, 'hex')), decipher.final()]).toString('utf8')
}
