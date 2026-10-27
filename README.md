# Encore

A local Spotify → YouTube Music migration workspace. Opens directly, with no Encore signup, password, or login page. Built with React, TypeScript, Fastify, Node.js, and SQLite. No Python service is required.

Encore connects to Spotify's web player using your browser session, including Spotify Free accounts, without a developer app or API key. It imports playlists (including folders), liked songs, saved albums, and followed artists, matches music against the YouTube Music catalog, and transfers private playlists, native likes, saved songs, albums, and artist subscriptions. Both services can use free accounts. Spotify Account data and listening-history exports are also supported. Historical listening dates stay in Encore; the app does not fabricate YouTube plays.

## Run with Docker

Install Docker with Compose, then:

```sh
cp .env.example .env
docker compose up -d --build
```

On Windows PowerShell use `Copy-Item .env.example .env` for the first command. Open **http://127.0.0.1:8080**. The `encore-data` volume persists your database, source music files, encryption key, and jobs.

The default port binds only to localhost. This version has no access-control login: keep it local, or protect remote access through your own authenticated reverse proxy. For a remote installation, configure `BIND_ADDRESS`, set `APP_URL` to its public HTTPS URL, and set `SECURE_COOKIES=true`. Upload limits at the proxy must allow your Spotify archive. Opening Encore automatically creates an HTTP-only browser session; writes require its CSRF token and pass an origin check.

## Local development (Windows or Linux)

Requires Node.js **22.14 or newer** and npm. SQLite uses Node's built-in `node:sqlite`; this Node version may print an experimental-feature warning.

```sh
npm ci
cp .env.example .env
npm run dev
```

PowerShell: replace `cp` with `Copy-Item`. Open **http://127.0.0.1:5173**. Vite forwards `/api` requests to Fastify on port 8080. Data is stored in `./data`.

```sh
npm run typecheck
npm test
```

For a production installation without Docker, run `npm run build` once, then `npm start`. Fastify serves the built interface and API together. Builds are explicit; development and tests do not build the application.

## Transfer from Spotify Free or Premium

1. Open Encore and choose **Connect Spotify**, then follow the instructions in Connections & settings.
2. In a signed-in `open.spotify.com` tab, open developer tools → **Application → Cookies → https://open.spotify.com** (Firefox: **Storage → Cookies**). Copy the **Value** of the `sp_dc` cookie.
3. Paste it into **Spotify session cookie** and choose **Connect & import library**. The account name is verified before the session is saved. Follow import progress in **Transfers**.
4. Connect YouTube Music using the instructions below. A YouTube channel is needed to hold playlists; a paid subscription is not required.
5. Open **Your collection**, choose playlists and library options, then **Start transfer**. The best matches are selected automatically. Progress and downloadable reports are in **Transfers**.

