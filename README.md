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

---

## Script format

### Line types

| Syntax | What it does |
|---|---|
| `# Title` | Starts a new scene |
| `---` | Separates scenes (required between every scene) |
| `@image: images/file.jpg` | Shows an image before the first line (optional) |
| `[NAME]` on its own line | Character name shown in left sidebar |
| `[NAME] & [NAME]` | Two characters speaking together |
| `{stage direction}` | Italic brown text |
| `## first lyric line` / `last lyric line ##` | Dark green lyrics block |
| `<first sing-along line` / `last sing-along line>` | Pink sing-along block |
| Plain text | Amber dialogue |

### Example

```
# Scene 1 | Kansas Place in Brooklyn, New York
@image: images/scene1.jpg
{DOROTHY enters. TOTO is with her.}
[DOROTHY]
Oh Toto, I don't think we're in New York anymore.
[GULCH]
Where is that pest?!
[DOROTHY] & [GULCH]
This isn't over!
## SOMEWHERE OVER THE RAINBOW, WAY UP HIGH,
THERE'S A LAND THAT I HEARD OF ONCE IN A LULLABY. ##
<SING ALONG WITH US NOW,
EVERYBODY JOIN IN!>

# Scene 2 | Munchkinland
{GLINDA appears in her flying bubble.}
[DOROTHY]
Where are we?
```

- Separate slides with `---` on its own line
- Start each slide with `# Title` (shown as the amber header)
- Lines starting with `[` or `(` render in amber italic as stage directions
- Blank lines between speeches are ignored

### Notes
- `---` must be on its own line with no spaces before or after
- No blank lines immediately before or after `---`
- `##` only needed at the very start and very end of a lyrics block
- `<` and `>` only needed at the very start and very end of a sing-along block
- Blank lines elsewhere in the script are ignored
- Image files go in the `prompter/images/` folder

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
