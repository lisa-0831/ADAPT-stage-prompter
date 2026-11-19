# 🎭 Stage Prompter

A real-time shared script display — all devices stay in sync automatically.

---

## Quick Start

### 1. Install dependencies

```bash
npm install
```

Node.js and Perl are required. Perl provides the file lock. The suites were run with Node.js v24.18.0.

### 2. Start the server

```bash
npm start
```

This repository already contains a Versioned Library. WELCOME is the production under `data/library/productions/`. The first start copies that seed into a durable directory on this computer and opens WELCOME as the live show. It does not run a Legacy migration, and it does not ask for `npm run setup`.

A later start uses the same directory. It does not reset saved productions, versions, pictures, or which show is live. If that directory already has unrelated files, startup stops and does not delete them.

The default directory is:

| System | Location |
| --- | --- |
| macOS | `~/Library/Application Support/ADAPT Stage Prompter` |
| Windows | `%LOCALAPPDATA%\ADAPT Stage Prompter` |
| Linux | `~/.local/share/adapt-stage-prompter` |

`library/` inside that directory is the show data. `config/` holds the local authorization file, mode `0600`. Those files are created on this computer. They are not in Git.

ADAPT IT can choose another disk:

```bash
ADAPT_PROMPTER_HOME=/var/lib/adapt-stage-prompter npm start
```

`ADAPT_PROMPTER_DATA`, `ADAPT_PROMPTER_CONFIG`, and `ADAPT_PROMPTER_BACKUP` override the three directories separately. A path inside this checkout is refused. Startup also refuses `~/ADAPT-stage-prompter-data`, `~/ADAPT-stage-prompter-config`, and `~/ADAPT-stage-prompter-backups`.

The server listens on this computer only:

```
Controller: http://127.0.0.1:3000/?role=controller
Actor:      http://127.0.0.1:3000/?role=actor
Audience:   http://127.0.0.1:3000/?role=audience
```

