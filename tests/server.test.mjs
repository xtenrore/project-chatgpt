import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const dir = mkdtempSync(join(tmpdir(), 'ps-v02-'))
const port = 18881
const child = spawn(process.execPath, ['server.mjs'], { cwd: new URL('..', import.meta.url).pathname, env: { ...process.env, PORT:String(port), DATA_DIR:dir, SESSION_SECRET:'test-secret-123456789', NODE_ENV:'production' }, stdio:['ignore','pipe','pipe'] })
const base = `http://127.0.0.1:${port}`
const wait = ms => new Promise(r=>setTimeout(r,ms))
for(let i=0;i<40;i++){ try{ const r=await fetch(`${base}/health`); if(r.ok) break }catch{} await wait(100) }

try {
  const health = await fetch(`${base}/health`).then(r=>r.json())
  assert.equal(health.ok,true); assert.equal(health.version,'0.2.0')

  const signup = await fetch(`${base}/api/auth/signup`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({email:'test@example.com',password:'password123',name:'Tester'}) })
  assert.equal(signup.status,201)
  const cookie = signup.headers.get('set-cookie')?.split(';')[0]
  assert.ok(cookie)

  const me = await fetch(`${base}/api/me`, { headers:{cookie} }).then(r=>r.json())
  assert.equal(me.user.email,'test@example.com')

  const create = await fetch(`${base}/api/chats`, { method:'POST', headers:{cookie,'content-type':'application/json'}, body:JSON.stringify({title:'Saved chat'}) })
  assert.equal(create.status,201)
  const chat = (await create.json()).chat
  const loaded = await fetch(`${base}/api/chats/${chat.id}`, { headers:{cookie} }).then(r=>r.json())
  assert.equal(loaded.chat.title,'Saved chat')

  const assistant = await fetch(`${base}/api/assistant`, { method:'POST', headers:{cookie,'content-type':'application/json'}, body:JSON.stringify({chatId:chat.id,message:'hello'}) })
  assert.equal(assistant.status,503)
  const assistantBody=await assistant.json(); assert.match(assistantBody.error,/AI_GATEWAY_API_KEY/)

  const badLogin = await fetch(`${base}/api/auth/login`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({email:'test@example.com',password:'wrongpass'}) })
  assert.equal(badLogin.status,401)
  console.log('server tests passed')
} finally { child.kill('SIGTERM'); rmSync(dir,{recursive:true,force:true}) }
