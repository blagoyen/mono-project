#!/usr/bin/env node
"use strict";

/**
 * mono. — a tiny, dependency-free download server.
 *
 *   node server.js
 *
 * Requires yt-dlp on PATH (or YTDLP_PATH / ./bin/yt-dlp).
 * MP3 conversion and high-resolution MP4 merging require ffmpeg.
 */

const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const { promisify } = require("node:util");

const execFile = promisify(require("node:child_process").execFile);

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "127.0.0.1";
const ROOT = __dirname;
const WORK_DIR = path.join(os.tmpdir(), "mono-downloader");
const FILE_TTL_MS = 60 * 60 * 1000;
const INFO_TTL_MS = 10 * 60 * 1000;
const MAX_BODY = 8 * 1024;
const MAX_JOBS_PER_IP = 2;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".md": "text/markdown; charset=utf-8",
};

const VIDEO_HEIGHTS = [2160, 1440, 1080, 720, 480, 360, 240];
const AUDIO_BITRATES = [320, 256, 192, 128];

/* ------------------------------------------------------------------ */
/* tools                                                               */
/* ------------------------------------------------------------------ */

let toolsCache = { ytdlp: null, ffmpeg: null, checkedAt: 0 };

function probe(command, args) {
  try {
    const result = spawnSync(command, args, {
      encoding: "utf8",
      timeout: 8000,
      windowsHide: true,
    });
    if (result.error || result.status !== 0) return null;
    const output = String(result.stdout || "").trim();
    return output.split(/\r?\n/)[0].trim() || "installed";
  } catch {
    return null;
  }
}

function findYtDlp() {
  const exe = process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp";
  const candidates = [process.env.YTDLP_PATH, path.join(ROOT, "bin", exe), exe].filter(Boolean);
  for (const candidate of candidates) {
    const version = probe(candidate, ["--version"]);
    if (version) return { command: candidate, version };
  }
  return null;
}

function findFfmpeg() {
  const exe = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const candidates = [process.env.FFMPEG_PATH, path.join(ROOT, "bin", exe), exe].filter(Boolean);
  for (const candidate of candidates) {
    if (probe(candidate, ["-version"])) return candidate;
  }
  return null;
}

function getTools(force = false) {
  if (!force && toolsCache.checkedAt && Date.now() - toolsCache.checkedAt < 15000) {
    return toolsCache;
  }
  toolsCache = {
    ytdlp: findYtDlp(),
    ffmpeg: findFfmpeg(),
    checkedAt: Date.now(),
  };
  return toolsCache;
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function stripAnsi(value) {
  return String(value || "").replace(/\x1b\[[0-9;]*m/g, "");
}

function lastLine(value) {
  const lines = stripAnsi(value)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length ? lines[lines.length - 1] : "";
}

function friendlyError(raw, fallback) {
  const text = lastLine(raw)
    .replace(/^ERROR:\s*/i, "")
    .replace(/^WARNING:\s*/i, "");
  return text ? text.slice(0, 400) : fallback;
}

function errorHint(message) {
  const text = String(message || "").toLowerCase();
  if (text.includes("ffmpeg")) {
    return "ffmpeg is required for this format. Install ffmpeg, then restart the server.";
  }
  if (text.includes("sign in") || text.includes("confirm your age") || text.includes("bot")) {
    return "The site is asking for a sign-in check. Try another public link.";
  }
  if (text.includes("unsupported url")) {
    return "That site is not supported by yt-dlp.";
  }
  if (text.includes("private") || text.includes("unavailable") || text.includes("removed")) {
    return "The media is private, removed or region-locked.";
  }
  return "";
}

function isPrivateHost(hostname) {
  const host = hostname.toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.startsWith("[")
  ) {
    return true;
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    const parts = host.split(".").map(Number);
    if (parts[0] === 10 || parts[0] === 127 || parts[0] === 0) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  }
  return false;
}

function parseTarget(raw) {
  if (typeof raw !== "string" || !raw.trim() || raw.length > 2048) {
    return { error: "Paste a valid video link." };
  }
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    return { error: "That does not look like a link. Include https:// at the start." };
  }
  if (!/^https?:$/.test(url.protocol)) {
    return { error: "Only http and https links are supported." };
  }
  if (!url.hostname.includes(".") || isPrivateHost(url.hostname)) {
    return { error: "That host is not allowed. Use a public video link." };
  }
  return { url: url.href };
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("Request body too large."));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON body."));
      }
    });
    req.on("error", reject);
  });
}

