import { createServer } from 'node:http'
import { createReadStream, existsSync, statSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes, randomUUID, scryptSync, timingSafeEqual, createHmac } from 'node:crypto'

const root = fileURLToPath(new URL('.', import.meta.url))
const port = Number(process.env.PORT || 3000)
const dataDir = process.env.DATA_DIR || join(root, '.data')
const dataFile = join(dataDir, 'project-supervisor.json')
const sessionSecret = process.env.SESSION_SECRET || (process.env.NODE_ENV === 'production' ? '' : 'development-only-change-me')
const gatewayKey = process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN || ''
const assistantModel = process.env.VERCEL_ASSISTANT_MODEL || 'anthropic/claude-opus-5'

mkdirSync(dataDir, { recursive: true })
if (!sessionSecret) throw new Error('SESSION_SECRET must be configured in production.')

const mime = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.zip': 'application/zip',
}

function initialDb() { return { users: [], chats: [], supervisorJobs: [] } }
function loadDb() {
  if (!existsSync(dataFile)) return initialDb()
  const parsed = JSON.parse(readFileSync(dataFile, 'utf8'))
  return { ...initialDb(), ...parsed }
}
function saveDb(db) {
  const tmp = `${dataFile}.tmp`
  writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8')
  renameSync(tmp, dataFile)
}

const publicFiles = new Set(['/', '/index.html', '/app.js', '/styles.css', '/mobile-nav.js', '/mobile-nav.css'])
function safePath(urlPath) {
  if (!publicFiles.has(urlPath)) return null
  return join(root, urlPath === '/' ? 'index.html' : urlPath.slice(1))
}
function sendJson(res, status, data, extraHeaders = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extraHeaders })
  res.end(JSON.stringify(data))
}
async function readJson(req, max = 1_000_000) {
  let size = 0; const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > max) throw new Error('Request body too large.')
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new Error('Invalid JSON body.') }
}
function normalizeEmail(value) { return String(value || '').trim().toLowerCase() }
function validEmail(email) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254 }
function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const hash = scryptSync(password, salt, 64).toString('hex')
  return `${salt}:${hash}`
}
function verifyPassword(password, stored) {
  const [salt, expectedHex] = String(stored || '').split(':')
  if (!salt || !expectedHex) return false
  const actual = scryptSync(password, salt, 64)
  const expected = Buffer.from(expectedHex, 'hex')
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}
function b64url(input) { return Buffer.from(input).toString('base64url') }
function signToken(payload) {
  const body = b64url(JSON.stringify(payload))
  const sig = createHmac('sha256', sessionSecret).update(body).digest('base64url')
  return `${body}.${sig}`
}
function parseToken(token) {
  try {
    const [body, sig] = String(token || '').split('.')
    if (!body || !sig) return null
    const expected = createHmac('sha256', sessionSecret).update(body).digest('base64url')
    if (expected.length !== sig.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return null
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    if (!payload?.uid || !payload?.exp || Date.now() > payload.exp) return null
    return payload
  } catch { return null }
}
function cookies(req) {
  const out = {}
  for (const pair of String(req.headers.cookie || '').split(';')) {
    const i = pair.indexOf('='); if (i < 0) continue
    out[pair.slice(0, i).trim()] = decodeURIComponent(pair.slice(i + 1).trim())
  }
  return out
}
function sessionUser(req, db = loadDb()) {
  const payload = parseToken(cookies(req).ps_session)
  if (!payload) return null
  return db.users.find(u => u.id === payload.uid) || null
}
function publicUser(user) { return user ? { id: user.id, email: user.email, name: user.name || '', createdAt: user.createdAt } : null }
function sessionCookie(req, userId) {
  const token = signToken({ uid: userId, exp: Date.now() + 30 * 24 * 60 * 60 * 1000 })
  const secure = String(req.headers['x-forwarded-proto'] || '').includes('https')
  return `ps_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 60 * 60}${secure ? '; Secure' : ''}`
}
function clearSessionCookie(req) {
  const secure = String(req.headers['x-forwarded-proto'] || '').includes('https')
  return `ps_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`
}
function requireUser(req, res, db) {
  const user = sessionUser(req, db)
  if (!user) { sendJson(res, 401, { ok: false, error: 'Authentication required.' }); return null }
  return user
}
function sameOriginMutation(req, res) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return true
  const origin = req.headers.origin
  const expected = `${req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'}://${req.headers.host}`
  if (origin && origin !== expected) { sendJson(res, 403, { ok: false, error: 'Cross-origin request rejected.' }); return false }
  const fetchSite = req.headers['sec-fetch-site']
  if (fetchSite === 'cross-site') { sendJson(res, 403, { ok: false, error: 'Cross-site request rejected.' }); return false }
  return true
}

