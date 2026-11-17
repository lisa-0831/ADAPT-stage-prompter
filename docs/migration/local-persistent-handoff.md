# Local persistent handoff

This is a local operating copy of the versioned ADAPT library. It is not production approval. [m9c3-go-no-go.md](m9c3-go-no-go.md) stays **NO-GO** until ADAPT IT chooses a host and the production checks pass.

## Where the data lives

| Purpose | Path |
| --- | --- |
| Persistent library | `/Users/lisawang/ADAPT-stage-prompter-data` |
| Authorization | `/Users/lisawang/ADAPT-stage-prompter-config` |
| Pre-migration backup | `/Users/lisawang/ADAPT-stage-prompter-backups/legacy-before-migration` |

These directories are outside the Git checkout. The checkout's `script.txt`, `data/library/`, and `images/` are still the untouched Legacy copy. Starting the persistent server, editing application code, or switching branches does not write those checkout files and does not replace the persistent directory.

The runtime authorization file is the only switch that selects this directory. `npm run start:local` reads that file and binds `127.0.0.1`. If the file is missing, it exits. It does not open the checkout's Legacy files.

```bash
npm run start:local
```

Controller, Actor, and Audience use the same role URLs on `127.0.0.1`. There is no new login. `PROMPTER_STAFF_TOKEN` is optional and, when unset, library routes stay open on that loopback server, matching the current local workflow.

`node server.js` and `npm start` still start the checkout Legacy server. They are not a fallback for this library.

## What was migrated

The persistent directory was filled from a byte-checked copy of the checkout, then backed up and restore-checked before migration. Migration used `scripts/migrate-persistent.js` with `migration-authorization.json`. The live script bytes selected WELCOME (`2d0f0937-fc36-4d27-a31e-d047c2fd5623`). The index `liveId` still names Test, and that drift was left as recorded.

Committed installation:

- migration `41be0a3b-ffb4-4248-849a-ca3acf02b6e3`
- production `2d0f0937-fc36-4d27-a31e-d047c2fd5623`
- version `5eca4a88-6f8e-4c7b-bdcd-538e57fee3a2`
- content hash `8f8ccda312a0346efdf73d4da30f0c36c68c1841a55de840f82a5c6d47ad025f`
- `previousActivation` is null

Do not run the Legacy migration again for this directory. A second commit is refused because the marker is already committed.

## What a restart keeps

These are files under the persistent root:

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
6. Leave the Git checkout on Legacy storage. Do not copy the persistent tree back over the checkout, and do not commit the authorization file.

The migration authorization file is the record of the original source hashes. It is not needed to boot the copied library.

## Security that remains

- `POST /script`, Restore Previous, and WebSocket `navigate`, `goto`, and `reloadScript` have no authentication.
- A staff token covers library routes only when it is set. It does not cover the requests above.
- The local command listens on `127.0.0.1` only. That is not a public deployment and does not close the production gate.
- Security S2B is not implemented on this branch.
