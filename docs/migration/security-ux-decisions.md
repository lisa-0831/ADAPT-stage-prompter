# Security findings and deployment choices

This note records what the current code allows, what could be done about it, and how each choice would change the show. It is decision support for ADAPT IT.

Writing this down does not make the application safer. No option below is implemented on `feat/versioned-script-library` except the behavior the code already has. This branch does not add a login screen, a PIN, a new role, or a new step for Controller, Actor, or Audience. Security S2B, if chosen later, is a separate branch.

A passing test on a development computer is not a production security certification. [m9c3-go-no-go.md](m9c3-go-no-go.md) stays **NO-GO**. `npm start` listens on `127.0.0.1` only. A path example in the README is not approval to bind another address.

## What was checked

The findings below were read from the current route handlers. Older notes were not treated as proof.

| Behavior | Where it lives | What the code does |
| --- | --- | --- |
| Role is chosen in the browser | `client.html` reads `?role=`. `role-model.js` `resolveRole` maps controller and actor, and everything else, including `viewer`, to audience. | The server never reads that role. An Audience page has no buttons. A client that can reach the server can still send controller commands. |
| Replace, publish, and restore | `server/versioned-http-routes.js` `POST /script`. The same route exists in `server/http-routes.js`. | No staff check. `X-Restore-Previous: 1` restores the previous live script. `X-Library-Id`, `X-Library-Revision`, and `X-Version-Id` publish. The comment in both files says `?role=controller` is not authorization. |
| Shared cue | `server/live-socket.js` | A WebSocket message of type `navigate`, `goto`, or `reloadScript` updates the cue for every connected screen. There is no token. |
| Library | `requireStaff` in `server/versioned-http-routes.js` and `server/http-routes.js` | If `PROMPTER_STAFF_TOKEN` is unset or empty, the check calls through and the library is open. If it is set, one shared `X-Staff-Token` covers list, create, save, rename, images, version history, restore-to-library, Set as Live, and permanent production delete. A missing or wrong token is 401. The token does not cover `POST /script` or the WebSocket. |
| Permanent production delete | `DELETE /api/library/:id` in `server/versioned-http-routes.js` | Removes one production, its saved versions, and its owned pictures from the active library. There is no in-app undo. A backup or the Git-tracked seed can still contain a copy. The live production is refused until another production is set live. This route uses the same staff check as the other library writes. It is a destructive operation and needs an authorization decision before any deployment that is not this computer. This note does not add that check. Security S2B is not part of this change. |
| Whether a code is set | `GET /api/library/access` | Returns `{ required: true }` or `{ required: false }` with no credential. |
| Live show content | `GET /script`, `GET /script/previous`, `GET /api/live/assets/:productionId/:assetId` | No credential. Audience and Actor need the live script and its pictures. Anyone else who can reach the server can read them too. |
| Shared pictures | `createPublicAssets` in `server/http-routes.js` serves `GET /images/<file>` for image files in the checkout `images/` directory. | Those files are public page assets. `data/library` is not in that allowlist. Unpublished production pictures are not static files. They are available through the library routes, which are open when no staff token is set. |
| Listen address | `scripts/start-installed.js` passes `127.0.0.1`. `server/persistent-runtime.js` `bindAddress` refuses `0.0.0.0`, `::`, and `*`. | `npm start` cannot be pointed at every interface. `npm run start:legacy` is `node server.js`, and that process listens on all interfaces. It is not the installed library and it is not a fallback. |
| Transport | The server speaks HTTP and WebSocket. `public/connection.js` uses `ws:` or `wss:` from the page protocol. | This application does not terminate TLS. HTTPS and WSS require a proxy or another front end. |

The writer lock and the runtime authorization file stop a second process and a wrong directory. They do not identify a person. The application has no account, so it cannot record which person published or moved the cue.

## What that means in the room

- On this computer, with `npm start`, only programs on this computer can connect. That is the safest way to run the current code. Other devices cannot open the show.
- On a venue network, every phone and laptop that can open the address can read the live script, move the cue, replace the script, and, when no staff code is set, read, change, and permanently delete saved productions that are not the live show.
- A staff code, if ADAPT later turns the existing variable on, still leaves publish, restore, and the cue open.
- On the public internet, those same requests are reachable by anyone who finds the address. The current code is not suitable for that.
- A restricted network does not know which person on that network is the controller.

Four environments are different decisions:

| Environment | What it is | Fit for this release |
| --- | --- | --- |
| This computer only | `127.0.0.1`, the `npm start` default | Works with the current pages. Other devices cannot join. |
| Restricted venue LAN | A private Wi-Fi or wired network, with a firewall, where the server listens on one private address | Possible only after ADAPT IT chooses the address, the firewall, and who is allowed on the network. The application still cannot tell controllers apart. Not approved by this document. |
| Private remote access | VPN or an IT gateway so devices off site reach the private server | Possible only after that access exists and is tested. Not approved by this document. |
| Public internet | A hostname anyone can open | Not acceptable for the current code. The open write commands would be public. |