`PORT=8080 npm start` changes the port. The address stays `127.0.0.1`. Phones and other computers cannot open that address. Reaching them from a venue network is a separate hosting decision in [Security Considerations and User Experience Trade-offs](#security-considerations-and-user-experience-trade-offs). An example path is not approval to put the server on a network.

Saved productions, saved versions, production-owned images, and which show is live stay in the durable directory when the Node process stops. The current cue position does not. Text typed in the browser but not saved does not. Details are in [docs/migration/local-persistent-handoff.md](docs/migration/local-persistent-handoff.md).

`npm run start:legacy` is the older checkout server. It can listen on the network. It is not a fallback for `npm start`, and it is not the installed library.

`npm run setup` remains available for an older Legacy library that is not this seed. A normal installation does not need it. It is not approval to migrate a production library.

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
3. Click **Create Production**. The library list is replaced by a form for a production title, a plain-text `.txt` script, an optional title card, and optional extra scene images. Nothing is saved until you click **Create Production** on that form. **Cancel** returns to the list and does not add a production. A completed production is saved in the library and is not live. PDF and Word files are not imported here.
4. **Preview** reads a saved script on the Controller only. The live cue does not move. Actor and Audience screens do not change. Pictures in that preview come from the production being previewed.
5. **Manage Images** uploads JPEG, PNG, or WebP pictures for that production only. Two productions can use the same file name. Removing a picture asks you to confirm, and a picture that is still used by a scene stays until you remove it from the scene and save.
6. **Edit** opens that saved script in the script editor.
   - **Save Draft** keeps unfinished edits in this browser. A draft belongs to that saved script and its revision, so it cannot replace a different production.
   - **Choose image** on a scene uses a picture uploaded for that production. You do not type a file path.
   - **Save to Library** writes the edit, including the chosen picture, back to that saved script. The live show does not change.
   - If the saved script changed after you opened it, your edit is not written over the newer copy.
   - **Set as Live** uses the saved copy. Save to the library first when the editor still has newer typing.
7. **Rename** changes the title. The script text and pictures stay the same.
8. **Delete** asks you to confirm, and the dialog names the production. **Cancel** leaves it in place. **Delete Permanently** removes that production, its saved versions, and its pictures from this library. The app has no undo. A backup, or the starting seed kept in Git, can still contain a copy. The production that is live cannot be deleted. Set another production live first. Deleting a different production does not change the live show.
9. **Set as Live** asks you to confirm. The window names the script that is live now and the script that will replace it. It stays open until the server accepts the change. Every connected screen then receives the selected script and that production's pictures. Actors who were browsing are returned to Live when the script itself changes. The cue starts at the beginning, because this is a different production.
10. **Version History** shows the saved versions of that production, newest first. Version 1 is the earliest saved copy. The order follows the saved history, not the file clock. A version with a recorded save time shows that time on this computer. A version without one says the original save time is unavailable. Preview reads one version on the Controller only. It does not move the live cue. Restore copies an older version into a new saved version. It does not by itself change the show that is live.

The first `npm start` installs WELCOME from the seed in this repository. WELCOME is live. Starting again does not create a second copy of the same text. Shows saved after that stay in the durable directory, including after the Node process stops. A production removed with **Delete Permanently** stays removed. A later start does not copy that production back from the seed. The seed in Git is left as it is.

### How the old script buttons relate to the library

| Action | What changes |
| --- | --- |
| **Edit Script**, then **Publish Script** | Updates the live show. Keeps the same scene and line numbers when they still exist. Also updates the matching library copy when that copy has not changed since the editor opened. |
| **Replace Script** | Updates the live show immediately and keeps the same scene and line numbers when they still exist. Does not change library copies. If the pasted text is not one of the saved scripts, the show is live without a matching library entry until you save it. |
| **Restore Previous Script** | Puts back the previous live file, as before. It does not delete library scripts or their pictures. The restored show uses the pictures named in that previous script. |
| **Save to Library** | Updates only the saved script you are editing, including which picture each scene uses. |
| **Manage Images** | Adds or removes pictures for one saved production. It does not change the live show. |
| **Delete** | Removes one saved production, its versions, and its pictures from this library after confirmation. It does not change the live show, and it cannot remove the production that is live. |
| **Set as Live** | Copies that saved script into the live show and shows that production's pictures. A different production starts at the first cue. Setting the same production live again keeps the current cue. |

---

## Storage, restart, and backup

`npm start` uses the durable directory described above. The first start creates it from the seed in this repository. A later start reuses it. `SCRIPT_LIBRARY_DIR`, `SCRIPT_FILE`, and `PREVIOUS_SCRIPT_FILE` do not select that directory.

The Git repository holds the starting library:

- `data/library/productions/` holds WELCOME, its versions, and its pictures
- `data/library/seed.json` records the hashes and which version of WELCOME is initially live
- `script.txt`, `script.previous.txt`, and `images/` remain so older history can still find the shared pictures

New saves go to the durable directory, not back into this checkout. Do not commit that directory, its authorization file, a backup, or a staff code.

Stopping the Node process and starting it again keeps saved productions, saved versions, production-owned pictures, and which show is live. It does not keep the cue the Controller was on, and it does not keep typing that was not saved.

Backups are an operator responsibility. Copy the durable directory only while the server is stopped, or use `scripts/backup-storage.js` on a directory ADAPT IT has approved. A backup is not a substitute for deciding who may control the show. Restoring an old backup puts back the shows from that copy and drops edits made after it.

`npm run start:legacy` (`node server.js`) still opens the files in the checkout and can listen on the network. It refuses to start when it finds a committed `migration.json`. It is not the installed library. `PROMPTER_IMAGE_MAX_BYTES` changes the per-image limit. The default is 10 MB.

Moving an installed library to another disk is described in [docs/migration/local-persistent-handoff.md](docs/migration/local-persistent-handoff.md).

## Security Considerations and User Experience Trade-offs

This section describes risks that are still present. Writing them down does not remove them. This release does not add a login screen, a PIN, a new role, or a new step in the Controller, Actor, or Audience pages. Choosing a mitigation is a decision for ADAPT IT before any deployment beyond this computer. The comparison below is decision support. It is not a security certification, and a successful local test is not one either.

The production gate in [docs/migration/m9c3-go-no-go.md](docs/migration/m9c3-go-no-go.md) remains **NO-GO**. `npm start` stays on `127.0.0.1`. Do not treat a configuration example as permission to bind `0.0.0.0`, open a tunnel, or put the server on the public internet.

### What is true in this release

The server does not know who is holding a device.

- Opening `?role=controller`, `?role=actor`, or `?role=audience` only changes that browser. The server accepts the same commands from any of them. Audience has no buttons, but a person who can reach the server can still send the commands another way.
- Replace Script, Publish Script, and Restore Previous Script use `POST /script`. That request has no password. Anyone who can reach the server can change the live show or put the previous show back.
- Cue changes use a WebSocket. `navigate`, `goto`, and `reloadScript` have no password. Anyone who can open the socket can move the cue for every connected screen.
- Saved productions and their pictures use the library address. If `PROMPTER_STAFF_TOKEN` is not set, those requests are open. If it is set, one shared code covers the library only. It does not cover `POST /script` or the cue commands. An empty code leaves the library open. This release does not turn that code on, and it does not add accounts.
- The live script and the pictures in the live show are readable by every connected screen, including Audience. That is how the show works. Pictures that belong to a production which is not live are not on that public picture address. The shared files in `images/` are still available to anyone who can open the server.
- `npm start` accepts connections only from this computer. `npm run start:legacy` can listen on every network interface. Using that command, a tunnel, or a public address would expose the open commands above. The application speaks ordinary HTTP and WebSocket. It does not provide HTTPS by itself.

The practical result is that this computer is a single-operator console. A venue network, a VPN, or the public internet is a different system, and the application cannot tell a controller from anyone else who can reach it.

### Ways ADAPT IT could reduce that exposure

None of these is risk-free. They can be combined. Network limits and a login solve different problems. HTTPS protects the connection. Backups protect the files. Neither decides who is allowed to move the cue.

| Option | What users would notice | What it would not solve |
| --- | --- | --- |
| Restricted venue network | The pages stay the same. Devices must be on the approved Wi-Fi or wired network. | Anyone on that network can still act as Controller. A guest network or a misconfigured firewall removes the limit. |
| VPN | Each device connects to the VPN before the show. The pages can stay the same after that. | A lost laptop that is already on the VPN can still control the show. Someone has to enroll every device. |
| IT login gateway | Users may sign in once at the network or proxy. The prompter pages can stay as they are. | The application still treats every signed-in browser as able to send every command, unless the gateway blocks the privileged ones. |
| One shared Controller code | Staff type one code. Actor and Audience can stay as they are only if the code is limited to privileged actions. A code that covers the whole site also stops Audience until someone enters it. | The code can be shared, written down, or left in a browser. It does not show which person acted. The current optional library code does not cover publish or the cue. |
| Individual accounts | Each person signs in. Joining the show takes longer. Someone must create, remove, and reset accounts. | Accounts do not help if the server is still open on the public internet without HTTPS, or if a signed-in browser is left unlocked. |
| Server checks for privileged actions | Audience and Actor can stay login-free. Controller actions such as publish, restore, and moving the shared cue ask for a verified role. This is the possible later Security S2B change. It is not in this release. | It still needs a way to verify the controller, and it does not encrypt the network by itself. |

More devices than this computer require a hosting choice first: this computer only, a restricted venue network, private remote access, or the public internet. Those are different risks. The endpoint list, the full comparison, and the IT checklist are in [docs/migration/security-ux-decisions.md](docs/migration/security-ux-decisions.md).

Security S2B remains a separate branch if ADAPT later chooses application-level authorization. This branch does not add it.

---

## Exit / accidental-press protection

- Pressing **Escape** or clicking **Exit** shows a confirmation dialog
- You must tap **Confirm Exit** a second time to actually leave
- Actors have Previous, Next, and Return to Live controls
- Audience members have no navigation or exit controls

---

## Running on a different port

```bash
PORT=8080 npm start
```

That changes the port and still listens on `127.0.0.1`. Library location and the optional staff code are described in [Storage and deployment](#storage-and-deployment).
