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

Replace Script and a direct edit of `script.txt` change the live show only.
They do not replace a script already saved in the Script Library.

### Option D — Script Library

Use **Script Library** when the company has more than one production.
Full instructions are in [Script Library](#script-library).

---

## Script format

### Line types

| Syntax                                             | What it does                                    |
| -------------------------------------------------- | ----------------------------------------------- |
| `# Title`                                          | Starts a new scene                              |
| `---`                                              | Separates scenes (required between every scene) |
| `@image: images/file.jpg`                          | Shows an image before the first line (optional) |
| `@image: library:<script-id>/<image-id>`           | Shows an image saved with that production       |
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
- Image files for a saved production are uploaded in **Script Library → Manage Images**. Older scripts can still use a file in the `prompter/images/` folder with `@image: images/file.jpg`.

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

Drafts are stored in this Controller browser, not on the server. Each draft belongs to one script and one revision. A draft for a saved production is not opened for a different production. If a newer revision is published, an older draft is not opened and cannot replace that script. The editor tells you when an old draft is sitting unused, and you can delete it there.

The editor says **Unsaved changes** when the latest typing is not in the saved draft. Closing then asks you to confirm. A draft you already saved remains if you discard only the newer typing.

### What publishing does to the live cue

Publishing uses the same update as Replace Script.

- Controller, Actor, and Audience screens that are connected receive the new script.
- The Controller stays on the same scene number and line number when that spot still exists. If the scene got shorter, the cue moves to the last line of that scene. The words at that number may be different. Check the live cue after you publish.
- Actors who were browsing ahead or behind are brought back to the live cue.
- The script that was live before the publish is kept as `script.previous.txt`. In Edit Script, **Restore Previous Script** puts that copy back on every screen after you confirm. The script you replace becomes the previous copy, so you can switch back.

### What publishing does to a saved library script

If the live show still matches a library script when you open Edit Script, publishing updates that same saved copy. It does this only when nobody has changed that copy since you opened the editor. A newer saved copy is left as it is, and the screen says so.

Publishing does not replace a different production in the library.

---

## Script Library

The library keeps more than one script on the server. The live show still uses one shared script. Actor and Audience screens follow that live script until a controller chooses **Set as Live**.

1. Open the Controller: `http://localhost:3000/?role=controller`
2. Click **Script Library**.
3. To keep the show that is live now, type a title and click **Save current live script**. This adds a new saved script. It does not replace one already in the list.
4. To add a different production, type a title and choose a plain-text `.txt` file. PDF and Word files are not imported here.
5. **Preview** reads a saved script on the Controller only. The live cue does not move. Actor and Audience screens do not change. Pictures in that preview come from the production being previewed.
6. **Manage Images** uploads JPEG, PNG, or WebP pictures for that production only. Two productions can use the same file name. Removing a picture asks you to confirm, and a picture that is still used by a scene stays until you remove it from the scene and save.
7. **Edit** opens that saved script in the script editor.
   - **Save Draft** keeps unfinished edits in this browser. A draft belongs to that saved script and its revision, so it cannot replace a different production.
   - **Choose image** on a scene uses a picture uploaded for that production. You do not type a file path.
   - **Save to Library** writes the edit, including the chosen picture, back to that saved script. The live show does not change.
   - If the saved script changed after you opened it, your edit is not written over the newer copy.
   - **Set as Live** uses the saved copy. Save to the library first when the editor still has newer typing.
8. **Rename** changes the title. The script text and pictures stay the same.
9. **Set as Live** asks you to confirm. The window names the script that is live now and the script that will replace it. It stays open until the server accepts the change. Every connected screen then receives the selected script and that production's pictures. Actors who were browsing are returned to Live when the script itself changes. The cue starts at the beginning, because this is a different production.

The first time the server starts, the current `script.txt` is copied into the library if that text is not already saved. Starting the server again does not create a second copy of the same text. The saved scripts remain after a restart, and the server remembers which one was set live.

### How the old script buttons relate to the library

| Action | What changes |
| --- | --- |
| **Edit Script**, then **Publish Script** | Updates the live show. Keeps the same scene and line numbers when they still exist. Also updates the matching library copy when that copy has not changed since the editor opened. |
| **Replace Script** | Updates the live show immediately and keeps the same scene and line numbers when they still exist. Does not change library copies. If the pasted text is not one of the saved scripts, the show is live without a matching library entry until you save it. |
| **Restore Previous Script** | Puts back the previous live file, as before. It does not delete library scripts or their pictures. The restored show uses the pictures named in that previous script. |
| **Save to Library** | Updates only the saved script you are editing, including which picture each scene uses. |
| **Manage Images** | Adds or removes pictures for one saved production. It does not change the live show. |
| **Set as Live** | Copies that saved script into the live show and shows that production's pictures. A different production starts at the first cue. Setting the same production live again keeps the current cue. |

---

## Storage and deployment

Saved scripts and their pictures are files, not a database. They are stored in `data/library/` next to `script.txt`:

- `data/library/index.json` stores titles, ids, dates, and which script is live
- `data/library/scripts/` stores the script text
- `data/library/assets/<script-id>/` stores that production's pictures and a small `manifest.json` with the picture's display name, type, size, and date

`script.txt` is still the live show. `script.previous.txt` is still the one-step backup used by **Restore Previous Script**. `script.previous.txt.meta.json` remembers which saved production that backup belonged to, so its pictures still resolve.

The `data/` folder is not part of git. Do not commit uploaded scripts or pictures. On a production machine, keep `data/library/` on a disk that survives restarts and deploys. Copy that whole folder, plus `script.txt`, `script.previous.txt`, and `script.previous.txt.meta.json`, when you make a backup. You can move the library with:

```bash
SCRIPT_LIBRARY_DIR=/var/lib/stage-prompter/library node server.js
```

`SCRIPT_FILE` and `PREVIOUS_SCRIPT_FILE` still choose the live file and the previous-script backup. When `SCRIPT_LIBRARY_DIR` is not set, the library is created beside the live script file. A path on a temporary disk is wiped on the next deploy, so point `SCRIPT_LIBRARY_DIR` at storage that outlives the process. `PROMPTER_IMAGE_MAX_BYTES` changes the per-image limit. The default is 10 MB.

### Security limitation

The Controller page is not a login. `?role=controller` only changes what that browser shows. It does not authorize anyone.

**Edit Script**, **Replace Script**, and **Restore Previous Script** use `POST /script`, which has no password. Anyone who can reach the server can replace the live script. This is the same exposure the app already had.

Library files are not in the public file list. A browser cannot open `data/library/` as a web address. Unpublished script text and pictures are available through the library address, not as a static file.

Pictures for the show that is live now can be loaded by Controller, Actor, and Audience screens. That is the same exposure as the live script text. Pictures that belong to a production which is not currently in the live script are not served on that public address. Uploading, listing, and deleting pictures use the library address and, when a staff code is set, require that code. The code is sent as a header. It is not placed in the image address.

Set a shared staff code before anyone outside the trusted Wi-Fi can reach the server:

```bash
PROMPTER_STAFF_TOKEN="choose-a-long-private-code" node server.js
```

When that code is set, every library request must include it. The Controller asks for the code and keeps it in that browser tab. The code is not written into the page. Do not commit the code or put it in the README.

Without `PROMPTER_STAFF_TOKEN`, anyone who can reach the server can read and change every saved script and its pictures. That is a blocking limitation for a public deployment. Keep the server on trusted Wi-Fi, and do not put it on the public internet. The staff code is one shared passphrase, not separate accounts. The live show, including the pictures named in the live script, is still sent to every connected screen, including Audience. `POST /script` remains open even when the staff code is set, so Replace Script and Publish Script are not protected by that code.

Script text is not written into the server log. Error messages do not return a saved script.

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

Library location and the optional staff code are described in [Storage and deployment](#storage-and-deployment).
