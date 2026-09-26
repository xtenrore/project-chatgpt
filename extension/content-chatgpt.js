const LIMIT_PATTERNS = [
  /you(?:'|’)ve reached (?:the|your) [^\n]{0,100}limit/i,
  /usage limit(?: reached| exceeded)?/i,
  /message limit(?: reached| exceeded)?/i,
  /limit resets? (?:at|in|on)/i,
  /you can (?:use|continue with) [^\n]{0,80} again (?:at|in|after)/i,
  /temporarily unavailable due to [^\n]{0,80}limit/i,
]

let activeJobId = null
let lastAssistantText = ''
let lastChangedAt = Date.now()
let heartbeat = null

function isVisible(el) {
  if (!el || el.closest('[data-message-author-role]')) return false
  const style = getComputedStyle(el)
  if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false
  const r = el.getBoundingClientRect()
  return r.width > 0 && r.height > 0
}

function limitSurfaceTexts() {
  const selectors = [
    '[role="alert"]', '[role="dialog"]', '[role="status"]',
    '[aria-live="assertive"]', '[aria-live="polite"]',
    '[data-testid*="toast" i]', '[data-testid*="limit" i]', '[data-testid*="error" i]',
  ]
  const nodes = new Set()
  for (const selector of selectors) for (const el of document.querySelectorAll(selector)) nodes.add(el)
  for (const el of document.querySelectorAll('button[aria-label], button[data-testid], [aria-label*="limit" i]')) nodes.add(el)
  return [...nodes]
    .filter(isVisible)
    .map(el => `${el.innerText || ''} ${el.getAttribute('aria-label') || ''}`.trim())
    .filter(text => text && text.length < 1200)
}
function limitDetected() { return limitSurfaceTexts().some(text => LIMIT_PATTERNS.some(r => r.test(text))) }

function getAssistantNodes() {
  const direct = [...document.querySelectorAll('[data-message-author-role="assistant"]')]
  if (direct.length) return direct
  return [...document.querySelectorAll('article')].filter(el => /chatgpt|assistant/i.test(el.getAttribute('aria-label') || '') || el.querySelector('[data-message-author-role="assistant"]'))
}
function getLastAssistantText() {
  const nodes = getAssistantNodes()
  return (nodes[nodes.length - 1]?.innerText || '').trim()
}

function findStopButton() {
  return [...document.querySelectorAll('button')].find(btn => {
    const s = `${btn.getAttribute('data-testid') || ''} ${btn.getAttribute('aria-label') || ''} ${btn.innerText || ''}`
    return /stop-button|stop generating|stop response|^stop$/i.test(s.trim())
  })
}
function isGenerating() { return Boolean(findStopButton()) }

function findComposer() {
  return document.querySelector('#prompt-textarea')
    || document.querySelector('[data-testid="composer-input"]')
    || document.querySelector('textarea[placeholder*="Message" i]')
    || document.querySelector('div[contenteditable="true"][data-virtualkeyboard]')
    || [...document.querySelectorAll('div[contenteditable="true"]')].find(el => el.closest('form'))
    || document.querySelector('div[contenteditable="true"]')
}
function findSendButton() {
  return [...document.querySelectorAll('button')].find(btn => {
    const s = `${btn.getAttribute('data-testid') || ''} ${btn.getAttribute('aria-label') || ''}`
    return /send-button|send prompt|send message|^send$/i.test(s.trim())
  })
}

function setComposerText(el, text) {
  el.focus()
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set
    if (setter) setter.call(el, text); else el.value = text
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return
  }
  try {
    const selection = window.getSelection()
    const range = document.createRange()
    range.selectNodeContents(el)
    selection.removeAllRanges()
    selection.addRange(range)
    document.execCommand('insertText', false, text)
  } catch {}
  if (!(el.innerText || '').trim()) {
    el.textContent = text
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }))
  }
}

async function waitFor(predicate, timeoutMs = 9000, stepMs = 120) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const value = predicate()
    if (value) return value
    await new Promise(r => setTimeout(r, stepMs))
  }
  return null
}

function normalizeOption(label) {
  return String(label || '').toLowerCase().replace(/\s+/g, ' ').trim()
}

