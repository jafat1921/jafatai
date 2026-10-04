import fs from 'node:fs'
import path from 'node:path'

// Credentials come from the repo-root .env so they never live in test code.
export function adminCredentials() {
  const file = path.resolve(import.meta.dirname, '../../.env')
  const vars: Record<string, string> = {}
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m) vars[m[1]] = m[2].replace(/^['"]|['"]$/g, '')
  }
  const email = process.env.E2E_EMAIL ?? vars.ADMIN_EMAIL
  const password = process.env.E2E_PASSWORD ?? vars.ADMIN_PASSWORD
  if (!email || !password) throw new Error('ADMIN_EMAIL / ADMIN_PASSWORD missing from .env')
  return { email, password }
}
