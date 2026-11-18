# Local persistent handoff

`npm run setup` installs the Versioned Library from the Legacy seed in this repository. `npm start` serves that installation on `127.0.0.1`. This is not production approval. [m9c3-go-no-go.md](m9c3-go-no-go.md) stays **NO-GO** until ADAPT IT chooses a host and the production checks pass.

Security S2B is not implemented. `POST /script`, Restore Previous, and WebSocket `navigate`, `goto`, and `reloadScript` have no authentication.

## Where a new installation lives

Setup creates three directories outside the Git checkout. The default parent is `~/Library/Application Support/ADAPT Stage Prompter` on macOS and `~/.local/share/adapt-stage-prompter` on Linux.

| Purpose | Default path inside that parent | Override |
| --- | --- | --- |
| Versioned library | `library/` | `ADAPT_PROMPTER_DATA` |
| Authorization files | `config/` | `ADAPT_PROMPTER_CONFIG` |
| Pre-migration backup | `backups/legacy-before-migration/` | `ADAPT_PROMPTER_BACKUP` |

`ADAPT_PROMPTER_HOME` moves all three together. The authorization files are mode `0600` and are owned by the account that runs setup. Do not commit them.

Setup refuses a path inside this checkout. It also refuses these development directories, and it does not read or write them:

- `~/ADAPT-stage-prompter-data`
- `~/ADAPT-stage-prompter-config`
- `~/ADAPT-stage-prompter-backups`

Those names belong to one development machine. A new computer does not need them.

## What setup does once

1. Read the Legacy seed in the checkout: `script.txt`, `script.previous.txt`, `script.previous.txt.meta.json`, `data/library/`, and `images/`.
2. Copy that seed into an empty library directory.
3. Back up the copy, verify the backup, restore it to a temporary directory, and compare hashes. The temporary restore check is removed after it matches. The backup stays.
4. Write a migration authorization file and run the existing preflight, prepare, and commit commands. Commit uses the plan hash printed by prepare.
5. Write a runtime authorization file from the committed marker.

Live is the saved production whose bytes equal `script.txt`. A different `liveId` in `data/library/index.json` is left as recorded. For the seed in this repository, the byte match is WELCOME (`2d0f0937-fc36-4d27-a31e-d047c2fd5623`). The index still names Test.

A second `npm run setup` checks the runtime authorization and stops. It does not copy again, migrate again, or replace the marker. If the library directory already contains unrelated files, setup stops and names that directory. It does not delete those files.

`npm start` reads the runtime authorization. If the file is missing, the process exits. It does not open the Legacy seed. `npm run start:legacy` is the old checkout server and is not a fallback.

## What a restart keeps

These are files under the library directory:

- a production saved with **Save to Library** or `POST /api/library`
- a later edit saved with `PUT /api/library/:id` (older version files stay as written)
- a picture uploaded to that production
- Live State after the first boot and after **Set as Live**

These are not files:

- text typed into the browser but not saved
- the current cue position

Stopping the Node process drops the cue position. The next start loads the saved live script from the first cue.

## Moving this directory later

ADAPT IT can place the same tree on the host it chooses without changing the application and without repeating the Legacy migration.

1. Stop the one server process. The writer lock is released when that process exits. Do not delete `.writer.lock` and do not copy it as library content.
2. Copy the storage tree into an empty directory on the durable disk. `scripts/backup-storage.js create`, `verify`, and `restore` does that copy and checks every file hash. Include `script.txt`, `script.previous.txt`, `script.previous.txt.meta.json`, `data/library/` (the marker, productions, versions, and assets), `data/live-journal/`, and `images/`.
3. Write a new runtime authorization file outside the checkout. Mode `0600` or `0400`, owner equal to the server account, not a symlink, and its path must already be the canonical real path. Keep `purpose` as `adapt-persistent-runtime`.
4. Change only the path fields (`root`, `libraryDir`, `scriptFile`, `previousFile`, `journalDir`) to the new canonical paths. Copy the `installation` object unchanged: schema, state, migration id, production id, version id, and content hash.
5. Start with `node scripts/start-persistent.js --config <new-file> --bind 127.0.0.1`. Do not bind `0.0.0.0`, `::`, or `*` until the production gate allows a tested private network. The launcher rejects those addresses.
6. Leave the Git checkout as the Legacy seed. Do not copy the installed tree back over the checkout, and do not commit the authorization file.

The migration authorization file is the record of the original source hashes. It is not needed to boot the copied library.

## Security that remains

- `POST /script`, Restore Previous, and WebSocket `navigate`, `goto`, and `reloadScript` have no authentication.
- A staff token covers library routes only when it is set. It does not cover the requests above.
- `npm start` listens on `127.0.0.1` only. That is not a public deployment and does not close the production gate.
- Security S2B is not implemented on this branch.
