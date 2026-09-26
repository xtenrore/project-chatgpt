import { createServer } from 'node:http'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('.', import.meta.url))
const port = Number(process.env.PORT || 3000)
const mime = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.zip': 'application/zip',
}

function safePath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0] || '/')
  const relative = normalize(decoded).replace(/^([/\\])+/, '')
  if (relative.includes('..')) return null
  return join(root, relative || 'index.html')
}

const server = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    return res.end(JSON.stringify({ ok: true, service: 'project-supervisor', version: '0.1.0' }))
  }
  let path = safePath(req.url || '/')
  if (!path) { res.writeHead(400); return res.end('Bad request') }
  if (existsSync(path) && statSync(path).isDirectory()) path = join(path, 'index.html')
  if (!existsSync(path) || !statSync(path).isFile()) path = join(root, 'index.html')
  const headers = {
    'content-type': mime[extname(path).toLowerCase()] || 'application/octet-stream',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
    'cache-control': extname(path) === '.html' ? 'no-cache' : 'public, max-age=300',
  }
  res.writeHead(200, headers)
  createReadStream(path).pipe(res)
})

server.listen(port, '0.0.0.0', () => console.log(`Project Supervisor listening on ${port}`))