## Options

Each row says what the option changes for the people in the room. None is risk-free. ADAPT IT can combine a network limit with HTTPS and backups. Those additions do not replace a decision about who may control the show.

### 1. Restricted venue LAN, firewall, or network segmentation

- Addresses: outsiders who are not on the venue network. A guest network that cannot reach the server is the useful form of this option.
- Remains: everyone on the allowed network can still move the cue, publish, and restore. A firewall mistake, a shared Wi-Fi password, or a laptop on the wrong VLAN removes the limit. The application keeps no per-person record.
- Technical change: IT places the server on one private address, allows that port only from the show network, and blocks it from guest and office networks. The application would be started with a private bind only after that firewall is proven. `npm start` will not do that bind. `scripts/start-persistent.js --bind` can name one private address and still refuses `0.0.0.0`.
- Users log in: no.
- Controller, Actor, Audience: the pages stay the same.
- New devices: they must be on the approved network. No application credential.
- Administration: firewall rules, Wi-Fi passwords, and a check before each run of shows. Ongoing IT work.
- Venue versus remote: fits a venue. Does not by itself allow a director at home. Does not fit the public internet.
- ADAPT IT: must design and operate the network. Development cannot see that network from this repository.

### 2. VPN-only access

- Addresses: devices that are not on the VPN. Useful when a controller is off site or the venue network is not trusted.
- Remains: anyone whose device is on the VPN can send every command. A lost or shared laptop stays trusted until IT removes it. VPN does not encrypt traffic inside the venue if devices then use plain HTTP on the LAN.
- Technical change: IT runs the VPN, enrolls devices, and allows the prompter port only from the VPN. The application stays as it is.
- Users log in: they log in to the VPN, or use a certificate, before the show. The prompter pages do not add a second login.
- Controller, Actor, Audience: after the VPN is up, the pages stay the same. Nothing works until the VPN is up, including Audience.
- New devices: each one needs the VPN client and an enrollment. That is setup before the rehearsal, not during a cue.
- Administration: accounts or certificates, lost-device removal, and a test that a device off the VPN cannot connect.
- Venue versus remote: fits private remote access and can also be required at the venue. It is a poor fit if every audience phone must join a VPN.
- ADAPT IT: owns the VPN. This repository does not configure one.

### 3. IT-managed authentication gateway or reverse proxy

- Addresses: requests that never pass the gateway. IT can require an organizational login before any prompter page, or before the write URLs only.
- Remains: if the gateway only checks that someone is signed in, every signed-in person can still move the cue. If it allows the WebSocket without the same check, the cue stays open. The application itself still has no user identity.
- Technical change: IT terminates HTTPS at the proxy, forwards HTTP and the WebSocket upgrade to the Node process on loopback, and decides which paths require a session. Paths that matter are `POST /script`, the WebSocket, and `/api/library`. `GET /script` and `GET /api/live/assets` must stay reachable by Actor and Audience if those screens are not behind the same login.
- Users log in: usually once, at the gateway. The prompter buttons can stay the same after that.
- Controller, Actor, Audience: depends on the gateway rule. A login in front of the whole site makes Audience sign in too. A rule that protects only the write commands can leave Audience and Actor unchanged.
- New devices: a browser that can reach the gateway. No prompter account unless IT adds one.
- Administration: the proxy, certificates, and the login policy. The Node process should stay on loopback so clients cannot bypass the proxy.
- Venue versus remote: fits a venue and private remote access. A public hostname is still a bad idea unless the gateway blocks the write commands.
- ADAPT IT: owns the gateway. An example nginx file in a repository would not be approval to deploy it.

### 4. One shared Controller or Staff code

- Addresses: an anonymous visitor who does not know the code, and only for the requests the code actually covers.
- Remains: the code can be told to a visitor, left on a laptop, or copied out of a browser. Everyone who knows it looks the same. There is no way to disable one person without changing the code for everyone. The code that exists today covers library routes only. Publish, restore, and the cue stay open even after it is set.
- Technical change: set `PROMPTER_STAFF_TOKEN` in the server environment. Do not put the value in Git or in this document. The Controller already asks for that code and keeps it in the browser tab. Extending the same code to `POST /script` and the WebSocket would be an application change. That change is not in this branch. A PIN dialog on the Controller page would also be an application change and is not in this branch.
- Users log in: one shared secret, not a personal account. Actor and Audience stay login-free only if the secret is not required for their pages and their read requests.
- Controller, Actor, Audience: today's optional code changes the library screens only. A future code on publish and the cue would add a prompt for the person operating the Controller. Audience can remain unchanged if those read requests stay open.
- New devices: someone must enter the code on that device. There is no enrollment list.
- Administration: choose the code, change it when it leaks, and keep it out of chat logs and shell history. Low overhead, weak accountability.
- Venue versus remote: can sit on top of a venue network or a VPN. It is not enough for the public internet.
- ADAPT IT: decides whether a shared secret is acceptable. Development has not turned it on.

