(() => {
  'use strict'

  const CHANNEL = 'PROJECT_SUPERVISOR_V1'
  let requestCounter = 0
  let state = { connected: false, jobs: [] }
  let busy = false

  const $ = id => document.getElementById(id)
  const esc = value => String(value ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]))

  function consumePairingFragment() {
    const params = new URLSearchParams(location.hash.replace(/^#/, ''))
    const pair = params.get('pair')
    if (!pair) return false
    localStorage.setItem('project-supervisor-pair', pair)
    history.replaceState(null, '', location.pathname + location.search)
    return true
  }

  function request(type, payload = {}, timeoutMs = 5000) {
    const pairKey = localStorage.getItem('project-supervisor-pair') || ''
    const requestId = `${Date.now()}-${++requestCounter}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { window.removeEventListener('message', onMessage); reject(new Error('Extension bridge did not respond.')) }, timeoutMs)
      function onMessage(event) {
        if (event.source !== window) return
        const msg = event.data
        if (!msg || msg.channel !== CHANNEL || msg.direction !== 'from-extension' || msg.requestId !== requestId) return
        clearTimeout(timer)
        window.removeEventListener('message', onMessage)
        if (msg.reply?.ok) resolve(msg.reply.data)
        else reject(new Error(msg.reply?.error || 'Extension request failed.'))
      }
      window.addEventListener('message', onMessage)
      window.postMessage({ channel: CHANNEL, direction: 'to-extension', requestId, pairKey, type, payload }, location.origin)
    })
  }

  function formatAgo(ts) {
    if (!ts) return '—'
    const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000))
    if (seconds < 60) return `${seconds}s ago`
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
    return `${Math.floor(seconds / 3600)}h ago`
  }
  function prettyStatus(s) { return String(s || '').replaceAll('_', ' ').replace(/\b\w/g, c => c.toUpperCase()) }
  function statusClass(s) { if (s === 'complete') return 'good'; if (s === 'paused_limit' || s === 'needs_attention') return 'warn'; if (s === 'stopped') return 'muted'; return 'active' }
  function showError(message = '') { $('errorText').textContent = message; $('errorNotice').classList.toggle('hidden', !message) }

  function render() {
    const connected = Boolean(state.connected)
    $('connection').className = `connection ${connected ? 'online' : 'offline'}`
    $('connection').textContent = connected ? `● Extension connected${state.version ? ` · v${state.version}` : ''}` : '● Extension offline'
    $('startButton').disabled = busy || !connected
    $('pairNotice').classList.toggle('hidden', Boolean(localStorage.getItem('project-supervisor-pair')))

    const jobs = [...(state.jobs || [])].sort((a,b) => b.updatedAt - a.updatedAt)
    if (!jobs.length) {
      $('jobs').innerHTML = '<div class="empty-state"><div class="empty-icon">PS</div><b>No supervised jobs yet</b><span>Once paired, jobs persist in the extension even if this page or your phone is closed.</span></div>'
      return
    }
    $('jobs').innerHTML = jobs.map(job => `
      <article class="job-card" data-job="${esc(job.id)}">
        <div class="job-top"><div><h3>${esc(job.title)}</h3><span class="pill ${statusClass(job.status)}">${esc(prettyStatus(job.status))}</span></div><span>${job.status === 'complete' ? '✓' : '◎'}</span></div>
        <div class="job-meta"><span>Last progress<b>${esc(formatAgo(job.lastProgressAt || job.updatedAt))}</b></span><span>Events<b>${esc(job.eventCount ?? 0)}</b></span><span>Model<b>${esc(job.modelLabel || 'not verified yet')}</b></span></div>
        ${job.progressLabel ? `<p class="progress-copy">${esc(job.progressLabel)}</p>` : ''}
        ${job.warning ? `<div class="inline-warning">! ${esc(job.warning)}</div>` : ''}
        <div class="job-actions">
          <button data-action="open">↗ Open ChatGPT</button>
          ${['running','recovering'].includes(job.status) ? '<button data-action="pause">Ⅱ Pause</button>' : ''}
          ${['paused_limit','needs_attention','stopped'].includes(job.status) ? '<button data-action="resume">▶ Resume</button>' : ''}
          ${!['complete','stopped'].includes(job.status) ? '<button data-action="stop" class="danger">■ Stop</button>' : ''}
        </div>
      </article>`).join('')

    document.querySelectorAll('[data-job] button[data-action]').forEach(button => {
      button.addEventListener('click', async event => {
        const card = event.currentTarget.closest('[data-job]')
        await jobAction(event.currentTarget.dataset.action, card.dataset.job)
      })
    })
  }

  async function refresh(silent = false) {
    try {
      const result = await request('PING')
      state = { ...result, connected: true }
      if (!silent) showError('')
    } catch (error) {
      state.connected = false
      if (!silent) showError(error.message || String(error))
    }
    render()
  }

  async function startJob() {
    const title = $('title').value.trim(), projectUrl = $('projectUrl').value.trim(), prompt = $('prompt').value.trim()
    showError('')
    if (!title || !projectUrl || !prompt) return showError('Give the job a title, the full task, and the exact ChatGPT Project/chat URL.')
    if (!/^https:\/\/chatgpt\.com\//i.test(projectUrl)) return showError('The worker URL must be a chatgpt.com Project or conversation URL.')
    busy = true; render()
    try {
      const result = await request('CREATE_JOB', {
        title, projectUrl, prompt,
        settings: { stallMinutes: Number($('stallMinutes').value), strictModelGuard: $('strictModelGuard').checked, autoContinue: $('autoContinue').checked }
      }, 12000)
      state = { ...result, connected: true }
      $('title').value = ''; $('prompt').value = ''
    } catch (error) { showError(error.message || String(error)) }
    finally { busy = false; render() }
  }

  async function jobAction(action, jobId) {
    busy = true; render(); showError('')
    const map = { open: 'OPEN_JOB', pause: 'PAUSE_JOB', resume: 'RESUME_JOB', stop: 'STOP_JOB' }
    try { const result = await request(map[action], { jobId }, 10000); state = { ...result, connected: true } }
    catch (error) { showError(error.message || String(error)) }
    finally { busy = false; render() }
  }

  consumePairingFragment()
  $('startButton').addEventListener('click', startJob)
  $('refreshButton').addEventListener('click', () => refresh(false))
  refresh(true)
  setInterval(() => refresh(true), 4000)
  setInterval(render, 15000)
})()
