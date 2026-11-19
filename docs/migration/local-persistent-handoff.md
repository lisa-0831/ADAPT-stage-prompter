# Local persistent handoff

`npm start` installs the Versioned Library that is already in this repository and serves it on `127.0.0.1`. The first start copies `data/library/productions/` and the shared script and image files into the durable directory, then writes the local marker and authorization there. It does not run Legacy migration. A later start reuses that directory and does not reset it. This is not production approval. [m9c3-go-no-go.md](m9c3-go-no-go.md) stays **NO-GO** until ADAPT IT chooses a host and the production checks pass.

Security S2B is not implemented. `POST /script`, Restore Previous, and WebSocket `navigate`, `goto`, and `reloadScript` have no authentication.

## Where a new installation lives

The first start creates the library and authorization directories outside the Git checkout. The default parent is `~/Library/Application Support/ADAPT Stage Prompter` on macOS, `%LOCALAPPDATA%\ADAPT Stage Prompter` on Windows, and `~/.local/share/adapt-stage-prompter` on Linux.

| Purpose | Default path inside that parent | Override |
| --- | --- | --- |
| Versioned library | `library/` | `ADAPT_PROMPTER_DATA` |
| Authorization files | `config/` | `ADAPT_PROMPTER_CONFIG` |
| Optional Legacy backup | `backups/legacy-before-migration/` | `ADAPT_PROMPTER_BACKUP` |

`ADAPT_PROMPTER_HOME` moves all three together. Normal startup does not create the backup. `npm run setup` does, and only for a Legacy migration. The authorization file is mode `0600` and is owned by the account that runs `npm start`. Do not commit it.

Startup refuses a path inside this checkout. It also refuses these development directories, and it does not read or write them:

- `~/ADAPT-stage-prompter-data`
- `~/ADAPT-stage-prompter-config`
- `~/ADAPT-stage-prompter-backups`

Those names belong to one development machine. A new computer does not need them.

## What the first start does

1. Check `data/library/seed.json` against the production files, version parents, and image hashes in the checkout.
2. Copy those productions, `script.txt`, the previous script, and `images/` into an empty library directory. The checkout is not modified.
3. Write `migration.json` in that durable library from the seed identity. `mirrorInstalled` starts false. The first boot then records Live State and sets `mirrorInstalled` true. The marker's content hash stays the seed identity.
4. Write a runtime authorization file, mode `0600`, outside the library directory.

WELCOME (`2d0f0937-fc36-4d27-a31e-d047c2fd5623`) is the initial live production. The installed live show is that production.

A later `npm start` checks the runtime authorization and opens the same library. It does not copy again and it does not migrate. If the data directory already contains unrelated files, startup stops and names that directory. It does not delete those files. A partial copy that has no valid marker is also left in place and is not replaced.

`npm run start:legacy` is the old checkout server and is not a fallback.

## Optional Legacy migration

`npm run setup` is not part of normal installation. It copies the Legacy script files, not the committed productions, into an empty directory, backs that copy up, and runs the existing preflight, prepare, and commit commands. Use it only for a different Legacy library. If `npm start` has already installed this seed, setup sees the existing authorization and does not migrate again. Setup refuses the same development directories and is not a production cutover.

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
6. Leave the Git checkout as the versioned seed. Do not copy the installed tree back over the checkout, and do not commit the authorization file, `migration.json`, `live-state.json`, or a writer lock.

The migration authorization file is the record of the original source hashes. It is not needed to boot the copied library.

## Security that remains

- `POST /script`, Restore Previous, and WebSocket `navigate`, `goto`, and `reloadScript` have no authentication.
- A staff token covers library routes only when it is set. It does not cover the requests above.
- `npm start` listens on `127.0.0.1` only. That is not a public deployment and does not close the production gate.
- Security S2B is not implemented on this branch.

The risks, the mitigation options, and the effect of each option on Controller, Actor, and Audience are in [security-ux-decisions.md](security-ux-decisions.md). Recording them here does not close them.