The browser connector implements Spotify web-player requests, following the protocol documented by [SpotAPI](https://github.com/Aran404/SpotAPI). It discovers current query hashes from Spotify's own scripts rather than fixing them to one player release. The public application challenge uses rotating data from [spotify-secrets](https://code.thetadev.de/ThetaDev/spotify-secrets). Source account access is read-only; no Spotify playlists or likes are modified. Session cookies are encrypted, and temporary access tokens stay in server memory. Do not share these cookies. If a session expires, reconnect in Settings and resume the import. Imports include all pages and preserve playlist order and repeated songs; an interrupted playlist does not replace its previous complete snapshot.

These are community integrations with private service endpoints, which can change or request browser verification. Encore reports those errors instead of treating an incomplete response as an empty library. The archive route below provides an alternative when Spotify's web player cannot be reached.

## Import Spotify data files

1. Visit [Spotify account privacy](https://www.spotify.com/account/privacy/) and request **Account data**. This contains playlists and `YourLibrary.json` with saved songs, albums, and artists. This route works without a Premium developer app.
2. Request **Extended streaming history** separately for lifetime listening events. Standard `StreamingHistory*.json` files contain the period Spotify supplies in that export. Spotify prepares the archives separately; they are not immediately available after requesting them.
3. Drop a ZIP or one or more JSON files into Encore. ZIP imports retain only recognized music files; billing, profile, technical logs, and podcasts are not migrated. JSON files can be imported individually if the archive uses an unfamiliar filename.
4. Identical file imports are deduplicated. Each playlist occurrence is preserved, including same-name playlists and repeated songs. A changed archive is a new snapshot, not a live synchronization.

Uploads are limited to 512 MB each and ZIPs to 2 GB expanded / 2,000 entries. History parsing is streamed. Imports use a staging database: syntactically invalid files do not partially overwrite your collection. Missing song/artist metadata and unsupported records appear in import notes. Original supported music JSON files are retained under `data/imports/` for lossless backup.

## Connect YouTube Music

This app uses the community [YouTube.js](https://github.com/LuanRT/YouTube.js) integration (`youtubei.js`). Its music authentication uses a browser session cookie, not Google OAuth.

1. Sign in at `music.youtube.com`, selecting the intended YouTube channel.
2. Open browser developer tools → Network. Click Library, then open an authenticated `/browse` request.
3. Copy the **Cookie** request-header value, and paste it into Connections & settings.
4. If you use multiple Google accounts, enter the `x-goog-authuser` header value as the account index. Advanced brand-channel identification is available when required.
5. Connect and confirm the account name shown before starting a transfer. Sessions can expire; reconnect with a fresh cookie when a job asks you to.

Cookies are credentials. Encore encrypts them using AES-256-GCM and never returns them from connection-status endpoints, music exports, or reports. The encryption key is generated in the persistent data volume unless `ENCRYPTION_KEY` is provided as a base64-encoded 32-byte value. Keep this key with database backups. YouTube may change internal endpoints; the provider adapter is contained in `server/youtube.ts` so it can be updated independently.

## Optional Spotify developer-app connection

The default browser-session connection above does **not** need this configuration. As an alternative, set `SPOTIFY_CLIENT_ID` and register `SPOTIFY_REDIRECT_URI` exactly in your Spotify developer app. The local default uses `127.0.0.1`, not `localhost`. Hosted callbacks need HTTPS. The **Developer app connection** option appears in Settings only when configured.

Spotify's development mode requires a Premium app owner and approved users, and limits playlist-content access. Encore requests only read scopes and uses PKCE. Inaccessible playlists are marked as needing an archive. Full historical listening data still requires the extended-history export; the recent-play API supplies no listening duration and does not substitute for lifetime history. See [Spotify's current restrictions](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide).

## Match and transfer

- Playlists are selected by default. Choose whether to transfer likes, saved songs, albums, and followed artists.
- Click **Start transfer**. Existing candidates are resolved immediately; remaining songs are searched in a background job, then the transfer starts automatically. Exact title/artist/version matches are preferred, followed by the highest-ranked available result. Equal matches use the first result.
- Manual review is optional. **Find matches** on the match-review page previews choices without starting a transfer. You can change a candidate or skip an item. Missing recordings and local files are skipped automatically and included in reports; connection failures pause for retry.
- During transfer, Playlists go first, followed by likes/saved songs, albums, and artists. New playlists are private and include a small Encore migration marker in their description.
- Jobs persist through page closure. After a server restart, interrupted jobs pause until resumed. Playlist writes are reconciled against ordered destination contents before retries, including duplicate occurrences. Externally changed playlist contents pause the job for review. Restore the prior contents/order before resuming; Encore does not overwrite external edits.
- Failed operations can be retried from Transfers. Cancelling stops future operations; completed destination writes remain. Reports include each playlist entry and library operation, including skipped and failed items.
- Listening history remains browsable with date filters. Most-played playlists and additional favorite likes use qualified listening time, excluding explicit skips and plays shorter than 30 seconds. Additional likes require selection. YouTube controls recommendation behavior.

## Exports and API

Connections & settings provides library/history JSON and CSV exports. Library JSON includes ordered playlist entries and match decisions. History JSON includes dated events and listening time. CSV cells are escaped to avoid spreadsheet formula execution. Original retained JSON files remain available in the persistent volume.

The API reference is at **`/api/docs`**; OpenAPI JSON is at `/api/docs/json`. First call `GET /api/auth/status`, retain the HTTP-only `encore_session` cookie, and use the returned `csrf` value in the `x-csrf-token` header for writes. This automatically opens a local workspace session without a password. Endpoints cover imports, connections, library/history pagination, match review, transfers, job controls, and reports. `POST /api/connections/spotify` accepts `{ "cookie": "your_sp_dc_value" }`; `POST /api/imports/spotify` queues the live library import.

## Backup, restore, and upgrades

Stop the application before copying the entire `data` directory or Docker volume. Include `encore.sqlite`, any `encore.sqlite-wal` / `encore.sqlite-shm` files still present, `encryption.key` (or the external key), and `imports/`. Starting the same version with that complete volume restores the owner, sessions, sources, credentials, mappings, and jobs. Library exports alone are portable music records, not a full installation backup.

For Docker, `docker compose stop`, back up the named volume using your host's volume-backup tooling, then `docker compose start`. To upgrade, back up first and run `docker compose up -d --build`. The initial schema is version 1 (`PRAGMA user_version`); future incompatible schema changes must include an explicit migration. Avoid `docker compose down -v` unless you intend to delete all local data.

Deleting imported data in Settings removes source records, retained files, jobs, and destination mappings, but retains connected accounts. Previously transferred music remains in YouTube Music. Reimporting after deleting mappings may create new destination playlists.

## Validation

`npm test` covers archive/import integrity, browser-session connection, live-import pagination, token refresh, incomplete-snapshot protection, match review, native-library operations, recovery/reconciliation, and an API import → match → transfer scenario using deterministic provider fixtures. `npm run typecheck` checks shared frontend/backend types. Real-account operations need the user's service sessions and a user-triggered transfer; fixture checks cannot verify current account availability or every provider response shape. Development and verification do not run a production build automatically.