function clientIp(req) {
  const raw = req.socket.remoteAddress || "local";
  return raw.replace(/^::ffff:/, "");
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/* ------------------------------------------------------------------ */
/* rate limiting                                                       */
/* ------------------------------------------------------------------ */

const hits = new Map();

function allow(ip, limit = 20) {
  const now = Date.now();
  const windowStart = now - 60 * 1000;
  const list = (hits.get(ip) || []).filter((time) => time > windowStart);
  if (list.length >= limit) {
    hits.set(ip, list);
    return false;
  }
  list.push(now);
  hits.set(ip, list);
  return true;
}

/* ------------------------------------------------------------------ */
/* static                                                              */
/* ------------------------------------------------------------------ */

function resolveStatic(pathname) {
  let clean;
  try {
    clean = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (clean === "/" || clean === "/index.html") return path.join(ROOT, "index.html");
  if (clean === "/README.md") return path.join(ROOT, "README.md");
  if (!clean.startsWith("/assets/")) return null;
  const assetsDir = path.join(ROOT, "assets") + path.sep;
  const target = path.normalize(path.join(ROOT, clean));
  if (!target.startsWith(assetsDir)) return null;
  if (!MIME[path.extname(target).toLowerCase()]) return null;
  return target;
}

async function serveStatic(req, res, pathname) {
  const filePath = resolveStatic(pathname);
  if (!filePath) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }

  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }
  if (!stat.isFile()) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    "Content-Type": MIME[ext] || "application/octet-stream",
    "Content-Length": stat.size,
    "Cache-Control": "no-cache",
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  fs.createReadStream(filePath).pipe(res);
}

/* ------------------------------------------------------------------ */
/* metadata                                                            */
/* ------------------------------------------------------------------ */

const infoCache = new Map();

function formatOf(entry) {
  const formats = Array.isArray(entry.formats) ? entry.formats : [];
  const video = formats.filter(
    (format) =>
      format &&
      format.vcodec &&
      format.vcodec !== "none" &&
      Number.isFinite(Number(format.height)) &&
      Number(format.height) > 0
  );
  const audio = formats
    .filter((format) => format && format.acodec && format.acodec !== "none" && format.vcodec === "none")
    .sort((a, b) => Number(b.abr || b.tbr || 0) - Number(a.abr || a.tbr || 0));
  const bestAudio = audio[0] || null;
  const duration = Number(entry.duration) || 0;

  const bytesFor = (format) => {
    if (!format) return 0;
    if (Number(format.filesize) > 0) return Number(format.filesize);
    if (Number(format.filesize_approx) > 0) return Number(format.filesize_approx);
    const rate = Number(format.tbr || format.abr || 0);
    return rate && duration ? (rate * 1000 * duration) / 8 : 0;
  };

  const audioBytes = bytesFor(bestAudio);
  const heights = Array.from(new Set(video.map((format) => Math.round(Number(format.height)))))
    .filter((height) => height >= 144 && height <= 2160)
    .sort((a, b) => b - a);

  const sizes = {};
  for (const height of heights) {
    const candidates = video.filter((format) => Math.round(Number(format.height)) === height);
    candidates.sort((a, b) => {
      const extScore = (format) => (format.ext === "mp4" ? 1 : 0);
      const audioScore = (format) => (format.acodec && format.acodec !== "none" ? 1 : 0);
      return (
        extScore(b) - extScore(a) ||
        audioScore(b) - audioScore(a) ||
        Number(b.tbr || 0) - Number(a.tbr || 0)
      );
    });
    const size = bytesFor(candidates[0]) + audioBytes;
    if (size > 0) sizes[height] = Math.round(size);
  }

  return { heights, sizes, audioSize: Math.round(audioBytes) };
}

