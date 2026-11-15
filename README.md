# mono.

A quiet little downloader. Paste a link from YouTube, TikTok, Instagram, X and 1,000+ other sites. Save it as a clean **MP4** or **MP3**. No account, no ads, no clutter — just black, white and a single button.

```
┌──────────────────────────────────────────────┐
│  PASTE A LINK                    ● YOUTUBE   │
│  ┌────────────────────────────────────────┐  │
│  │ 🔗 https://youtube.com/watch?v=…  Paste│  │
│  └────────────────────────────────────────┘  │
│  [ MP4 | MP3 ]  [ 1080p ▾ ]   [ Download ↓ ] │
│  MP4 · 1080p · best available video + audio  │
└──────────────────────────────────────────────┘
```

## What you get

- **Front end** — plain HTML, CSS and JavaScript. No build step, no framework, no dependencies. Responsive, keyboard-friendly, light/dark mode, grayscale only.
- **Back end** — a single `server.js` using only Node's standard library. Metadata, download jobs with live progress, and file streaming.
- **Real downloads** — powered by [`yt-dlp`](https://github.com/yt-dlp/yt-dlp), which supports YouTube, TikTok, Instagram, X, Facebook, Vimeo, SoundCloud, Reddit, Twitch, Dailymotion and many more.
- **Nothing stored** — files live in a temporary folder and are deleted after one hour.

## Quick start

You need **Node.js 18+**, **yt-dlp** and **ffmpeg**. On Windows:

```powershell
winget install OpenJS.NodeJS.LTS
winget install yt-dlp.yt-dlp
winget install Gyan.FFmpeg
```

Close and reopen your terminal, then:

```bash
cd "C:\Users\Blagoje\Documents\Default Project"
npm start
```

Open **http://127.0.0.1:3000**.

> The page also opens as a **preview** if you double-click `index.html` — the interface works and the flow is simulated, but no real files are created until the server is running.

### If you don't use winget

Download the standalone `yt-dlp.exe` and `ffmpeg.exe` and either put them on your `PATH`, drop them into a `bin/` folder inside this project, or point the server at them:

```powershell
$env:YTDLP_PATH  = "C:\path\to\yt-dlp.exe"
$env:FFMPEG_PATH = "C:\path\to\ffmpeg.exe"
node server.js
```

On macOS:

```bash
brew install node yt-dlp ffmpeg
npm start
```

On Debian/Ubuntu:

```bash
sudo apt install nodejs ffmpeg
sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
sudo chmod a+rx /usr/local/bin/yt-dlp
npm start
```

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port. |
| `HOST` | `127.0.0.1` | Bind address. Use `0.0.0.0` to expose it on your network. |
| `YTDLP_PATH` | auto | Path to the yt-dlp binary. |
| `FFMPEG_PATH` | auto | Path to the ffmpeg binary. |

The server looks for tools in this order: environment variable → `./bin/` → `PATH`.

## How it works

```
index.html + assets/          static UI
        │
        ▼
server.js  ──  POST /api/info      yt-dlp -J (title, duration, available heights)
           ──  POST /api/download  creates a job, spawns yt-dlp with a progress template
           ──  GET  /api/jobs/:id  polled by the UI for progress / speed / errors
           ──  GET  /api/jobs/:id/file  streams the finished file with a download header
```

- Audio is extracted with `-x --audio-format mp3 --audio-quality <kbps>K`.
- Video picks the best stream under the chosen height and merges to MP4.
- Playlists are deliberately ignored: one link, one file.
- Only public `http(s)` links are accepted; local/private hosts are rejected.
- Max two concurrent jobs per client, and expired files are cleaned up automatically.

### API at a glance

| Method | Route | Body / notes |
| --- | --- | --- |
| `GET` | `/api/health` | Returns `{ ok, ytdlp, ffmpeg }`. |
| `POST` | `/api/info` | `{ "url": "https://…" }` → title, uploader, thumbnail, heights, sizes. |
| `POST` | `/api/download` | `{ "url": "…", "type": "mp4" \| "mp3", "quality": 1080 }` → `{ id }`. |
| `GET` | `/api/jobs/:id` | `{ status, progress, speed, size, filename, error }`. |
| `GET` | `/api/jobs/:id/file` | The finished file. |
| `DELETE` | `/api/jobs/:id` | Deletes the job and its temporary files. |

## Notes & limits

- Public content only. Private, paid, age-restricted and live content will not work.
- Platforms change constantly; if one breaks, update yt-dlp (`yt-dlp -U` or `winget upgrade`).
- Some sites need cookies or a sign-in. This project intentionally does not bundle accounts or cookies.
- MP3 conversion and merging above ~720p need ffmpeg.
- The server binds to localhost by default. If you expose it publicly, put it behind a reverse proxy with rate limiting and HTTPS.

## Use it fairly

Only download content you own or have permission to save. Downloading copyrighted material may violate a platform's terms of service and local law. `mono` is a thin interface over `yt-dlp`; you are responsible for how you use it.

---

Built with black, white, and nothing in between.
