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

| Role                                    | URL                                         |
| --------------------------------------- | ------------------------------------------- |
| **Controller** (person advancing lines) | `http://192.168.1.42:3000/?role=controller` |
| **Actor** (independent reading controls) | `http://192.168.1.42:3000/?role=actor`      |
| **Audience** (live script, no controls) | `http://192.168.1.42:3000/?role=audience`   |

All devices must be on the same Wi-Fi network.

Captions scale with the space on each screen. Audience text is the largest, so it
stays readable when projected. Actor and Controller text is slightly smaller so
the navigation controls stay on screen. Long lines wrap. When a cue is taller
than the display, including at higher browser zoom, the caption area scrolls and
opens on that cue. Scene titles wrap instead of being cut off. Stage directions
keep a gap that scales with the caption.

Opening `/` without a role defaults to Audience. The legacy
`?role=viewer` URL also opens the Audience view. Unknown role values redirect
to `?role=viewer`, which uses the same non-interactive Audience view.

---

## Navigation

### Controller navigation

| Action                 | Keyboard        | On-screen                                     |
| ---------------------- | --------------- | --------------------------------------------- |
| Next line              | `→` `↓` `Space` | **Next ▶** button or tap right side of screen |
| Previous line          | `←` `↑`         | **◀ Prev** button or tap left side            |
| Jump to next slide     | `Page Down`     | ⏭ button                                     |
| Jump to previous slide | `Page Up`       | ⏮ button                                     |
| Jump to any slide      | —               | Slide dropdown                                |

Audience members see every live change instantly with no controls of their own.

### Actor navigation

Actors initially follow the Controller's live position. Using **Previous** or
**Next** switches only that browser to an independent reading position; it does
not move the Controller, Audience, or another Actor. The status changes from
**FOLLOWING LIVE** to **BROWSING**.

Select **Return to Live** to briefly animate toward the latest Controller
position and resume automatic updates. Long distances are condensed into a
short transition. The transition is skipped when reduced motion is enabled.
During a connection interruption, the status shows that the Actor is
reconnecting instead of claiming to be live.

While browsing, the Actor panel continues to show the current live scene and
line, along with how many navigable cues Live is ahead of or behind the Actor's
local position. Scene title images and empty scenes each count as navigable
cues.

Actor input options:

- Use the large **Previous**, **Next**, and **Return to Live** buttons.
- Tap the left edge of the script display for Previous.
- Tap the right edge of the script display for Next.
- Press `←` or `↑` for Previous.
- Press `→`, `↓`, or `Space` for Next.

Keyboard shortcuts are ignored while a button, link, input, select, or text
field has focus, preventing one action from navigating twice. During a
temporary disconnection, loaded script content and Actor-local controls remain
available while the status reports that the connection is being restored.

---

## Updating the script

### Option A — Edit Script (best for small changes)

On the Controller, click **Edit Script**. Pick a scene, change the lines, and
preview them. The live show does not change until you click **Publish Script**
and confirm. Full instructions are in [Editing the script](#editing-the-script).

### Option B — Paste a whole script

1. On the controller: click **📄 Replace Script**
2. Paste your new script text
3. Click **Upload & Go Live** — all screens update immediately

Replace Script sends the pasted text live right away. It does not save a draft.

### Option C — Edit the file directly

Edit `script.txt` in this folder, then on the controller click  
**📄 Replace Script → Upload & Go Live** (or send a POST request).

---

## Script format

### Line types

| Syntax                                             | What it does                                    |
| -------------------------------------------------- | ----------------------------------------------- |
| `# Title`                                          | Starts a new scene                              |
| `---`                                              | Separates scenes (required between every scene) |
| `@image: images/file.jpg`                          | Shows an image before the first line (optional) |
| `[NAME]` on its own line                           | Character name shown in left sidebar            |
| `[NAME] & [NAME]`                                  | Two characters speaking together                |
| `{stage direction}`                                | Italic brown text                               |
| `## first lyric line` / `last lyric line ##`       | Dark green lyrics block                         |
| `<first sing-along line` / `last sing-along line>` | Pink sing-along block                           |
| Plain text                                         | Amber dialogue                                  |

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
- `{stage direction}` is italic brown text. A line that is only `[NAME]` is a character name, not a stage direction
- Blank lines between speeches are ignored on stage. The editor keeps them so the file is not rewritten

### Notes

- `---` must be on its own line with no spaces before or after
- No blank lines immediately before or after `---`
- `##` only needed at the very start and very end of a lyrics block
- `<` and `>` only needed at the very start and very end of a sing-along block
- Blank lines elsewhere in the script are ignored
- Image files go in the `prompter/images/` folder

---

## Editing the script

Use this when theatre staff need to change lines without pasting a whole new script.

1. Open the Controller: `http://localhost:3000/?role=controller`
2. Click **Edit Script**. This opens a copy of the script that is live now. Actor and Audience screens stay as they are.
3. Choose a scene. Scenes stay in their original order. Switching scenes does not publish anything.
4. Edit the text in the labeled fields. Character names, lyric marks (`##`), sing-along marks (`<` and `>`), scene titles, and image lines stay attached to the same places.
5. A line the editor cannot safely rewrite is shown read-only, with a short explanation. It is not deleted. Use **Replace Script** if that line itself must change.
6. Click **Preview** to read the scene with the same character names, dialogue, stage directions, and lyrics the stage uses. Preview does not move the live cue and does not update other screens.
7. Click **Save Draft** to keep the work in this browser only. You can close the editor and open it again to continue that draft.
8. Click **Publish Script**. A confirmation window opens over the editor. Read it, then click **Publish Now**. The window shows “Publishing...” until the server accepts the script. Both windows then close, and the Controller shows “Script published successfully.” Connected screens receive the new script. **Cancel** leaves your edits in the editor.

### Drafts

Drafts are stored in this Controller browser, not on the server. Each draft belongs to the script that was live when you started. If a newer script is published, an older draft is not opened and cannot replace that script. The editor tells you when an old draft is sitting unused, and you can delete it there.

The editor says **Unsaved changes** when the latest typing is not in the saved draft. Closing then asks you to confirm. A draft you already saved remains if you discard only the newer typing.

### What publishing does to the live cue

Publishing uses the same update as Replace Script.

- Controller, Actor, and Audience screens that are connected receive the new script.
- The Controller stays on the same scene number and line number when that spot still exists. If the scene got shorter, the cue moves to the last line of that scene. The words at that number may be different. Check the live cue after you publish.
- Actors who were browsing ahead or behind are brought back to the live cue.
- The script that was live before the publish is kept as `script.previous.txt`. In Edit Script, **Restore Previous Script** puts that copy back on every screen after you confirm. The script you replace becomes the previous copy, so you can switch back.

### Security limitation

The Controller page is not a login. **Edit Script**, **Replace Script**, and **Restore Previous Script** all use the existing `POST /script` upload, which has no password. Anyone who can reach the server on the network can replace the script. This is the same exposure the app already had. Keep it on trusted Wi-Fi, and do not put it on the public internet. This feature does not add a new write address.

---

## Exit / accidental-press protection

- Pressing **Escape** or clicking **Exit** shows a confirmation dialog
- You must tap **Confirm Exit** a second time to actually leave
- Actors have Previous, Next, and Return to Live controls
- Audience members have no navigation or exit controls

---

## Running on a different port

```bash
PORT=8080 node server.js
```
