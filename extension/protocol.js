export const VERSION = '0.1.0'
export const ALARM_NAME = 'project-supervisor-watchdog'
export const STORAGE_KEY = 'projectSupervisorStateV1'

export function makeId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`
}

export function clampStallMinutes(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 10
  return Math.max(5, Math.min(30, Math.round(n)))
}

export function buildInitialPrompt(job) {
  return `${job.prompt.trim()}\n\n---\nSUPERVISOR EXECUTION PROTOCOL (prototype):\n- Preserve all progress. Do not restart completed work unless verification proves it is necessary.\n- Continue autonomously through ordinary implementation, testing, review, deployment, and verification steps required by the request.\n- Do not ask the user to repeat information already present in this chat/project.\n- Do not bypass, evade, rotate around, or otherwise defeat ChatGPT usage limits. If a product limit prevents continuation, stop normally; the supervisor will record the pause.\n- Never claim completion from intention alone. Check the original request and verify every required deliverable that is observable with your available tools.\n- At the END of every assistant turn, append exactly one machine-readable status line in this form:\n<agent-status>{\"state\":\"continue|complete|needs_user\",\"summary\":\"brief factual progress summary\",\"next\":\"next concrete action or empty\"}</agent-status>\n- Use state=complete only when the ORIGINAL task is actually complete, including requested tests/deployment/verification.\n- Use state=continue if useful work remains and you can continue without the user.\n- Use state=needs_user only for a genuine decision or missing secret/input that cannot be recovered from the project or connected tools.`
}

export function buildContinuationPrompt(job, reason = 'continue') {
  const previous = job.lastAssistantText ? job.lastAssistantText.slice(-5000) : '(no assistant checkpoint captured)'
  const reasons = {
    continue: 'The previous turn indicates that the original task is not complete.',
    stall: 'The watchdog detected the configured no-progress interval while the same generation remained active. That generation was stopped once so work could recover from the saved checkpoint.',
    loop: 'The watchdog detected a substantially repeated terminal result.',
    resume: 'The user explicitly resumed this saved job.',
  }
  return `SUPERVISOR CONTINUATION\n\n${reasons[reason] || reasons.continue}\n\nDo NOT restart the task and do NOT discard existing work. Inspect the current project/chat state first, preserve every valid completed step, then continue from the first unfinished requirement. If the previous approach stalled or repeated, change approach instead of repeating it.\n\nSaved checkpoint excerpt:\n${previous}\n\nOriginal objective:\n${job.prompt}\n\nContinue now. End this turn with the required <agent-status> line.`
}

export function parseAgentStatus(text) {
  if (!text) return null
  const matches = [...text.matchAll(/<agent-status>(\{[\s\S]*?\})<\/agent-status>/gi)]
  if (!matches.length) return null
  try {
    const obj = JSON.parse(matches[matches.length - 1][1])
    if (!['continue', 'complete', 'needs_user'].includes(obj.state)) return null
    return {
      state: obj.state,
      summary: String(obj.summary || ''),
      next: String(obj.next || ''),
    }
  } catch {
    return null
  }
}

export function normalizeFingerprint(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/<agent-status>[\s\S]*?<\/agent-status>/gi, '')
    .replace(/\d+/g, '#')
    .replace(/[^a-z# ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(-3000)
}
