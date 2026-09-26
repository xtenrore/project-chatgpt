const origin = document.getElementById('origin')
const key = document.getElementById('key')
const status = document.getElementById('status')

function msg(type, extra = {}) {
  return new Promise(resolve => chrome.runtime.sendMessage({ type, ...extra }, resolve))
}
function setStatus(text, ok = true) { status.textContent = text; status.className = `status ${ok ? 'good' : 'bad'}` }
async function refresh() {
  const res = await msg('POPUP_GET_STATE')
  if (!res?.ok) return setStatus(res?.error || 'Could not load state.', false)
  origin.value = res.data.allowedOrigin || ''
  key.textContent = res.data.pairKey || ''
}

document.getElementById('save').onclick = async () => {
  const value = origin.value.trim().replace(/\/$/, '')
  if (value && !/^https?:\/\//.test(value)) return setStatus('Use a full http(s) origin.', false)
  const res = await msg('POPUP_SAVE_CONFIG', { allowedOrigin: value })
  if (!res?.ok) return setStatus(res?.error || 'Save failed.', false)
  key.textContent = res.data.pairKey
  setStatus('Configuration saved.')
}
document.getElementById('copy').onclick = async () => { await navigator.clipboard.writeText(key.textContent); setStatus('Pairing key copied.') }
document.getElementById('regen').onclick = async () => { const res = await msg('POPUP_REGENERATE_KEY'); if(res?.ok){key.textContent=res.data.pairKey;setStatus('New pairing key generated.')}else setStatus(res?.error||'Failed.',false) }
document.getElementById('open').onclick = async () => { const res = await msg('POPUP_OPEN_SUPERVISOR'); if(!res?.ok) setStatus(res?.error||'Could not open site.',false) }
refresh()