async function fetchInfo(target) {
  const cached = infoCache.get(target);
  if (cached && Date.now() - cached.at < INFO_TTL_MS) return cached.data;

  const tools = getTools();
  if (!tools.ytdlp) {
    const error = new Error("yt-dlp is not installed on this machine.");
    error.status = 503;
    error.hint = "Install yt-dlp, restart the server, then reload this page.";
    throw error;
  }

  let stdout;
  try {
    const result = await execFile(
      tools.ytdlp.command,
      ["--no-playlist", "--no-warnings", "--skip-download", "--dump-single-json", target],
      { timeout: 60000, maxBuffer: 32 * 1024 * 1024, windowsHide: true, encoding: "utf8" }
    );
    stdout = result.stdout;
  } catch (err) {
    const message = friendlyError(err.stderr || err.message, "That link could not be read.");
    const error = new Error(message);
    error.status = 422;
    error.hint = errorHint(message);
    throw error;
  }

  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw Object.assign(new Error("The site returned data that could not be parsed."), { status: 422 });
  }

  const entry =
    parsed && parsed._type === "playlist" && Array.isArray(parsed.entries)
      ? parsed.entries.find(Boolean)
      : parsed;

  if (!entry) {
    throw Object.assign(new Error("No media was found at that link."), { status: 422 });
  }
  if (entry.is_live) {
    throw Object.assign(new Error("Live streams cannot be downloaded."), { status: 422 });
  }

  const { heights, sizes, audioSize } = formatOf(entry);
  const thumbnails = Array.isArray(entry.thumbnails) ? entry.thumbnails : [];
  const thumbnail =
    entry.thumbnail ||
    (thumbnails.length ? thumbnails[thumbnails.length - 1].url : "");

  const data = {
    title: entry.title || entry.fulltitle || "Untitled media",
    uploader:
      entry.uploader ||
      entry.channel ||
      entry.creator ||
      entry.uploader_id ||
      "",
    duration: Number(entry.duration) || 0,
    thumbnail: typeof thumbnail === "string" ? thumbnail : "",
    webpageUrl: entry.webpage_url || target,
    extractor: entry.extractor_key || entry.extractor || "",
    heights,
    sizes,
    audioSize,
  };

  infoCache.set(target, { at: Date.now(), data });
  if (infoCache.size > 120) {
    const oldest = infoCache.keys().next().value;
    infoCache.delete(oldest);
  }
  return data;
}

/* ------------------------------------------------------------------ */
/* jobs                                                               */
/* ------------------------------------------------------------------ */

const jobs = new Map();
const activePerIp = new Map();

function parseSpeed(text) {
  const match = String(text || "").match(/([\d.]+)\s*(K|M|G)?iB\/s/i);
  if (!match) return 0;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return 0;
  const unit = (match[2] || "").toUpperCase();
  const multiplier = unit === "G" ? 1024 ** 3 : unit === "M" ? 1024 ** 2 : unit === "K" ? 1024 : 1;
  return Math.round(value * multiplier);
}

function createJob(ip, { target, type, quality }) {
  const id = crypto.randomBytes(9).toString("hex");
  const dir = path.join(WORK_DIR, id);
  const job = {
    id,
    ip,
    dir,
    url: target,
    type,
    quality,
    status: "queued",
    progress: 0,
    speed: 0,
    eta: "",
    error: "",
    filePath: "",
    filename: "",
    size: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    child: null,
  };
  jobs.set(id, job);
  activePerIp.set(ip, (activePerIp.get(ip) || 0) + 1);
  return job;
}

