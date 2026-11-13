# Web control panel

Paste a YouTube link, generate the video URL, and stream it to a Discord voice channel (Go Live) from a web page.

## Setup
1. Install `yt-dlp` and an FFmpeg build with `libzmq` (see the main README).
2. Copy `config.example.json` to `config.json` (set `panelPassword` if the page is on a domain).
3. From the project root: `pnpm install`, then in `examples/web`: `pnpm run yeet`
4. Open http://127.0.0.1:3000 and paste your Discord token in the **Discord token** box, then press **Login**.

A token in `config.json` (`"token"`) or the `DISCORD_TOKEN` env var is optional: if present the server logs in with it at startup. The token you paste on the page is kept in memory only and is never written to disk.

## Using the page
- **Discord token + Login / Logout**: log in with any token from the page; Logout disconnects the session.
- **Join channel / Leave channel**: join or leave the voice channel selected in **More** (without streaming).
- **YouTube link + Generate**: makes the direct video URL (shown with a Copy button).
- **Auto** (checked by default): pasting a link generates the URL and starts streaming at once.
- **More**: pick the **Group** and **Voice channel**, then press **Watch** to start the stream.
- **Pause / Resume / Stop** control the running stream.

## Discord commands
Sent from the logged-in account (or an ID listed in `acceptedAuthors`). The prefix is `prefix` in `config.json` (default `L!`).
- `L!join` joins the voice channel you are in; `L!join <channelId>` joins a specific one.
- `L!leave` leaves the voice channel (and stops the stream).

## Security
The server listens on `127.0.0.1` only. If you expose it on a domain, set `host` to `0.0.0.0`
**and** set `panelPassword`, and put it behind HTTPS (e.g. Caddy or nginx), because anyone who
can open the page can control your Discord account.
