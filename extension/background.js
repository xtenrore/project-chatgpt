import {
  ALARM_NAME,
  STORAGE_KEY,
  VERSION,
  buildContinuationPrompt,
  buildInitialPrompt,
  clampStallMinutes,
  makeId,
  normalizeFingerprint,
  parseAgentStatus,
} from './protocol.js'

const defaultState = { version: VERSION, pairKey: '', allowedOrigin: '', jobs: [] }

async function loadState() {
  const stored = await chrome.storage.local.get(STORAGE_KEY)
  const state = stored[STORAGE_KEY] || {}
  return { ...defaultState, ...state, jobs: Array.isArray(state.jobs) ? state.jobs : [] }
}
async function saveState(state) {
  state.version = VERSION
  await chrome.storage.local.set({ [STORAGE_KEY]: state })
  return state
}
function publicState(state) {
  return {
    connected: true,
    version: VERSION,
    pairAccepted: true,
    jobs: state.jobs.map(({ tabId, settings, fingerprints, lastTerminalFingerprint, ...job }) => job),
  }
}
async function updateJob(jobId, mutate) {
  const state = await loadState()
  const index = state.jobs.findIndex(j => j.id === jobId)
  if (index < 0) return { state, job: null }
  const next = { ...state.jobs[index] }
  await mutate(next, state)
  next.updatedAt = Date.now()
  state.jobs[index] = next
  await saveState(state)
  return { state, job: next }
}
async function notify(title, message) {
  try {
    await chrome.notifications.create({ type: 'basic', iconUrl: 'icon128.png', title, message: String(message || '').slice(0, 220), priority: 1 })
  } catch {}
}
async function safeSend(tabId, message) {
  if (!tabId) return null
  try { return await chrome.tabs.sendMessage(tabId, message) } catch { return null }
}
async function ensureWorkerTab(job) {
  if (job.tabId) {
    try {
      const tab = await chrome.tabs.get(job.tabId)
      if (tab?.url?.startsWith('https://chatgpt.com/')) return tab
    } catch {}
  }
  const tab = await chrome.tabs.create({ url: job.projectUrl, active: false })
  job.tabId = tab.id
  return tab
}
async function waitForBridge(tabId, jobId, timeoutMs = 12000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const probe = await safeSend(tabId, { type: 'SUPERVISOR_PROBE', jobId })
    if (probe?.ok) return probe
    await new Promise(r => setTimeout(r, 300))
  }
  return null
}
async function dispatchPrompt(job, text, reason = 'initial') {
  const tab = await ensureWorkerTab(job)
  if (!tab?.id) throw new Error('Could not open the ChatGPT worker tab.')
  const bridge = await waitForBridge(tab.id, job.id)
  if (!bridge) throw new Error('The ChatGPT tab opened, but the extension bridge did not become ready. Reload ChatGPT and Resume.')
  if (bridge.limitDetected) throw new Error('ChatGPT currently shows a usage limit. The supervisor will not retry around it.')
  if (bridge.generating) throw new Error('The target ChatGPT conversation is already generating. Stop that turn or use a different conversation before resuming.')

  const response = await safeSend(tab.id, {
    type: 'SUPERVISOR_SEND_PROMPT',
    jobId: job.id,
    text,
    strictModelGuard: Boolean(job.settings?.strictModelGuard),
  })
  if (!response?.ok) throw new Error(response?.error || 'ChatGPT page bridge was not ready.')
  job.status = 'running'
  job.lastProgressAt = Date.now()
  job.progressLabel = reason === 'initial' ? 'Task sent to ChatGPT.' : `Continuation sent (${reason}).`
  job.warning = ''
  job.pendingReason = ''
  if (response.modelLabel) job.modelLabel = response.modelLabel
}
async function runJob(jobId, reason = 'initial') {
  const result = await updateJob(jobId, async job => {
    job.status = reason === 'resume' ? 'opening_chatgpt' : (job.status || 'queued')
    job.pendingReason = ''
    try {
      const text = reason === 'initial' ? buildInitialPrompt(job) : buildContinuationPrompt(job, reason)
      await dispatchPrompt(job, text, reason)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/usage limit/i.test(message)) {
        job.status = 'paused_limit'
        job.warning = message
        job.progressLabel = 'Paused at ChatGPT usage limit.'
      } else {
        job.status = 'needs_attention'
        job.warning = message
        job.progressLabel = 'Supervisor could not safely continue.'
      }
    }
  })
  return publicState(result.state)
}
async function createJob(payload) {
  const state = await loadState()
  const now = Date.now()
  const job = {
    id: makeId(), title: String(payload.title || '').trim(), prompt: String(payload.prompt || '').trim(), projectUrl: String(payload.projectUrl || '').trim(),
    status: 'queued', createdAt: now, updatedAt: now, lastProgressAt: now, progressLabel: 'Queued.', eventCount: 0,
    warning: '', fingerprints: [], lastTerminalFingerprint: '', pendingReason: '',
    settings: {
      stallMinutes: clampStallMinutes(payload.settings?.stallMinutes),
      strictModelGuard: payload.settings?.strictModelGuard !== false,
      autoContinue: payload.settings?.autoContinue !== false,
    },
  }
  if (!job.title || !job.prompt || !/^https:\/\/chatgpt\.com\//i.test(job.projectUrl)) throw new Error('Invalid job payload.')
  state.jobs.push(job)
  await saveState(state)
  void runJob(job.id, 'initial')
  return publicState(state)
}

async function handleTelemetry(message, sender) {
  const jobId = message.jobId
  if (!jobId) return
  let nextReason = ''
  const { job } = await updateJob(jobId, async job => {
    if (sender.tab?.id) job.tabId = sender.tab.id
    job.eventCount = (job.eventCount || 0) + 1
    if (message.modelLabel) job.modelLabel = message.modelLabel

    if (message.limitDetected) {
      if (job.status !== 'paused_limit') {
        job.status = 'paused_limit'
        job.warning = 'ChatGPT reported a usage limit. The supervisor paused and will not retry around the limit.'
        job.progressLabel = 'Paused at ChatGPT usage limit.'
        job.pendingReason = ''
        await notify(`${job.title} paused`, 'ChatGPT reported a usage limit. Progress was preserved; no bypass attempt will be made.')
      }
      return
    }

    const assistantText = String(message.assistantText || '')
    if (message.changed) {
      job.lastProgressAt = Date.now()
      job.lastAssistantText = assistantText
      job.progressLabel = message.generating ? 'ChatGPT is working; new output detected.' : 'ChatGPT completed a turn.'
    }
    if (message.generating) {
      if (job.status !== 'recovering') job.status = 'running'
      return
    }
    if (!assistantText || job.status === 'paused_limit' || job.status === 'stopped') return

    job.lastAssistantText = assistantText
    const terminalFingerprint = normalizeFingerprint(assistantText)
    if (!terminalFingerprint || terminalFingerprint === job.lastTerminalFingerprint) return
    job.lastTerminalFingerprint = terminalFingerprint

    const parsed = parseAgentStatus(assistantText)
    if (parsed?.state === 'complete') {
      job.status = 'complete'
      job.progressLabel = parsed.summary || 'Worker reported the original task complete.'
      job.warning = ''
      job.pendingReason = ''
      await notify(`${job.title} complete`, parsed.summary || 'The supervised ChatGPT job reported completion.')
      return
    }
    if (parsed?.state === 'needs_user') {
      job.status = 'needs_attention'
      job.progressLabel = parsed.summary || 'ChatGPT needs user input.'
      job.warning = parsed.next || 'A genuine user decision or missing input is required.'
      job.pendingReason = ''
      await notify(`${job.title} needs you`, job.warning)
      return
    }

    const fp = terminalFingerprint
    if (fp) job.fingerprints = [...(job.fingerprints || []), fp].slice(-3)
    const recent = job.fingerprints || []
    const repeated = recent.length >= 2 && recent[recent.length - 1] === recent[recent.length - 2]
    if (repeated) {
      job.status = 'recovering'
      job.progressLabel = 'Repeated terminal result detected; supervisor will request a different approach.'
      job.pendingReason = 'loop'
      nextReason = 'loop'
      return
    }

    if (job.settings?.autoContinue && parsed?.state === 'continue') {
      job.status = 'running'
      job.progressLabel = parsed.summary || 'Worker reported more work remains.'
      job.pendingReason = 'continue'
      nextReason = 'continue'
    } else if (!parsed) {
      job.status = 'needs_attention'
      job.warning = 'The worker ended without a valid <agent-status> footer. Review the chat or press Resume to continue safely.'
      job.progressLabel = 'Turn ended without structured completion state.'
      job.pendingReason = ''
    }
  })

  if (job && nextReason && job.status !== 'paused_limit') {
    await runJob(job.id, nextReason)
  }
}

async function watchdogTick() {
  const state = await loadState()
  const now = Date.now()
  const recoveries = []
  let changed = false

  for (const job of state.jobs) {
    if (!['running', 'recovering', 'opening_chatgpt'].includes(job.status)) continue
    const minutes = clampStallMinutes(job.settings?.stallMinutes)
    const noProgressMs = now - (job.lastProgressAt || job.updatedAt || now)
    if (noProgressMs < minutes * 60_000) continue

    if (job.tabId) {
      const probe = await safeSend(job.tabId, { type: 'SUPERVISOR_PROBE', jobId: job.id })
      if (probe?.limitDetected) {
        job.status = 'paused_limit'
        job.warning = 'ChatGPT reported a usage limit. The supervisor paused without retrying.'
        job.progressLabel = 'Paused at ChatGPT usage limit.'
        job.pendingReason = ''
        changed = true
        await notify(`${job.title} paused`, job.warning)
        continue
      }
      if (probe?.assistantText) job.lastAssistantText = String(probe.assistantText)
      if (probe?.generating) {
        job.status = 'recovering'
        job.progressLabel = `No observable progress for ${minutes} minutes; checkpoint preserved and the active generation will be stopped once.`
        job.lastProgressAt = now
        job.pendingReason = 'stall'
        changed = true
        recoveries.push({ jobId: job.id, tabId: job.tabId })
        continue
      }
    }

    job.status = 'needs_attention'
    job.warning = `No observable progress for ${minutes} minutes and the worker tab could not confirm an active generation.`
    job.progressLabel = 'Watchdog requires attention.'
    job.pendingReason = ''
    changed = true
    await notify(`${job.title} needs attention`, job.warning)
  }

  if (changed) await saveState(state)
  for (const recovery of recoveries) {
    const stopped = await safeSend(recovery.tabId, { type: 'SUPERVISOR_STOP_GENERATION', jobId: recovery.jobId })
    if (stopped?.assistantText) {
      await updateJob(recovery.jobId, async job => { job.lastAssistantText = String(stopped.assistantText) })
    }
    await runJob(recovery.jobId, 'stall')
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  const state = await loadState()
  if (!state.pairKey) state.pairKey = crypto.randomUUID().replaceAll('-', '')
  await saveState(state)
  await chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1 })
})
chrome.runtime.onStartup.addListener(async () => {
  await chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1 })
  const state = await loadState()
  for (const job of state.jobs) {
    if (['running', 'recovering', 'opening_chatgpt'].includes(job.status)) {
      job.status = 'needs_attention'
      job.warning = 'Browser restarted. Progress is preserved; press Resume to reattach to the ChatGPT Project safely.'
      job.progressLabel = 'Browser restart detected; waiting for safe manual resume.'
      job.pendingReason = ''
    }
  }
  await saveState(state)
})
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === ALARM_NAME) void watchdogTick() })

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  ;(async () => {
    try {
      if (message.type === 'SUPERVISOR_TELEMETRY') {
        await handleTelemetry(message, sender); sendResponse({ ok: true }); return
      }
      if (message.type === 'WEB_BRIDGE_REQUEST') {
        const state = await loadState()
        if (!state.pairKey || message.pairKey !== state.pairKey) throw new Error('Pairing key rejected.')
        if (state.allowedOrigin && sender.tab?.url) {
          const origin = new URL(sender.tab.url).origin
          if (origin !== state.allowedOrigin) throw new Error(`This extension is paired to ${state.allowedOrigin}, not ${origin}.`)
        }
        const payload = message.payload || {}
        if (message.requestType === 'PING' || message.requestType === 'LIST_JOBS') { sendResponse({ ok: true, data: publicState(state) }); return }
        if (message.requestType === 'CREATE_JOB') { const data = await createJob(payload); sendResponse({ ok: true, data }); return }
        if (message.requestType === 'PAUSE_JOB') {
          const result = await updateJob(payload.jobId, async job => {
            job.status = 'needs_attention'; job.progressLabel = 'Paused by user.'; job.warning = 'Paused manually.'; job.pendingReason = ''
            if (job.tabId) await safeSend(job.tabId, { type: 'SUPERVISOR_STOP_GENERATION', jobId: job.id })
          })
          sendResponse({ ok: true, data: publicState(result.state) }); return
        }
        if (message.requestType === 'RESUME_JOB') {
          await runJob(payload.jobId, 'resume')
          const latest = await loadState(); sendResponse({ ok: true, data: publicState(latest) }); return
        }
        if (message.requestType === 'STOP_JOB') {
          const result = await updateJob(payload.jobId, async job => {
            job.status = 'stopped'; job.progressLabel = 'Stopped by user.'; job.warning = ''; job.pendingReason = ''
            if (job.tabId) await safeSend(job.tabId, { type: 'SUPERVISOR_STOP_GENERATION', jobId: job.id })
          })
          sendResponse({ ok: true, data: publicState(result.state) }); return
        }
        if (message.requestType === 'OPEN_JOB') {
          const job = state.jobs.find(j => j.id === payload.jobId)
          if (!job) throw new Error('Job not found.')
          const tab = await ensureWorkerTab(job)
          if (tab?.id) await chrome.tabs.update(tab.id, { active: true })
          sendResponse({ ok: true, data: publicState(state) }); return
        }
        throw new Error('Unknown supervisor request.')
      }
      if (message.type === 'POPUP_GET_STATE') { const state = await loadState(); sendResponse({ ok: true, data: state }); return }
      if (message.type === 'POPUP_SAVE_CONFIG') {
        const state = await loadState()
        state.allowedOrigin = String(message.allowedOrigin || '').trim().replace(/\/$/, '')
        if (!state.pairKey) state.pairKey = crypto.randomUUID().replaceAll('-', '')
        await saveState(state); sendResponse({ ok: true, data: state }); return
      }
      if (message.type === 'POPUP_REGENERATE_KEY') {
        const state = await loadState(); state.pairKey = crypto.randomUUID().replaceAll('-', '')
        await saveState(state); sendResponse({ ok: true, data: state }); return
      }
      if (message.type === 'POPUP_OPEN_SUPERVISOR') {
        const state = await loadState()
        if (!state.allowedOrigin) throw new Error('Set the Supervisor website origin first.')
        await chrome.tabs.create({ url: `${state.allowedOrigin}/#pair=${encodeURIComponent(state.pairKey)}` })
        sendResponse({ ok: true }); return
      }
    } catch (error) {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  })()
  return true
})