### 5. Individual accounts and role-based access

- Addresses: not knowing which person acted, and letting one shared secret outlive a volunteer. Organizational SSO can avoid a separate password if ADAPT already has one.
- Remains: an unlocked signed-in browser can still be used by the next person. Accounts do not stop a public listener that forgets HTTPS. Someone must remove access when a person leaves.
- Technical change: an identity provider or an account store, a session, and server-side checks on the privileged routes. The browser role would no longer be enough. This is new product work. It is not started here.
- Users log in: yes, at least the people who publish or move the shared cue. Actor and Audience could be exempt if option 6 is chosen with it.
- Controller, Actor, Audience: Controller gains a sign-in. Actor and Audience change only if their access is also gated. Forgotten passwords become a rehearsal problem.
- New devices: the person signs in. IT may also approve the device if SSO requires it.
- Administration: joiners, leavers, resets, and a named owner. This is the highest ongoing burden of the six options.
- Venue versus remote: fits all four environments only together with a network and HTTPS decision. Accounts on a public HTTP server are not sufficient.
- ADAPT IT: must choose the identity system and the owner. A lab cannot invent ADAPT's accounts in this branch.

### 6. Server-side checks for privileged actions, with Actor and Audience left open

- Addresses: the specific hole where Audience and Actor need to read the show, while publish, restore, library edits, and the shared cue should require a verified controller or staff member.
- Remains: the verification still has to be something from options 3, 4, or 5. Until that exists, the server cannot distinguish the roles. Read access to the live script remains available to anyone who can open the page, which is intentional for Audience.
- Technical change: this is Security S2B. The server would check a credential on `POST /script`, the WebSocket control messages, and the library writes. `GET /script` and the live image route would stay open for the show. It is a separate branch and is not included here.
- Users log in: the controller or staff member does. Actor and Audience do not, if the read routes stay open.
- Controller, Actor, Audience: Controller gains a verification step. Actor browsing and Audience following stay as they are. A wrong or missing credential would stop a publish or a cue move. It would not add buttons to Audience.
- New devices: a controller device needs the credential. An audience phone does not.
- Administration: whatever backs the credential: a shared code, a gateway session, or accounts.
- Venue versus remote: this is the application half of a deployment. It still needs a network decision. It is the option that best matches "Audience should not have to log in."
- ADAPT IT: has to choose it explicitly. This branch does not implement it.

### HTTPS, WSS, and backups

These are complementary. They are not authorization.

- HTTPS and WSS stop someone on the same network from quietly reading or altering the traffic. They do not decide who may connect. The application would sit behind a proxy that holds the certificate. `public/connection.js` already follows the page protocol, so a page opened with `https:` asks for `wss:`. A certificate, a hostname, and a proxy are IT work. They are not in this branch.
- Backups stop a disk failure or a bad edit from being the only copy. They do not stop an unauthorized edit. Take them while the server is stopped, or with `scripts/backup-storage.js` against a directory ADAPT IT has approved. Restoring an old copy discards later saves and needs a named approver. The backup operator is still **NEEDS DECISION** in the GO/NO-GO file.

## User-experience trade-offs in one place

- A network-only restriction keeps every page the same and cannot tell a controller from anyone else on that network.
- A VPN keeps the pages the same after the connection exists, and every device needs that connection first.
- A gateway can ask for a login once and leave the prompter buttons unchanged. If the login covers the whole site, Audience signs in too.
- A shared code is easy to operate and easy to leak, and it does not show who used it. The code available today does not cover the cue or `POST /script`.
- Personal accounts improve accountability and add account management and login friction.
- Server-side checks can leave Audience and Actor login-free while requiring verification for Controller or Staff actions. That work is not in this release.

## Decisions that are still open

ADAPT IT needs to answer these before any deployment that is not this computer:

1. Which environment is intended: this computer only, a restricted venue LAN, private remote access, or the public internet?
2. Who may move the shared cue, publish, restore, and edit saved productions?
3. Should Actor and Audience remain able to open the show with no login?
4. Is a shared code acceptable, or are individual accounts required?
5. Who operates the firewall, VPN, or gateway, and who holds the certificate?
6. Who takes backups, where they are stored, and who may approve a restore?
7. Whether to schedule Security S2B as a later change. This branch does not start it.

Until those answers exist, run `npm start` on `127.0.0.1` and do not expose the process to other machines.
