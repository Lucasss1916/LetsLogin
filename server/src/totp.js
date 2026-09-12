import { authenticator } from 'otplib'

export function totpFor(secret) {
  if (!secret) return { code: null, remaining: null }
  const clean = String(secret).replace(/\s+/g, '')
  return {
    code: authenticator.generate(clean),
    remaining: authenticator.timeRemaining(),
  }
}

export function validTotpSecret(secret) {
  try {
    return authenticator.check(authenticator.generate(String(secret).replace(/\s+/g, '')), String(secret).replace(/\s+/g, ''))
  } catch {
    return false
  }
}
