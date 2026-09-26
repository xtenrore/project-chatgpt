(() => {
  'use strict'
  const CHANNEL = 'PROJECT_SUPERVISOR_V1'
  let requestCounter = 0
  let bridgeState = { connected: false, jobs: [] }
  let currentUser = null
  let currentView = 'chat'
  let chats = []
  let activeChat = null
  let authMode = 'login'
  let assistantConfigured = false
  let assistantModel = ''
  let busy = false

  const $ = id => document.getElementById(id)
  const esc = value => String(value ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]))

  async function api(path, options = {}) {
    const res = await fetch(path, {
      method: options.method || 'GET', credentials: 'same-origin',
      headers: options.body ? { 'content-type': 'application/json' } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined,
    })
    let data = {}; try { data = await res.json() } catch {}
    if (!res.ok) { const err = new Error(data.error || `Request failed (${res.status})`); err.data = data; throw err }
    return data
  }

  function consumePairingFragment() {
    const params = new URLSearchParams(location.hash.replace(/^#/, ''))
    const pair = params.get('pair')
    if (!pair) return false
    localStorage.setItem('project-supervisor-pair', pair)
    history.replaceState(null, '', location.pathname + location.search)
    return true
  }

  function bridgeRequest(type, payload = {}, timeoutMs = 5000) {
    const pairKey = localStorage.getItem('project-supervisor-pair') || ''
    const requestId = `${Date.now()}-${++requestCounter}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { window.removeEventListener('message', onMessage); reject(new Error('Extension bridge did not respond.')) }, timeoutMs)
      function onMessage(event) {
        if (event.source !== window) return
        const msg = event.data
        if (!msg || msg.channel !== CHANNEL || msg.direction !== 'from-extension' || msg.requestId !== requestId) return
        clearTimeout(timer); window.removeEventListener('message', onMessage)
        if (msg.reply?.ok) resolve(msg.reply.data); else reject(new Error(msg.reply?.error || 'Extension request failed.'))
      }
      window.addEventListener('message', onMessage)
      window.postMessage({ channel: CHANNEL, direction: 'to-extension', requestId, pairKey, type, payload }, location.origin)
    })
  }

  function showModal(id, show = true) { $(id).classList.toggle('hidden', !show); $(id).setAttribute('aria-hidden', show ? 'false' : 'true') }
  function setAuthMode(mode) {
    authMode = mode
    const signup = mode === 'signup'
    $('authTitle').textContent = signup ? 'Create your account' : 'Welcome back'
    $('authSubtitle').textContent = signup ? 'Sign up with your email to save chats and supervisor history.' : 'Log in to continue to Project Supervisor.'
    $('nameField').classList.toggle('hidden', !signup)
    $('authSubmit').textContent = signup ? 'Create account' : 'Log in'
    $('authSwitchText').textContent = signup ? 'Already have an account?' : 'New here?'
    $('authSwitch').textContent = signup ? 'Log in' : 'Create an account'
    $('authPassword').autocomplete = signup ? 'new-password' : 'current-password'
    $('authError').classList.add('hidden')
  }
  function openAuth(mode) { setAuthMode(mode); showModal('authModal', true); setTimeout(() => $('authEmail').focus(), 40) }

  function renderAuthState() {
    $('authLanding').classList.toggle('hidden', Boolean(currentUser))
    $('appShell').classList.toggle('hidden', !currentUser)
    if (!currentUser) return
    const name = currentUser.name || currentUser.email.split('@')[0]
    $('accountName').textContent = name
    $('accountEmail').textContent = currentUser.email
    $('accountModalEmail').textContent = currentUser.email
    $('avatar').textContent = name.slice(0,1).toUpperCase()
    $('assistantStatus').textContent = assistantConfigured ? `Vercel AI · ${assistantModel}` : 'Vercel AI not configured'
    $('assistantStatus').className = `status-chip ${assistantConfigured ? 'good' : 'warn'}`
  }

  async function initSession() {
    consumePairingFragment()
    try {
      const data = await api('/api/me')
      currentUser = data.user
      assistantConfigured = Boolean(data.assistant?.configured)
      assistantModel = data.assistant?.model || ''
    } catch { currentUser = null }
    renderAuthState()
    if (currentUser) {
      await loadChats()
      await refreshBridge(true)
    }
  }

  async function handleAuth(event) {
    event.preventDefault(); $('authError').classList.add('hidden')
    try {
      const payload = { email: $('authEmail').value.trim(), password: $('authPassword').value, name: $('authName').value.trim() }
      const data = await api(authMode === 'signup' ? '/api/auth/signup' : '/api/auth/login', { method: 'POST', body: payload })
      currentUser = data.user; showModal('authModal', false); $('authForm').reset()
      const me = await api('/api/me'); assistantConfigured = Boolean(me.assistant?.configured); assistantModel = me.assistant?.model || ''
      renderAuthState(); await loadChats(); await refreshBridge(true)
    } catch (error) { $('authError').textContent = error.message; $('authError').classList.remove('hidden') }
  }

  async function logout() {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {})
    currentUser = null; chats = []; activeChat = null; showModal('accountModal', false); renderAuthState(); renderChatHistory(); renderMessages()
  }

  async function loadChats() {
    try { const data = await api('/api/chats'); chats = data.chats || [] } catch { chats = [] }
    renderChatHistory()
  }
  function renderChatHistory() {
    if (!currentUser) return
    $('chatHistory').innerHTML = chats.length ? chats.map(c => `<button class="history-item ${activeChat?.id === c.id ? 'active' : ''}" data-chat-id="${esc(c.id)}"><span>${esc(c.title || 'New chat')}</span><small>${c.messageCount || 0}</small></button>`).join('') : '<div class="history-empty">No saved chats yet</div>'
    document.querySelectorAll('[data-chat-id]').forEach(btn => btn.addEventListener('click', () => openChat(btn.dataset.chatId)))
  }
  async function openChat(id) {
    try { const data = await api(`/api/chats/${id}`); activeChat = data.chat; switchView('chat'); renderMessages(); renderChatHistory() } catch {}
  }
  function newChat() { activeChat = null; switchView('chat'); renderMessages(); renderChatHistory(); $('chatInput').focus() }

  function renderMessages() {
    const messages = activeChat?.messages || []
    $('emptyChat').classList.toggle('hidden', messages.length > 0)
    $('messages').innerHTML = messages.map(m => `<article class="message ${m.role === 'user' ? 'user' : 'assistant'}"><div class="message-role">${m.role === 'user' ? 'You' : 'PS'}</div><div class="message-content">${esc(m.content).replace(/\n/g, '<br>')}</div></article>`).join('')
    requestAnimationFrame(() => { $('messages').scrollTop = $('messages').scrollHeight })
  }

  async function sendAssistant(event) {
    event?.preventDefault()
    const text = $('chatInput').value.trim()
    if (!text || busy) return
    if (!assistantConfigured) {
      alert('The Vercel AI Assistant is built in, but AI_GATEWAY_API_KEY has not been configured on the server yet.')
      return
    }
    busy = true; $('chatSend').disabled = true; $('chatInput').value = ''
    const optimistic = activeChat || { id: null, title: text.slice(0,52), messages: [] }
    optimistic.messages = [...(optimistic.messages || []), { role:'user', content:text }]
    activeChat = optimistic; renderMessages()
    try {
      const data = await api('/api/assistant', { method: 'POST', body: { chatId: activeChat.id, message: text } })
      activeChat = data.chat; await loadChats(); renderMessages()
    } catch (error) {
      if (error.data?.chat) activeChat = error.data.chat
      renderMessages(); alert(error.message)
    } finally { busy = false; $('chatSend').disabled = false; $('chatInput').focus() }
  }

  function switchView(view) {
    currentView = view
    $('chatView').classList.toggle('hidden', view !== 'chat')
    $('supervisorView').classList.toggle('hidden', view !== 'supervisor')
    document.querySelectorAll('[data-view]').forEach(el => el.classList.toggle('active', el.dataset.view === view))
    $('workspaceTitle').textContent = view === 'chat' ? 'Vercel AI Assistant' : 'ChatGPT Supervisor'
    $('workspaceSubtitle').textContent = view === 'chat' ? 'Saved to your account' : 'Persistent extension-backed jobs'
  }

  function formatAgo(ts) {
    if (!ts) return '—'; const seconds = Math.max(0, Math.floor((Date.now()-ts)/1000))
    if (seconds < 60) return `${seconds}s ago`; if (seconds < 3600) return `${Math.floor(seconds/60)}m ago`; return `${Math.floor(seconds/3600)}h ago`
  }
  function prettyStatus(s) { return String(s || '').replaceAll('_',' ').replace(/\b\w/g,c=>c.toUpperCase()) }
  function statusClass(s) { if(s==='complete') return 'good'; if(s==='paused_limit'||s==='needs_attention') return 'warn'; if(s==='stopped') return 'muted'; return 'active' }
  function showSupervisorError(message='') { $('errorNotice').textContent = message; $('errorNotice').classList.toggle('hidden', !message) }

  function renderBridge() {
    const connected = Boolean(bridgeState.connected)
    $('connection').textContent = connected ? `Extension connected${bridgeState.version ? ` · v${bridgeState.version}` : ''}` : 'Extension offline'
    $('connection').className = `status-chip ${connected ? 'good' : 'muted'}`
    $('pairBadge').textContent = localStorage.getItem('project-supervisor-pair') ? (connected ? 'Paired' : 'Pair saved') : 'Not paired'
    $('pairBadge').className = `status-chip ${connected ? 'good' : 'muted'}`
    $('startButton').disabled = busy || !connected
    const jobs = [...(bridgeState.jobs || [])].sort((a,b)=>b.updatedAt-a.updatedAt)
    $('jobs').innerHTML = jobs.length ? jobs.map(job => `<article class="job-card" data-job="${esc(job.id)}"><div class="job-head"><div><h3>${esc(job.title)}</h3><span class="status-chip ${statusClass(job.status)}">${esc(prettyStatus(job.status))}</span></div><small>${esc(formatAgo(job.lastProgressAt||job.updatedAt))}</small></div><div class="job-meta"><span>Model <b>${esc(job.modelLabel||'not verified yet')}</b></span><span>Events <b>${esc(job.eventCount??0)}</b></span></div>${job.progressLabel?`<p>${esc(job.progressLabel)}</p>`:''}${job.warning?`<div class="job-warning">${esc(job.warning)}</div>`:''}<div class="job-actions"><button data-action="open">Open ChatGPT</button>${['running','recovering'].includes(job.status)?'<button data-action="pause">Pause</button>':''}${['paused_limit','needs_attention','stopped'].includes(job.status)?'<button data-action="resume">Resume</button>':''}${!['complete','stopped'].includes(job.status)?'<button data-action="stop" class="danger-link">Stop</button>':''}</div></article>`).join('') : '<div class="jobs-empty">No supervised jobs yet.</div>'
    document.querySelectorAll('[data-job] [data-action]').forEach(btn => btn.addEventListener('click', ()=>jobAction(btn.dataset.action, btn.closest('[data-job]').dataset.job)))
  }

  async function refreshBridge(silent=false) {
    if (!currentUser) return
    try { const result = await bridgeRequest('PING'); bridgeState = { ...result, connected:true }; if(!silent) showSupervisorError('') }
    catch (error) { bridgeState.connected=false; if(!silent) showSupervisorError(error.message) }
    renderBridge()
  }

  async function mirrorJob(job) {
    if (!currentUser || !job) return
    await api('/api/supervisor-jobs', { method:'POST', body:{ id:job.id, title:job.title, projectUrl:job.projectUrl||'', status:job.status, progressLabel:job.progressLabel, modelLabel:job.modelLabel } }).catch(()=>{})
  }

  async function startJob() {
    const title=$('title').value.trim(), projectUrl=$('projectUrl').value.trim(), prompt=$('prompt').value.trim()
    showSupervisorError('')
    if(!title||!projectUrl||!prompt) return showSupervisorError('Give the job a title, the complete task, and the exact ChatGPT Project/chat URL.')
    if(!/^https:\/\/chatgpt\.com\//i.test(projectUrl)) return showSupervisorError('The worker URL must be a chatgpt.com Project or conversation URL.')
    busy=true; renderBridge()
    try {
      const result=await bridgeRequest('CREATE_JOB',{title,projectUrl,prompt,settings:{stallMinutes:Number($('stallMinutes').value),strictModelGuard:$('strictModelGuard').checked,autoContinue:$('autoContinue').checked}},12000)
      bridgeState={...result,connected:true}; $('title').value=''; $('prompt').value=''
      const newest=[...(bridgeState.jobs||[])].sort((a,b)=>b.createdAt-a.createdAt)[0]; await mirrorJob(newest)
    } catch(error) { showSupervisorError(error.message) } finally { busy=false; renderBridge() }
  }
  async function jobAction(action,jobId) {
    busy=true; renderBridge(); showSupervisorError('')
    const map={open:'OPEN_JOB',pause:'PAUSE_JOB',resume:'RESUME_JOB',stop:'STOP_JOB'}
    try { const result=await bridgeRequest(map[action],{jobId},10000); bridgeState={...result,connected:true}; await mirrorJob((bridgeState.jobs||[]).find(j=>j.id===jobId)) }
    catch(error){ showSupervisorError(error.message) } finally { busy=false; renderBridge() }
  }

  document.querySelectorAll('[data-auth]').forEach(btn=>btn.addEventListener('click',()=>openAuth(btn.dataset.auth)))
  document.querySelector('[data-close]').addEventListener('click',()=>showModal('authModal',false))
  $('authSwitch').addEventListener('click',()=>setAuthMode(authMode==='login'?'signup':'login'))
  $('authForm').addEventListener('submit',handleAuth)
  $('accountBtn').addEventListener('click',()=>showModal('accountModal',true))
  document.querySelector('[data-close-account]').addEventListener('click',()=>showModal('accountModal',false))
  $('logoutBtn').addEventListener('click',logout)
  $('showSetupBtn').addEventListener('click',()=>showModal('setupModal',true))
  document.querySelector('[data-close-setup]').addEventListener('click',()=>showModal('setupModal',false))
  document.querySelectorAll('[data-view]').forEach(btn=>btn.addEventListener('click',()=>switchView(btn.dataset.view)))
  $('newChatBtn').addEventListener('click',newChat)
  $('chatForm').addEventListener('submit',sendAssistant)
  document.querySelectorAll('[data-suggest]').forEach(btn=>btn.addEventListener('click',()=>{ $('chatInput').value=btn.dataset.suggest; $('chatInput').focus() }))
  $('startButton').addEventListener('click',startJob)
  $('refreshButton').addEventListener('click',()=>refreshBridge(false))
  $('chatInput').addEventListener('input', e => { e.target.style.height='auto'; e.target.style.height=`${Math.min(e.target.scrollHeight,180)}px` })

  initSession()
  setInterval(()=>{ if(currentUser) refreshBridge(true) },5000)
  setInterval(()=>{ if(currentUser) renderBridge() },15000)
})()