function releaseJob(job) {
  if (job.released) return;
  job.released = true;
  job.updatedAt = Date.now();
  const count = activePerIp.get(job.ip) || 1;
  if (count <= 1) activePerIp.delete(job.ip);
  else activePerIp.set(job.ip, count - 1);
}

async function runJob(job) {
  const tools = getTools();

  if (!tools.ytdlp) {
    job.status = "error";
    job.error = "yt-dlp is not installed on this machine.";
    releaseJob(job);
    return;
  }

  if (job.type === "mp3" && !tools.ffmpeg) {
    job.status = "error";
    job.error = "ffmpeg is required to create MP3 files.";
    releaseJob(job);
    return;
  }

  await fsp.mkdir(job.dir, { recursive: true });

  const args = [
    "--no-playlist",
    "--no-warnings",
    "--newline",
    "--restrict-filenames",
    "--no-mtime",
    "--progress",
    "--progress-template",
    "download:%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s",
    "-o",
    path.join(job.dir, "%(title).80s.%(ext)s"),
  ];

  if (tools.ffmpeg) {
    args.push("--ffmpeg-location", tools.ffmpeg);
  }

  if (job.type === "mp3") {
    args.push("-x", "--audio-format", "mp3", "--audio-quality", `${job.quality}K`);
  } else {
    const height = job.quality;
    args.push(
      "-f",
      `bestvideo[height<=${height}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=${height}]+bestaudio/best[height<=${height}]/best`,
      "--merge-output-format",
      "mp4"
    );
  }

  args.push(job.url);

  let child;
  try {
    child = spawn(tools.ytdlp.command, args, {
      cwd: job.dir,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    job.status = "error";
    job.error = friendlyError(error.message, "Could not start yt-dlp.");
    releaseJob(job);
    return;
  }

  job.child = child;
  job.status = "downloading";
  job.updatedAt = Date.now();

  let buffer = "";
  let stderr = "";

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop();
    for (const line of lines) {
      const text = line.trim();
      if (!text.includes("%|")) continue;
      const match = text.match(/^([\d.]+|N\/A)%\s*\|([^|]*)\|?(.*)$/);
      if (!match) continue;

      const percent = parseFloat(match[1]);
      if (Number.isFinite(percent)) {
        job.progress = Math.max(0, Math.min(100, percent));
        job.status = job.progress >= 99.9 ? "processing" : "downloading";
      }
      job.speed = parseSpeed(match[2]);
      job.eta = String(match[3] || "").trim();
      job.updatedAt = Date.now();
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
    if (stderr.length > 32000) stderr = stderr.slice(-32000);
  });

  child.on("error", (error) => {
    job.status = "error";
    job.error = friendlyError(error.message, "Could not start yt-dlp.");
    releaseJob(job);
  });

  child.on("close", async (code) => {
    job.child = null;

    if (code !== 0) {
      if (job.status !== "error") {
        job.status = "error";
        job.error = friendlyError(stderr, `Download failed (exit code ${code}).`);
        releaseJob(job);
      }
      return;
    }

    try {
      const files = await fsp.readdir(job.dir);
      const stats = [];
      for (const name of files) {
        if (/\.(part|ytdl|temp)$/i.test(name)) continue;
        const fullPath = path.join(job.dir, name);
        const stat = await fsp.stat(fullPath);
        if (stat.isFile() && stat.size > 0) stats.push({ fullPath, name, size: stat.size });
      }
      stats.sort((a, b) => b.size - a.size);
      if (!stats.length) throw new Error("No output file was produced.");

      const file = stats[0];
      job.status = "done";
      job.progress = 100;
      job.speed = 0;
      job.filePath = file.fullPath;
      job.filename = file.name;
      job.size = file.size;
      job.updatedAt = Date.now();
    } catch (error) {
      job.status = "error";
      job.error = friendlyError(error.message, "The file could not be located after downloading.");
    } finally {
      releaseJob(job);
    }
  });
}

function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    progress: job.status === "done" ? 100 : Math.round(job.progress * 10) / 10,
    speed: job.speed,
    eta: job.eta,
    size: job.size,
    filename: job.filename,
    error: job.error,
  };
}

