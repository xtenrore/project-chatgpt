# Project Supervisor v0.2

A first prototype of a persistent supervisor for long-running **ChatGPT Project** work.

Dashboard configured in the extension: `https://project-supervisor-production.up.railway.app`. Check `/health` on your deployment before relying on it.

The worker is the normal `chatgpt.com` tab you are already logged into. A Chrome/Edge extension stores a persistent job ledger, watches a selected ChatGPT Project conversation, pauses at product limits, detects genuine no-progress stalls, and sends checkpoint-aware continuation prompts when appropriate.

## Non-negotiable rules

- **Never bypass ChatGPT limits.** A detected usage/message limit becomes `paused_limit`. There is no account rotation, hidden endpoint use, session spoofing, or retrying around the limit.
- **Use the strongest visible Chat option.** Strict Model Guard inspects model/reasoning controls exposed to the logged-in account and attempts to select the strongest recognized enabled option. If it cannot verify the picker safely, it fails closed rather than silently downgrading.
- **Authentication stays in ChatGPT.** The extension never asks for or stores your ChatGPT password.
- **The dashboard or phone may be closed.** Job state lives in `chrome.storage.local`. The desktop computer running Chrome/Edge must remain powered on and awake and the browser must remain running. The phone displays the last mirrored snapshot while offline; it cannot control the desktop extension remotely.
- **Fail closed on uncertainty.** A 10-minute watchdog only stops a turn when the worker is still visibly generating and no observable output has changed. Otherwise it requests attention instead of blindly clicking.

## Current behavior

- Persistent jobs with original objective + exact ChatGPT Project/conversation URL.
- Email/password accounts and saved assistant chats require server storage. Configure a persistent `DATA_DIR` volume on Railway; its default local filesystem can be lost on redeploy. Configure a unique, strong `SESSION_SECRET` in production. The server refuses to start without it.
- The assistant requires `AI_GATEWAY_API_KEY` and provider access. Without the key, the chat assistant is unavailable; the local extension supervisor does not depend on it.
- Structured `<agent-status>` protocol: `continue`, `complete`, or `needs_user`.
- Terminal assistant responses are fingerprinted and processed once, preventing duplicate continuation loops.
- Default 10-minute no-output watchdog (configurable 5–30 minutes).
- Confirmed stall: preserve the latest visible assistant output, stop the active generation once, then continue from that checkpoint with explicit instructions not to restart completed work.
- Repeated terminal output triggers a change-of-approach continuation.
- Browser notifications for completion, usage limits, and attention states.
- No paid runtime AI/API dependency is required for the supervisor itself.

## Install the extension

1. Download/unzip the `extension/` directory (or the provided extension ZIP).
2. In desktop Chrome, open `chrome://extensions`; in Edge open the Extensions page.
3. Enable **Developer mode**.
4. Choose **Load unpacked** and select the unzipped `extension/` folder.
5. Stay logged into `https://chatgpt.com` in that browser.
6. Open **Project Supervisor Bridge** and click **Open Supervisor**. The production dashboard URL is preconfigured.
7. Create a job using the exact ChatGPT Project/conversation URL you want supervised, such as the Plane Alerts project chat.

## Architecture

```text
Dashboard (may be closed)
        │ locally paired page bridge
        ▼
Chrome/Edge extension service worker
        │ persistent ledger + watchdog
        ▼
Logged-in chatgpt.com Project/conversation tab
```

## Run locally

No dependency install is required.

```bash
npm test
npm start
```

Open `http://localhost:3000`. Health endpoint: `/health`.

## Prototype boundary

This operates the public ChatGPT web interface. UI changes can require selector maintenance. Local tests cover the protocol and server, including private file access, authentication, chat ownership and cross-origin mutations. A live logged-in ChatGPT selector path has not been verified from this repository. Job snapshots appear on a phone after the paired desktop dashboard has mirrored them; the extension's local job ledger is authoritative.
