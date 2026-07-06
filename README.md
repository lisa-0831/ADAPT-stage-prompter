# 🎭 Stage Prompter

A real-time shared script display — all devices stay in sync automatically.

---

## Quick Start

### 1. Install dependencies (one time)
```bash
npm install
```

### 2. Start the server
```bash
node server.js
```

The terminal will print your local network address, e.g.:
```
🎭  Stage Prompter running on port 3000
   Local:   http://localhost:3000
   Network: http://192.168.1.42:3000
```

### 3. Open on devices

| Device | URL |
|---|---|
| **Controller** (person advancing lines) | `http://192.168.1.42:3000/?role=controller` |
| All other viewers | `http://192.168.1.42:3000/` |

All devices must be on the same Wi-Fi network.

---

## Navigation (Controller only)

| Action | Keyboard | On-screen |
|---|---|---|
| Next line | `→` `↓` `Space` | **Next ▶** button or tap right side of screen |
| Previous line | `←` `↑` | **◀ Prev** button or tap left side |
| Jump to next slide | `Page Down` | ⏭ button |
| Jump to previous slide | `Page Up` | ⏮ button |
| Jump to any slide | — | Slide dropdown |

Viewers see every change instantly with no controls of their own.

---

## Updating the script

### Option A — Paste in browser (easiest)
1. On the controller: click **📄 Replace Script**
2. Paste your new script text
3. Click **Upload & Go Live** — all screens update immediately

### Option B — Edit the file directly
Edit `script.txt` in this folder, then on the controller click  
**📄 Replace Script → Upload & Go Live** (or send a POST request).

### Option C — HTTP API
```bash
curl -X POST http://localhost:3000/script \
  -H "Content-Type: text/plain" \
  --data-binary @my_script.txt
```

---

## Script format

```
# Act One — Scene 1
ELEANOR
I never thought I'd come back here.

[She crosses to the window]

The house looks the same.
---
# Scene 2
MARCUS enters from stage left.

MARCUS
You shouldn't have come alone.
```

- Separate slides with `---` on its own line
- Start each slide with `# Title` (shown as the amber header)
- Lines starting with `[` or `(` render in amber italic as stage directions
- Blank lines between speeches are ignored

---

## Exit / accidental-press protection

- Pressing **Escape** or clicking **Exit** shows a confirmation dialog
- You must tap **Confirm Exit** a second time to actually leave
- Viewers have no navigation or exit controls

---

## Running on a different port
```bash
PORT=8080 node server.js
```
