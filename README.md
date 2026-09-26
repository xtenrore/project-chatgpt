# Project Supervisor

Prototype orchestration layer for long-running ChatGPT Project work.

## What it does

- Uses your normal logged-in `chatgpt.com` session; it does **not** ask for or store your ChatGPT password.
- Opens the ChatGPT Project/conversation URL you provide and sends the full job there.
- Best-effort selects the highest recognized model that is **actually visible in your account's model picker**. Strict Model Guard is on by default and pauses instead of silently using an unverified lower model.
- Watches visible ChatGPT output and keeps a persistent browser-side job ledger.
- If ChatGPT reports a usage/message limit, marks the job `paused_limit` and does not retry around it.
- If an active generation shows no observable progress for the configured threshold (default 10 minutes), stops that generation once, preserves the last checkpoint excerpt, and sends a recovery continuation prompt.
- Auto-continues when the worker explicitly reports `state=continue` in the injected supervisor protocol.
- Marks completion only when the worker explicitly reports `state=complete`.
- Browser notifications are used for completion, limits, and genuine attention states.

## Important prototype boundary

This is a browser-UI bridge, so ChatGPT UI changes can break selectors. It is deliberately fail-closed in Strict Model Guard mode. It does not bypass ChatGPT plan limits, spoof accounts, rotate sessions, or use hidden/private ChatGPT endpoints.

The supervisor extension keeps working when the dashboard/phone is closed **as long as the computer running Chrome/Edge stays awake and the browser remains running**. A sleeping or powered-off computer cannot continue browser-UI automation. A later hosted-browser/server version can remove that machine dependency, but would need a secure supported login/session design.

## Install the web app

No build step is required. The dashboard is a zero-dependency static site (`index.html`, `app.js`, `styles.css`). Deploy the repository root directly to Vercel.

## Install the extension (prototype)

1. Open `chrome://extensions` (or Edge extensions).
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select the `extension/` directory.
4. Open the extension popup.
5. Set the deployed supervisor website origin, e.g. `https://project-chatgpt.vercel.app`.
6. Click **Open Supervisor**. The pairing key is passed in the URL fragment, saved locally by the site, then immediately removed from the address bar.
7. Paste the exact `https://chatgpt.com/...` Project/conversation URL into a new job and start it.

## Security model

- Pairing key is generated locally in `chrome.storage.local`.
- The extension accepts supervisor commands only from the configured website origin and only with the local key.
- Job prompts and checkpoints are stored locally in the extension for this prototype.
- The extension has host access only to `chatgpt.com`, Vercel preview/production origins, and localhost for development.

## Status footer injected into worker jobs

The worker is instructed to end turns with:

```text
<agent-status>{"state":"continue|complete|needs_user","summary":"...","next":"..."}</agent-status>
```

This makes continuation deterministic enough for the first prototype instead of asking another paid AI model every few seconds whether the worker is done.