/* ------------------------------------------------------------------ */
/* file streaming                                                      */
/* ------------------------------------------------------------------ */

const FILE_TYPES = {
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".opus": "audio/opus",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".mov": "video/quicktime",
};

async function serveJobFile(req, res, job) {
  if (!job.filePath) {
    sendJson(res, 409, { error: "The file is not ready yet." });
    return;
  }

  let stat;
  try {
    stat = await fsp.stat(job.filePath);
  } catch {
    sendJson(res, 410, { error: "The file has expired. Download it again." });
    return;
  }

  const ext = path.extname(job.filePath).toLowerCase();
  const name = job.filename || path.basename(job.filePath);
  const asciiName = name.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "'");
  const headers = {
    "Content-Type": FILE_TYPES[ext] || "application/octet-stream",
    "Content-Disposition": `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    "Cache-Control": "no-store",
    "Accept-Ranges": "bytes",
  };

  const range = req.headers.range;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
    if (!match) {
      res.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
      res.end();
      return;
    }
    let start = match[1] === "" ? null : Number(match[1]);
    let end = match[2] === "" ? null : Number(match[2]);
    if (start === null && end === null) {
      res.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
      res.end();
      return;
    }
    if (start === null) {
      start = Math.max(0, stat.size - end);
      end = stat.size - 1;
    } else {
      end = end === null ? stat.size - 1 : Math.min(end, stat.size - 1);
    }
    if (start > end || start >= stat.size) {
      res.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
      res.end();
      return;
    }
    headers["Content-Range"] = `bytes ${start}-${end}/${stat.size}`;
    headers["Content-Length"] = end - start + 1;
    res.writeHead(206, headers);
    fs.createReadStream(job.filePath, { start, end }).pipe(res);
    return;
  }

  headers["Content-Length"] = stat.size;
  res.writeHead(200, headers);
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  fs.createReadStream(job.filePath).pipe(res);
}

/* ------------------------------------------------------------------ */
/* routing                                                             */
/* ------------------------------------------------------------------ */

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "SAMEORIGIN",
  "Content-Security-Policy":
    "default-src 'self'; img-src 'self' data: http: https:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'; connect-src 'self'",
};

const server = http.createServer(async (req, res) => {
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    res.setHeader(key, value);
  }

  let requestUrl;
  try {
    requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  } catch {
    sendJson(res, 400, { error: "Bad request." });
    return;
  }

  const { pathname } = requestUrl;
  const ip = clientIp(req);

  try {
    /* health ------------------------------------------------------- */
    if (pathname === "/api/health" && req.method === "GET") {
      const tools = getTools();
      sendJson(res, 200, {
        ok: Boolean(tools.ytdlp),
        ytdlp: tools.ytdlp ? tools.ytdlp.version : null,
        ffmpeg: Boolean(tools.ffmpeg),
        fileTtlMinutes: FILE_TTL_MS / 60000,
      });
      return;
    }

    /* info --------------------------------------------------------- */
    if (pathname === "/api/info" && req.method === "POST") {
      if (!allow(ip, 20)) {
        sendJson(res, 429, { error: "Too many requests. Wait a minute and try again." });
        return;
      }
      const body = await readJson(req);
      const target = parseTarget(body.url);
      if (target.error) {
        sendJson(res, 400, { error: target.error });
        return;
      }
      const data = await fetchInfo(target.url);
      sendJson(res, 200, data);
      return;
    }

    /* download ----------------------------------------------------- */
    if (pathname === "/api/download" && req.method === "POST") {
      if (!allow(ip, 12)) {
        sendJson(res, 429, { error: "Too many downloads. Wait a minute and try again." });
        return;
      }
      if ((activePerIp.get(ip) || 0) >= MAX_JOBS_PER_IP) {
        sendJson(res, 429, { error: "Two downloads are already running. Wait for one to finish." });
        return;
      }

      const body = await readJson(req);
      const target = parseTarget(body.url);
      if (target.error) {
        sendJson(res, 400, { error: target.error });
        return;
      }

      const type = body.type === "mp3" ? "mp3" : "mp4";
      const quality =
        type === "mp3"
          ? AUDIO_BITRATES.includes(Number(body.quality))
            ? Number(body.quality)
            : 320
          : clampNumber(body.quality, 144, 2160, 1080);

      const tools = getTools();
      if (!tools.ytdlp) {
        sendJson(res, 503, {
          error: "yt-dlp is not installed on this machine.",
          hint: "Install yt-dlp, restart the server, then reload this page.",
        });
        return;
      }

      const job = createJob(ip, { target: target.url, type, quality });
      sendJson(res, 202, { id: job.id, status: job.status });
      runJob(job).catch((error) => {
        job.status = "error";
        job.error = friendlyError(error.message, "The download failed unexpectedly.");
        releaseJob(job);
      });
      return;
    }

    /* job status --------------------------------------------------- */
    const jobMatch = pathname.match(/^\/api\/jobs\/([a-f0-9]{18})(\/file)?$/);
    if (jobMatch) {
      const job = jobs.get(jobMatch[1]);
      if (!job) {
        sendJson(res, 404, { error: "That download has expired." });
        return;
      }

      if (jobMatch[2]) {
        if (req.method !== "GET" && req.method !== "HEAD") {
          sendJson(res, 405, { error: "Method not allowed." });
          return;
        }
        await serveJobFile(req, res, job);
        return;
      }

      if (req.method === "GET") {
        sendJson(res, 200, publicJob(job));
        return;
      }

      if (req.method === "DELETE") {
        jobs.delete(job.id);
        await fsp.rm(job.dir, { recursive: true, force: true }).catch(() => {});
        sendJson(res, 200, { deleted: true });
        return;
      }

      sendJson(res, 405, { error: "Method not allowed." });
      return;
    }

    if (pathname.startsWith("/api/")) {
      sendJson(res, 404, { error: "Unknown API endpoint." });
      return;
    }

    /* static ------------------------------------------------------- */
    if (req.method === "GET" || req.method === "HEAD") {
      await serveStatic(req, res, pathname);
      return;
    }

    res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Method not allowed");
  } catch (error) {
    const status = error.status || 500;
    sendJson(res, status, {
      error: error.message || "Unexpected server error.",
      ...(error.hint ? { hint: error.hint } : {}),
    });
  }
});

/* ------------------------------------------------------------------ */
/* cleanup + boot                                                      */
/* ------------------------------------------------------------------ */

async function cleanup() {
  const cutoff = Date.now() - FILE_TTL_MS;
  for (const [id, job] of jobs) {
    if (job.updatedAt < cutoff && !job.child) {
      jobs.delete(id);
      await fsp.rm(job.dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

async function boot() {
  await fsp.rm(WORK_DIR, { recursive: true, force: true }).catch(() => {});
  await fsp.mkdir(WORK_DIR, { recursive: true }).catch(() => {});

  const tools = getTools(true);

  server.listen(PORT, HOST, () => {
    console.log("");
    console.log("  mono. — download video & audio");
    console.log(`  http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`);
    console.log("");
    console.log(`  yt-dlp  ${tools.ytdlp ? tools.ytdlp.version + "  (" + tools.ytdlp.command + ")" : "NOT FOUND — install it to enable downloads"}`);
    console.log(`  ffmpeg  ${tools.ffmpeg ? "found" : "NOT FOUND — needed for MP3 and high-res MP4"}`);
    console.log(`  files   deleted after ${FILE_TTL_MS / 60000} minutes`);
    console.log("");
  });
}

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use. Try: PORT=3001 node server.js`);
  } else {
    console.error(error);
  }
  process.exit(1);
});

setInterval(cleanup, 10 * 60 * 1000).unref();

process.on("SIGINT", () => {
  server.close(() => process.exit(0));
});

boot();
