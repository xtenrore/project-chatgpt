import assert from 'node:assert/strict'
import { buildInitialPrompt, buildContinuationPrompt, clampStallMinutes, normalizeFingerprint, parseAgentStatus } from '../extension/protocol.js'

assert.equal(clampStallMinutes(undefined), 10)
assert.equal(clampStallMinutes(1), 5)
assert.equal(clampStallMinutes(99), 30)
assert.deepEqual(parseAgentStatus('x <agent-status>{"state":"continue","summary":"half","next":"test"}</agent-status>'), { state: 'continue', summary: 'half', next: 'test' })
assert.equal(parseAgentStatus('<agent-status>{"state":"fake"}</agent-status>'), null)
assert.equal(normalizeFingerprint('Attempt 123 COMPLETE!'), 'attempt # complete')
assert.match(buildInitialPrompt({ prompt: 'Do the job' }), /Do the job/)
assert.match(buildInitialPrompt({ prompt: 'Do the job' }), /Do not bypass, evade, rotate around/)
assert.match(buildContinuationPrompt({ prompt: 'Goal', lastAssistantText: 'Checkpoint' }, 'stall'), /Checkpoint/)
console.log('protocol tests passed')
