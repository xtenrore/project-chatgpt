const CHANNEL = 'PROJECT_SUPERVISOR_V1'

window.addEventListener('message', event => {
  if (event.source !== window) return
  const msg = event.data
  if (!msg || msg.channel !== CHANNEL || msg.direction !== 'to-extension') return
  chrome.runtime.sendMessage({
    type: 'WEB_BRIDGE_REQUEST',
    pairKey: msg.pairKey,
    requestType: msg.type,
    payload: msg.payload || {},
  }, reply => {
    window.postMessage({
      channel: CHANNEL,
      direction: 'from-extension',
      requestId: msg.requestId,
      reply: reply || { ok: false, error: chrome.runtime.lastError?.message || 'Extension did not respond.' },
    }, window.location.origin)
  })
})