function rankModelLabel(label) {
  const s = normalizeOption(label)
  if (!s || /upgrade|subscribe|learn more|get pro|try pro/.test(s)) return 0
  if (/gpt[- ]?6\s*pro/.test(s)) return 170
  if (/gpt[- ]?5\.6\s*(?:sol\s*)?pro/.test(s)) return 165
  if (/gpt[- ]?5\.6\s*sol/.test(s)) return 155
  if (/gpt[- ]?5\.6\s*luna/.test(s)) return 145
  if (/gpt[- ]?5\.6/.test(s)) return 140
  if (/gpt[- ]?5\.5/.test(s)) return 120
  if (/gpt[- ]?5\b/.test(s)) return 110
  return 0
}

function rankReasoningLabel(label) {
  const s = normalizeOption(label)
  if (!s || /upgrade|subscribe|learn more|get pro|try pro/.test(s)) return 0
  if (/extra\s*high|xhigh|very\s*high/.test(s)) return 50
  if (/\bhigh\b/.test(s)) return 40
  if (/\bmedium\b/.test(s)) return 30
  if (/\bthinking\b|\bthink\b/.test(s)) return 25
  if (/\binstant\b/.test(s)) return 10
  return 0
}

function currentModelLabel() {
  const selectors = [
    '[data-testid="model-switcher-dropdown-button"]',
    'button[aria-label*="model" i]',
    'button[aria-label*="thinking" i]',
    'button[aria-label*="reasoning" i]',
    'button[id*="model" i]',
  ]
  const labels = []
  for (const sel of selectors) {
    for (const el of document.querySelectorAll(sel)) {
      const text = (el.innerText || el.getAttribute('aria-label') || '').trim()
      if (text) labels.push(text)
    }
  }
  const best = labels.map(label => ({ label, score: rankModelLabel(label) })).sort((a,b) => b.score - a.score)[0]
  return best?.score ? best.label : (labels[0] || '')
}

function findModelControl() {
  return document.querySelector('[data-testid="model-switcher-dropdown-button"]')
    || document.querySelector('button[aria-label*="model" i]')
    || document.querySelector('button[id*="model" i]')
    || [...document.querySelectorAll('header button, main button')].find(b => rankModelLabel(b.innerText || b.getAttribute('aria-label') || '') > 0)
    || null
}

function findReasoningControl() {
  return document.querySelector('button[aria-label*="thinking" i]')
    || document.querySelector('button[aria-label*="reasoning" i]')
    || document.querySelector('button[aria-label*="effort" i]')
    || [...document.querySelectorAll('header button, main button')].find(b => rankReasoningLabel(b.innerText || b.getAttribute('aria-label') || '') > 0)
    || null
}

function isEnabledChoice(el) {
  if (!isVisible(el)) return false
  if (el.disabled || el.getAttribute('aria-disabled') === 'true' || el.hasAttribute('disabled') || el.hasAttribute('data-disabled')) return false
  const text = normalizeOption(el.innerText || el.getAttribute('aria-label') || '')
  return !/upgrade|subscribe|learn more|get pro|try pro/.test(text)
}

function activePopupChoices() {
  const containers = [...document.querySelectorAll('[role="menu"], [role="listbox"], [data-radix-menu-content], [data-radix-popper-content-wrapper], [role="dialog"]')].filter(isVisible)
  const roots = containers.length ? containers : [document]
  const seen = new Set()
  const out = []
  for (const root of roots) {
    for (const el of root.querySelectorAll('[role="menuitem"], [role="option"], [role="radio"], button')) {
      if (!seen.has(el) && isEnabledChoice(el)) { seen.add(el); out.push(el) }
    }
  }
  return out
}

