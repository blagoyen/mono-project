# mono.

A quiet little downloader. Paste a link from YouTube, TikTok, Instagram, X and 1,000+ other sites. Save it as a clean **MP4** or **MP3**. No account, no ads, no clutter — just black, white and a single button.

**Live demo → https://blagoyen.github.io/mono-project/**

> The live demo is the interface only. GitHub Pages is a static host, so it has no Node, no `yt-dlp` and no `ffmpeg` — the download flow is simulated there and the page says so. For real files, run it locally or host the server yourself.

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

## Requirements

| Tool | Why | Version |
| --- | --- | --- |
| [Node.js](https://nodejs.org) | runs the server | 18 or newer |
| [yt-dlp](https://github.com/yt-dlp/yt-dlp) | talks to the sites | any recent build |
| [FFmpeg](https://ffmpeg.org) | MP3 conversion and merging 1080p+ video with audio | any recent build |

FFmpeg is optional in the sense that the server still starts without it — but MP3 output and high-resolution MP4s will fail until it is installed.

## Quick start

### Windows

```powershell
winget install OpenJS.NodeJS.LTS
winget install yt-dlp.yt-dlp
winget install Gyan.FFmpeg
```

### macOS

```bash
brew install node yt-dlp ffmpeg
```

### Debian / Ubuntu

```bash
sudo apt install nodejs ffmpeg
sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
  -o /usr/local/bin/yt-dlp
sudo chmod a+rx /usr/local/bin/yt-dlp
```

Then, from the project folder:

```bash
npm start
```

Open **http://127.0.0.1:3000**.

If you would rather not install anything, download the standalone `yt-dlp` and `ffmpeg` binaries and either put them on your `PATH`, drop them into a `bin/` folder inside this project, or point the server at them:

```powershell
$env:YTDLP_PATH  = "C:\path\to\yt-dlp.exe"
$env:FFMPEG_PATH = "C:\path\to\ffmpeg.exe"
node server.js
```

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port. |
| `HOST` | `127.0.0.1` | Bind address. Use `0.0.0.0` to accept connections from outside the machine. |
| `YTDLP_PATH` | auto | Path to the yt-dlp binary. |
| `FFMPEG_PATH` | auto | Path to the ffmpeg binary. |

Each binary is looked for in this order: environment variable → `./bin/` → `PATH`.

## Project structure

```
index.html          markup, sections, preview card
assets/styles.css   the whole design system and both themes
assets/app.js       platform detection, quality options, polling, progress UI
assets/favicon.svg  black rounded-square download glyph
server.js           HTTP server, job pipeline, streaming, security
Dockerfile          Node + yt-dlp + ffmpeg image for hosting
README.md           this file
```

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
- Only public `http(s)` links are accepted; local and private hosts are rejected.
- Max two concurrent jobs per client, and expired files are cleaned up automatically.

### API at a glance

| Method | Route | Body / notes |
| --- | --- | --- |
| `GET` | `/api/health` | `{ ok, ytdlp, ffmpeg, fileTtlMinutes }`. |
| `POST` | `/api/info` | `{ "url": "https://…" }` → title, uploader, thumbnail, heights, sizes. |
| `POST` | `/api/download` | `{ "url": "…", "type": "mp4" \| "mp3", "quality": 1080 }` → `{ id }`. |
| `GET` | `/api/jobs/:id` | `{ status, progress, speed, size, filename, error }`. |
| `GET` | `/api/jobs/:id/file` | The finished file, streamed with range support. |
| `DELETE` | `/api/jobs/:id` | Deletes the job and its temporary files. |

## Hosting it for real

GitHub Pages, Netlify, Vercel's static tier and friends cannot run this. The app needs a long-lived process that can spawn `yt-dlp` and `ffmpeg`, write files to disk, and stream them back while a job runs. That means a container or a virtual machine — not a static host.

A `Dockerfile` is included. It installs Node, FFmpeg and the standalone Linux yt-dlp build, then runs `server.js` on `0.0.0.0:3000`.

```bash
docker build -t mono .
docker run --rm -p 3000:3000 mono
```

| Where | Good for | Watch out for |
| --- | --- | --- |
| **VPS** — Hetzner, DigitalOcean, Linode | best value once traffic is real | you run the updates, the TLS proxy and yt-dlp upgrades |
| **Container PaaS** — Render, Railway, Koyeb, Fly.io | fastest path from repo to URL | free tiers sleep; disks are ephemeral |
| **Serverless containers** — Cloud Run, Azure Container Apps | scale to zero | request timeouts and cold starts cut long downloads |
| **Your own machine + Cloudflare Tunnel** | personal use, zero cost | it is only up while your machine is |

### Things that will bite you

- **YouTube blocks datacenter IPs.** Requests from AWS, GCP, Hetzner and similar often fail with *"Sign in to confirm you're not a bot."* This is the single biggest obstacle to hosting this publicly. Workarounds (browser cookies, residential proxies, PO tokens) are fragile and may breach the platform's terms.
- **State is in memory.** Jobs live in a `Map` and files live in the OS temp folder, so the server expects a **single instance**. Do not run several replicas behind a load balancer without moving job state somewhere shared.
- **Downloads are long.** A 4K video can take minutes. Prefer hosts that allow long requests, or stream progress over your own polling (which this app already does).
- **Bandwidth is the real cost.** Video files are large, and every download leaves your host twice.
- **Public exposure needs a reverse proxy.** Put Caddy, nginx or your platform's router in front for HTTPS and rate limiting.

A minimal systemd service for a VPS:

```ini
[Unit]
Description=mono downloader
After=network-online.target

[Service]
WorkingDirectory=/srv/mono
Environment=HOST=127.0.0.1
Environment=PORT=3000
ExecStart=/usr/bin/node server.js
Restart=on-failure
User=mono

[Install]
WantedBy=multi-user.target
```

Then keep yt-dlp current, because extractors break when sites change:

```bash
yt-dlp -U        # or your package manager's upgrade command
```

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| Page says *Preview mode* | The server is not running, or you opened `index.html` directly from disk. |
| `yt-dlp was not found` | Binary missing from `PATH`; set `YTDLP_PATH`. |
| `ffmpeg is required to create MP3 files` | Install FFmpeg, or set `FFMPEG_PATH`. |
| `This video is unavailable` | The link is private, region-locked, removed, or needs a sign-in. |
| High-res MP4 fails, low-res works | FFmpeg is missing, so the separate video and audio streams cannot be merged. |
| Extractors stop working | Update yt-dlp. Platforms change constantly. |

## Use it fairly

Only download content you own or have permission to save. Downloading copyrighted material may violate a platform's terms of service and local law. `mono` is a thin interface over `yt-dlp`; you are responsible for how you use it.

## License

No license is granted yet. Without one, the code is public to read but not to reuse. Add a `LICENSE` file if you want others to build on it.

---

Built with black, white, and nothing in between.