function chatSummary(chat) {
  return { id: chat.id, title: chat.title, createdAt: chat.createdAt, updatedAt: chat.updatedAt, messageCount: chat.messages.length }
}
function ownChat(db, userId, chatId) { return db.chats.find(c => c.id === chatId && c.userId === userId) || null }

async function handleApi(req, res, pathname) {
  if (!sameOriginMutation(req, res)) return
  const db = loadDb()

  if (pathname === '/api/auth/signup' && req.method === 'POST') {
    const body = await readJson(req)
    const email = normalizeEmail(body.email), password = String(body.password || ''), name = String(body.name || '').trim().slice(0, 80)
    if (!validEmail(email)) return sendJson(res, 400, { ok: false, error: 'Enter a valid email address.' })
    if (password.length < 8 || password.length > 200) return sendJson(res, 400, { ok: false, error: 'Password must be at least 8 characters.' })
    if (db.users.some(u => u.email === email)) return sendJson(res, 409, { ok: false, error: 'An account with that email already exists.' })
    const user = { id: randomUUID(), email, name, passwordHash: hashPassword(password), createdAt: Date.now() }
    db.users.push(user); saveDb(db)
    return sendJson(res, 201, { ok: true, user: publicUser(user) }, { 'set-cookie': sessionCookie(req, user.id) })
  }

  if (pathname === '/api/auth/login' && req.method === 'POST') {
    const body = await readJson(req)
    const email = normalizeEmail(body.email), password = String(body.password || '')
    const user = db.users.find(u => u.email === email)
    if (!user || !verifyPassword(password, user.passwordHash)) return sendJson(res, 401, { ok: false, error: 'Incorrect email or password.' })
    return sendJson(res, 200, { ok: true, user: publicUser(user) }, { 'set-cookie': sessionCookie(req, user.id) })
  }

  if (pathname === '/api/auth/logout' && req.method === 'POST') return sendJson(res, 200, { ok: true }, { 'set-cookie': clearSessionCookie(req) })
  if (pathname === '/api/me' && req.method === 'GET') return sendJson(res, 200, { ok: true, user: publicUser(sessionUser(req, db)), assistant: { configured: Boolean(gatewayKey), model: assistantModel } })

  if (pathname === '/api/chats' && req.method === 'GET') {
    const user = requireUser(req, res, db); if (!user) return
    const chats = db.chats.filter(c => c.userId === user.id).sort((a,b) => b.updatedAt - a.updatedAt).map(chatSummary)
    return sendJson(res, 200, { ok: true, chats })
  }
  if (pathname === '/api/chats' && req.method === 'POST') {
    const user = requireUser(req, res, db); if (!user) return
    const body = await readJson(req)
    const now = Date.now(); const title = String(body.title || 'New chat').trim().slice(0, 120) || 'New chat'
    const chat = { id: randomUUID(), userId: user.id, title, messages: [], createdAt: now, updatedAt: now }
    db.chats.push(chat); saveDb(db)
    return sendJson(res, 201, { ok: true, chat })
  }

  const chatMatch = pathname.match(/^\/api\/chats\/([0-9a-f-]+)$/i)
  if (chatMatch && req.method === 'GET') {
    const user = requireUser(req, res, db); if (!user) return
    const chat = ownChat(db, user.id, chatMatch[1]); if (!chat) return sendJson(res, 404, { ok: false, error: 'Chat not found.' })
    return sendJson(res, 200, { ok: true, chat })
  }
  if (chatMatch && req.method === 'DELETE') {
    const user = requireUser(req, res, db); if (!user) return
    const index = db.chats.findIndex(c => c.id === chatMatch[1] && c.userId === user.id)
    if (index < 0) return sendJson(res, 404, { ok: false, error: 'Chat not found.' })
    db.chats.splice(index, 1); saveDb(db)
    return sendJson(res, 200, { ok: true })
  }

  if (pathname === '/api/assistant' && req.method === 'POST') {
    const user = requireUser(req, res, db); if (!user) return
    const body = await readJson(req)
    const text = String(body.message || '').trim().slice(0, 20_000)
    if (!text) return sendJson(res, 400, { ok: false, error: 'Message is required.' })
    let chat = body.chatId ? ownChat(db, user.id, String(body.chatId)) : null
    if (body.chatId && !chat) return sendJson(res, 404, { ok: false, error: 'Chat not found.' })
    if (!chat) {
      const now = Date.now(); chat = { id: randomUUID(), userId: user.id, title: text.slice(0, 52), messages: [], createdAt: now, updatedAt: now }; db.chats.push(chat)
    }
    const now = Date.now(); chat.messages.push({ id: randomUUID(), role: 'user', content: text, createdAt: now }); chat.updatedAt = now; saveDb(db)

    if (!gatewayKey) return sendJson(res, 503, { ok: false, error: 'Vercel AI Gateway is not configured yet. Add AI_GATEWAY_API_KEY to enable the Assistant.', chat })

    const messages = [
      { role: 'system', content: 'You are the Project Supervisor Assistant. Help the user plan, understand, and manage supervised AI work. Be concise, technical when useful, and never claim you executed extension or ChatGPT actions unless the app confirms them.' },
      ...chat.messages.slice(-30).map(m => ({ role: m.role, content: m.content }))
    ]
    const response = await fetch('https://ai-gateway.vercel.sh/v1/chat/completions', {
      method: 'POST', headers: { 'authorization': `Bearer ${gatewayKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: assistantModel, messages, stream: false })
    })
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500)
      return sendJson(res, 502, { ok: false, error: `Vercel AI Gateway request failed (${response.status}).`, detail, chat })
    }
    const result = await response.json()
    const reply = String(result?.choices?.[0]?.message?.content || '').trim()
    if (!reply) return sendJson(res, 502, { ok: false, error: 'Vercel AI Gateway returned no assistant text.', chat })
    // Reload after the remote request: another request may have saved a different chat meanwhile.
    const latest = loadDb(); const saved = ownChat(latest, user.id, chat.id)
    if (!saved) return sendJson(res, 409, { ok: false, error: 'Chat was deleted while the assistant was responding.' })
    saved.messages.push({ id: randomUUID(), role: 'assistant', content: reply, createdAt: Date.now() }); saved.updatedAt = Date.now(); saveDb(latest)
    return sendJson(res, 200, { ok: true, reply, chat: saved, model: result.model || assistantModel })
  }

  if (pathname === '/api/supervisor-jobs' && req.method === 'GET') {
    const user = requireUser(req, res, db); if (!user) return
    return sendJson(res, 200, { ok: true, jobs: db.supervisorJobs.filter(j => j.userId === user.id).sort((a,b)=>b.updatedAt-a.updatedAt) })
  }
  if (pathname === '/api/supervisor-jobs' && req.method === 'POST') {
    const user = requireUser(req, res, db); if (!user) return
    const body = await readJson(req); const now = Date.now()
    const id = String(body.id || randomUUID())
    const existing = db.supervisorJobs.find(j => j.id === id && j.userId === user.id)
    const safe = { id, userId: user.id, title: String(body.title || '').slice(0,120), projectUrl: String(body.projectUrl || '').slice(0,2000), status: String(body.status || 'queued').slice(0,40), progressLabel: String(body.progressLabel || '').slice(0,500), modelLabel: String(body.modelLabel || '').slice(0,120), updatedAt: now }
    if (existing) Object.assign(existing, safe); else db.supervisorJobs.push({ ...safe, createdAt: now })
    saveDb(db); return sendJson(res, 200, { ok: true, job: safe })
  }

  return sendJson(res, 404, { ok: false, error: 'API route not found.' })
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
    if (url.pathname === '/health') return sendJson(res, 200, { ok: true, service: 'project-supervisor', version: '0.2.0', auth: true, assistantConfigured: Boolean(gatewayKey), persistence: process.env.DATA_DIR ? 'configured-path' : 'local-filesystem' })
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url.pathname)

    let path = safePath(url.pathname)
    if (!path || !existsSync(path) || !statSync(path).isFile()) { res.writeHead(404); return res.end('Not found') }
    const headers = {
      'content-type': mime[extname(path).toLowerCase()] || 'application/octet-stream',
      'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer', 'permissions-policy': 'camera=(), microphone=(), geolocation=()',
      'content-security-policy': "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      'cache-control': extname(path) === '.html' ? 'no-cache' : 'public, max-age=300',
    }
    res.writeHead(200, headers); createReadStream(path).pipe(res)
  } catch (error) {
    console.error(error)
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: process.env.NODE_ENV === 'production' ? 'Server error.' : (error instanceof Error ? error.message : 'Server error.') })
    else res.end()
  }
})

if (process.env.NODE_ENV !== 'test') server.listen(port, '0.0.0.0', () => console.log(`Project Supervisor v0.2 listening on ${port}`))
export { server }