async function chooseHighestVisibleFromOpenControl(rankFn) {
  await new Promise(r => setTimeout(r, 350))
  const candidates = activePopupChoices()
    .map(el => ({ el, label: (el.innerText || el.getAttribute('aria-label') || '').trim() }))
    .map(x => ({ ...x, score: rankFn(x.label) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
  if (!candidates.length) return null
  const best = candidates[0]
  best.el.click()
  await new Promise(r => setTimeout(r, 450))
  return best
}

async function ensureHighestVisibleModel(strict) {
  if (isGenerating()) throw new Error('A ChatGPT generation is already active in this tab. Stop it or use a different Project conversation before resuming the supervised job.')
  let model = currentModelLabel()
  const modelControl = findModelControl()
  if (!modelControl) {
    if (strict) throw new Error('Strict model guard could not locate the ChatGPT model control. Select the highest available Chat model manually, then Resume.')
  } else {
    modelControl.click()
    const bestModel = await chooseHighestVisibleFromOpenControl(rankModelLabel)
    if (!bestModel) {
      document.body.click()
      if (strict && rankModelLabel(model) === 0) throw new Error('Strict model guard could not identify enabled model choices. Select the highest available Chat model manually, then Resume.')
    } else {
      model = currentModelLabel() || bestModel.label
      if (strict && rankModelLabel(model) && rankModelLabel(model) < bestModel.score) throw new Error(`Strict model guard found a stronger enabled model (${bestModel.label}) but could not confirm selection.`)
    }
  }

  let reasoning = ''
  const reasoningControl = findReasoningControl()
  if (reasoningControl && reasoningControl !== modelControl) {
    reasoningControl.click()
    const bestReasoning = await chooseHighestVisibleFromOpenControl(rankReasoningLabel)
    if (bestReasoning) reasoning = bestReasoning.label
    else document.body.click()
  }
  return [model || 'unverified', reasoning].filter(Boolean).join(' · ')
}

async function sendPrompt(text, strictModelGuard) {
  if (limitDetected()) throw new Error('ChatGPT currently shows a usage limit. The supervisor will not retry around or bypass that limit.')
  lastAssistantText = getLastAssistantText()
  if (isGenerating()) throw new Error('A ChatGPT generation is already active in this tab.')
  const modelLabel = await ensureHighestVisibleModel(strictModelGuard)
  const composer = await waitFor(findComposer)
  if (!composer) throw new Error('Could not find the ChatGPT message composer. The ChatGPT UI may have changed.')
  setComposerText(composer, text)
  await new Promise(r => setTimeout(r, 180))
  const send = findSendButton()
  if (send && !send.disabled) send.click()
  else {
    composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }))
    composer.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }))
  }
  lastChangedAt = Date.now()
  return modelLabel
}

function sendTelemetry(forceChanged = false) {
  if (!activeJobId) return
  const assistantText = getLastAssistantText()
  const changed = forceChanged || assistantText !== lastAssistantText
  if (changed) {
    lastAssistantText = assistantText
    lastChangedAt = Date.now()
  }
  chrome.runtime.sendMessage({
    type: 'SUPERVISOR_TELEMETRY',
    jobId: activeJobId,
    assistantText,
    changed,
    generating: isGenerating(),
    limitDetected: limitDetected(),
    modelLabel: currentModelLabel(),
    lastChangedAt,
  }).catch(() => {})
}

const observer = new MutationObserver(() => {
  if (!activeJobId) return
  const next = getLastAssistantText()
  if (next !== lastAssistantText || limitDetected()) sendTelemetry(next !== lastAssistantText)
})
observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true })

heartbeat = setInterval(() => sendTelemetry(false), 15000)
window.addEventListener('beforeunload', () => heartbeat && clearInterval(heartbeat))

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  ;(async () => {
    try {
      if (message.type === 'SUPERVISOR_SEND_PROMPT') {
        activeJobId = message.jobId
        lastAssistantText = getLastAssistantText()
        const modelLabel = await sendPrompt(String(message.text || ''), Boolean(message.strictModelGuard))
        sendResponse({ ok: true, modelLabel })
        return
      }
      if (message.type === 'SUPERVISOR_STOP_GENERATION') {
        activeJobId = message.jobId || activeJobId
        const stop = findStopButton()
        if (stop) stop.click()
        sendResponse({ ok: true, stopped: Boolean(stop), assistantText: getLastAssistantText() })
        return
      }
      if (message.type === 'SUPERVISOR_PROBE') {
        activeJobId = message.jobId || activeJobId
        sendResponse({
          ok: true,
          assistantText: getLastAssistantText(),
          generating: isGenerating(),
          limitDetected: limitDetected(),
          modelLabel: currentModelLabel(),
          lastChangedAt,
        })
        return
      }
    } catch (error) {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  })()
  return true
})
