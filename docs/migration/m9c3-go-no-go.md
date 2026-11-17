# M9C3 GO / NO-GO

Status after M9C3A: **NO-GO**.

A PASS below requires evidence from the production host, the production network, or a named ADAPT decision. A pass on the development Mac is not a PASS for that row. Unknowns stay NEEDS DECISION or NOT RUN.

Evidence statuses:

- **PASS** — the required evidence exists and was checked
- **FAIL** — a check was run and did not meet the requirement
- **NOT RUN** — the check has not been run on the production environment
- **NEEDS DECISION** — ADAPT or IT has not chosen the owner, host, or policy

| Gate | Status | Evidence |
| --- | --- | --- |
| Host selected | NEEDS DECISION | No platform, hostname, or owner is recorded |
| Filesystem compatible | NOT RUN | NFS, SMB, and multi-host disks are unsupported. The production disk has not been identified or tested |
| Lock tests passed on the target host | NOT RUN | Child-process `flock` tests passed on the development Mac, APFS, Node v24.18.0. That does not validate another operating system or disk |
| Single-writer supervisor verified | NOT RUN | The application refuses a second writer. No production supervisor has been installed or shown to start only one process |
| Persistent storage verified | NOT RUN | The storage root must survive restart, code update, deploy rollback, and host reboot. No production directory has been provisioned |
| Trusted authorization files planned and protected | NEEDS DECISION | The file format is implemented. No production file exists. It must live outside git, mode `0600` or `0400`, owned by the server account |
| HTTP and WebSocket gateway verified | NOT RUN | No gateway or private-network policy has been tested. A proxy that only blocks `POST` leaves cue commands open |
| Unauthorized external access refused | NOT RUN | `POST /script`, Restore Previous, and WebSocket `navigate`, `goto`, and `reloadScript` are unauthenticated in the application. No external client test has been run |
| Staff token configured | NEEDS DECISION | The token is not a substitute for the network boundary. Whether production will set `PROMPTER_STAFF_TOKEN`, and where that value will live, is undecided. An empty token leaves library routes open |
| Backup operator identified | NEEDS DECISION | No person is named |
| Rollback approver identified | NEEDS DECISION | No person is named. A restore after the show is in use discards later edits and needs this approval |
| Maintenance window confirmed | NEEDS DECISION | No window is scheduled |
| ADAPT acceptance owner identified | NEEDS DECISION | No person is named |
| Production backup and isolated restore completed | NOT RUN | The M9B rehearsal copy is not a production backup. `scripts/backup-storage.js` has been tested only on disposable directories |
| Migration source hash manifest verified | NOT RUN | Checkout hashes were recorded in M9A and matched again in M9B. The stopped production snapshot for the cutover has not been taken or checked |

## Result

**NO-GO.** M9C3B must not migrate the real library, create the real authorization files, or start a production server until every NEEDS DECISION row has a recorded decision and every NOT RUN row has a PASS from the production environment.

Local regression of the application code is not one of these rows. It does not open the gate.

## Commands that stay forbidden while this file says NO-GO

- `scripts/migrate-persistent.js prepare` or `commit` against the ADAPT root
- `scripts/start-persistent.js` against the ADAPT root
- `scripts/backup-storage.js create` against the ADAPT root
- Any public listener for the current WebSocket protocol

`preflight` against the real root is also out of scope until the backup gate is passed. Taking the lock there creates `data/library/.writer.lock`.
