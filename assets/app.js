/* ============================================================
   mono. — front end
   ============================================================ */

(() => {
  "use strict";

  const $ = (sel, root = document) => root.querySelector(sel);

  const els = {
    form: $("#download-form"),
    card: $(".card"),
    url: $("#url"),
    paste: $("#paste-btn"),
    quality: $("#quality"),
    segBtns: Array.from(document.querySelectorAll(".seg-btn")),
    submit: $("#submit-btn"),
    ctaLabel: $("#cta-label"),
    hint: $("#hint"),
    status: $("#status"),
    statusText: $("#status-text"),
    pill: $("#platform-pill"),
    pillName: $("#platform-name"),
    preview: $("#preview"),
    thumb: $("#thumb-img"),
    thumbFallback: $("#thumb-fallback"),
    thumbInitial: $("#thumb-initial"),
    duration: $("#preview-duration"),
    kicker: $("#preview-kicker"),
    title: $("#preview-title"),
    meta: $("#preview-meta"),
    progressRow: $("#progress-row"),
    progressTrack: $("#progress-track"),
    progressFill: $("#progress-fill"),
    progressText: $("#progress-text"),
    actions: $("#preview-actions"),
    save: $("#save-btn"),
    saveLabel: $("#save-label"),
    note: $("#preview-note"),
    theme: $("#theme-toggle"),
    nav: $(".nav"),
    year: $("#year"),
  };

  const MP4_HEIGHTS = [2160, 1440, 1080, 720, 480, 360, 240];
  const MP3_BITRATES = [320, 256, 192, 128];

  const PLATFORMS = [
    { name: "YouTube", hosts: ["youtube.com", "youtu.be", "youtube-nocookie.com"] },
    { name: "TikTok", hosts: ["tiktok.com"] },
    { name: "Instagram", hosts: ["instagram.com"] },
    { name: "X", hosts: ["x.com", "twitter.com"] },
    { name: "Facebook", hosts: ["facebook.com", "fb.watch"] },
    { name: "Vimeo", hosts: ["vimeo.com"] },
    { name: "SoundCloud", hosts: ["soundcloud.com", "snd.sc"] },
    { name: "Reddit", hosts: ["reddit.com", "redd.it"] },
    { name: "Twitch", hosts: ["twitch.tv"] },
    { name: "Dailymotion", hosts: ["dailymotion.com", "dai.ly"] },
    { name: "Pinterest", hosts: ["pinterest.com", "pin.it"] },
    { name: "LinkedIn", hosts: ["linkedin.com"] },
    { name: "Snapchat", hosts: ["snapchat.com"] },
    { name: "Bilibili", hosts: ["bilibili.com", "b23.tv"] },
  ];

  const state = {
    type: "mp4",
    quality: 1080,
    info: null,
    infoUrl: "",
    demo: false,
    busy: false,
    jobId: null,
    fileUrl: "",
    health: null,
    infoController: null,
    pollTimer: null,
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /* ---------------- helpers ---------------- */

  function normalizeUrl(raw) {
    const text = String(raw || "").trim();
    if (!text) return "";
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
    try {
      const url = new URL(withScheme);
      if (!/^https?:$/.test(url.protocol)) return "";
      if (!url.hostname.includes(".")) return "";
      return url.href;
    } catch {
      return "";
    }
  }

  function platformFor(raw) {
    try {
      const host = new URL(raw).hostname.replace(/^www\./i, "").toLowerCase();
      for (const platform of PLATFORMS) {
        if (platform.hosts.some((h) => host === h || host.endsWith(`.${h}`))) {
          return platform.name;
        }
      }
      return "Web";
    } catch {
      return null;
    }
  }

  function formatDuration(total) {
    const seconds = Math.max(0, Math.round(Number(total) || 0));
    if (!seconds) return "";
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  function formatBytes(bytes) {
    const n = Number(bytes);
    if (!Number.isFinite(n) || n <= 0) return "";
    const units = ["B", "KB", "MB", "GB"];
    let value = n;
    let i = 0;
    while (value >= 1024 && i < units.length - 1) {
      value /= 1024;
      i += 1;
    }
    const decimals = value >= 100 || i === 0 ? 0 : value >= 10 ? 1 : 2;
    return `${value.toFixed(decimals)} ${units[i]}`;
  }

  function estimatedSize() {
    const { info, type, quality } = state;
    if (!info) return "";
    if (type === "mp4") {
      const size = info.sizes && info.sizes[quality];
      return size ? `~${formatBytes(size)}` : "";
    }
    const size = info.audioSize || (info.duration ? (info.duration * quality * 1000) / 8 : 0);
    return size ? `~${formatBytes(size)}` : "";
  }

  function showStatus(kind, message) {
    els.status.hidden = false;
    els.status.dataset.kind = kind;
    els.statusText.textContent = message;
  }

  function clearStatus() {
    els.status.hidden = true;
    els.statusText.textContent = "";
    delete els.status.dataset.kind;
  }

  function setBusy(busy) {
    state.busy = busy;
    els.submit.disabled = busy;
    els.url.readOnly = busy;
    els.quality.disabled = busy;
    els.segBtns.forEach((btn) => {
      btn.disabled = busy;
    });
    els.ctaLabel.textContent = busy ? "Preparing…" : "Download";
    els.submit.classList.toggle("is-busy", busy);
    if (busy) {
      els.save.disabled = true;
      els.save.classList.remove("is-ready");
      els.saveLabel.textContent = "Preparing…";
    }
  }

  function restoreCta() {
    setBusy(false);
    els.submit.classList.remove("is-busy");
    els.ctaLabel.textContent = "Download";
    if (state.fileUrl) {
      els.saveLabel.textContent = "Save file";
    }
  }

  function setHint() {
    const size = estimatedSize();
    const suffix = size ? ` · ${size}` : "";
    const unknownQuality =
      state.type === "mp4" && state.info && availableHeights().length === 0;
    els.hint.textContent =
      state.type === "mp4"
        ? `MP4 · ${unknownQuality ? "best available" : `${state.quality}p`}${suffix}`
        : `MP3 · ${state.quality} kbps${suffix} · converted audio`;
  }

  /* ---------------- quality ---------------- */

  function availableHeights() {
    if (!state.info) return MP4_HEIGHTS.filter((h) => h <= 2160);
    const fromInfo = Array.isArray(state.info.heights) ? state.info.heights : [];
    return Array.from(new Set(fromInfo.map(Number).filter((h) => Number.isFinite(h) && h > 0)))
      .sort((a, b) => b - a)
      .filter((h) => h <= 2160 && h >= 144);
  }

  function buildQualityOptions() {
    const previous = state.quality;
    let options;

    if (state.type === "mp4") {
      const heights = availableHeights();
      if (state.info && heights.length === 0) {
        options = [{ value: "2160", label: "Best available" }];
        state.quality = 2160;
      } else {
        options = heights.map((h) => ({
          value: String(h),
          label: h === 2160 ? "2160p · 4K" : h === 1440 ? "1440p · 2K" : `${h}p`,
        }));
        const preferred = options.some((o) => o.value === "1080")
          ? 1080
          : Number(options[0] ? options[0].value : 720);
        state.quality = options.some((o) => Number(o.value) === previous) ? previous : preferred;
      }
    } else {
      options = MP3_BITRATES.map((kbps) => ({ value: String(kbps), label: `${kbps} kbps` }));
      state.quality = MP3_BITRATES.includes(previous) ? previous : 320;
    }

    els.quality.innerHTML = "";
    for (const option of options) {
      const el = document.createElement("option");
      el.value = option.value;
      el.textContent = option.label;
      els.quality.append(el);
    }
    els.quality.value = String(state.quality);
    setHint();
  }

  /* ---------------- preview ---------------- */

  function ensurePreview() {
    els.preview.hidden = false;
  }

  function renderPlaceholder(platformName) {
    ensurePreview();
    els.kicker.textContent = platformName || "Link";
    els.title.textContent = "Reading the link…";
    els.meta.textContent = "Just a moment";
    els.thumb.classList.add("is-broken");
    els.thumbFallback.hidden = false;
    els.thumbInitial.textContent = (platformName || "M").charAt(0).toUpperCase();
    els.duration.hidden = true;
    els.progressRow.hidden = true;
    els.actions.hidden = true;
    els.save.hidden = true;
    els.preview.classList.remove("has-file");
  }

  function renderInfo(info) {
    ensurePreview();
    els.kicker.textContent = `${info.platform || platformFor(state.url) || "Web"}${info.demo ? " · preview" : ""}`;
    els.title.textContent = info.title || "Untitled media";
    const bits = [info.uploader, formatDuration(info.duration)].filter(Boolean);
    els.meta.textContent = bits.join(" · ") || "Ready to download";

    if (info.duration) {
      els.duration.hidden = false;
      els.duration.textContent = formatDuration(info.duration);
    } else {
      els.duration.hidden = true;
    }

    const thumbSource = info.thumbnail || "";
    els.thumb.classList.remove("is-broken");
    els.thumbFallback.hidden = false;
    els.thumbInitial.textContent = (info.platform || "M").charAt(0).toUpperCase();

    if (thumbSource) {
      els.thumb.onerror = () => {
        els.thumb.classList.add("is-broken");
        els.thumbFallback.hidden = false;
      };
      els.thumb.onload = () => {
        els.thumbFallback.hidden = true;
      };
      els.thumb.src = thumbSource;
    } else {
      els.thumb.removeAttribute("src");
      els.thumb.classList.add("is-broken");
    }
  }

  function resetPreview() {
    els.preview.hidden = true;
    els.progressRow.hidden = true;
    els.progressFill.style.width = "0%";
    els.progressText.textContent = "0%";
    els.progressTrack.setAttribute("aria-valuenow", "0");
    els.actions.hidden = true;
    els.save.hidden = true;
    els.save.disabled = true;
    els.saveLabel.textContent = "Save file";
    els.preview.classList.remove("has-file");
    els.duration.hidden = true;
    els.thumb.removeAttribute("src");
    els.thumb.classList.remove("is-broken");
    state.fileUrl = "";
    state.jobId = null;
  }

  /* ---------------- info ---------------- */

  async function loadInfo(url, platformName) {
    if (state.busy) return;

    if (state.info && state.infoUrl === url) {
      renderInfo(state.info);
      return;
    }

    if (state.infoController) state.infoController.abort();
    const controller = new AbortController();
    state.infoController = controller;

    renderPlaceholder(platformName);
    clearStatus();

    try {
      let info;

      if (state.demo) {
        await sleep(850);
        if (controller.signal.aborted) return;
        info = demoInfo(platformName);
      } else {
        const response = await fetch("/api/info", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url }),
          signal: controller.signal,
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(data.hint ? `${data.error} ${data.hint}` : data.error || "That link could not be read.");
        }
        info = data;
      }

      if (controller.signal.aborted) return;
      state.info = info;
      state.infoUrl = url;
      state.infoController = null;
      info.platform = info.platform || platformName;
      buildQualityOptions();
      renderInfo(info);
    } catch (error) {
      if (error.name === "AbortError") return;
      state.info = null;
      state.infoUrl = "";
      state.infoController = null;
      els.preview.hidden = true;
      showStatus("error", error.message || "That link could not be read. Check the URL and try again.");
    }
  }

  let infoTimer = 0;

  function onUrlChanged() {
    if (state.busy) return;

    const url = normalizeUrl(els.url.value);
    const platformName = url ? platformFor(url) : null;

    if (platformName) {
      els.pill.hidden = false;
      els.pillName.textContent = platformName;
    } else {
      els.pill.hidden = true;
    }

    window.clearTimeout(infoTimer);
    state.infoController?.abort();

    if (!url) {
      state.info = null;
      state.infoUrl = "";
      resetPreview();
      clearStatus();
      setHint();
      return;
    }

    if (state.infoUrl && state.infoUrl !== url) {
      state.info = null;
      resetPreview();
    }

    infoTimer = window.setTimeout(() => loadInfo(url, platformName || "Web"), 550);
  }

  /* ---------------- demo ---------------- */

  function demoCover(platform) {
    const label = String(platform || "WEB").toUpperCase().replace(/[<>&"]/g, "");
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180">
      <rect width="320" height="180" fill="#0c0c0c"/>
      <g fill="none" stroke="#ffffff" stroke-opacity=".2">
        <circle cx="162" cy="92" r="30"/><circle cx="162" cy="92" r="56"/><circle cx="162" cy="92" r="84"/>
      </g>
      <path d="M0 180 320 0" stroke="#ffffff" stroke-opacity=".12"/>
      <path d="M162 74v36m0 0 13-13m-13 13-13-13" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
      <text x="18" y="28" fill="#ffffff" font-family="monospace" font-size="9" letter-spacing="3">MONO / PREVIEW</text>
      <text x="18" y="164" fill="#ffffff" fill-opacity=".5" font-family="monospace" font-size="8" letter-spacing="2">${label}</text>
    </svg>`;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  }

  function demoInfo(platformName) {
    return {
      title: "A quiet walk through the city — a short film in 4K",
      uploader: "Studio Mono",
      duration: 272,
      thumbnail: demoCover(platformName),
      heights: [2160, 1440, 1080, 720, 480, 360],
      sizes: {
        2160: 412 * 1024 * 1024,
        1440: 268 * 1024 * 1024,
        1080: 148 * 1024 * 1024,
        720: 89 * 1024 * 1024,
        480: 47 * 1024 * 1024,
        360: 25 * 1024 * 1024,
      },
      audioSize: (272 * 320 * 1000) / 8,
      platform: platformName,
      demo: true,
    };
  }

  function setDemo(enabled) {
    state.demo = enabled;
    els.note.hidden = !enabled;
    if (enabled) {
      document.body.dataset.demo = "true";
      if (!els.url.value) {
        els.url.value = "https://www.youtube.com/watch?v=mono-preview";
        onUrlChanged();
      }
    }
  }

  async function runDemoDownload() {
    setBusy(true);
    ensurePreview();
    if (!state.info) {
      renderPlaceholder("Web");
    }
    clearStatus();

    els.progressRow.hidden = false;
    els.actions.hidden = true;
    els.save.hidden = true;
    els.preview.classList.remove("has-file");

    const duration = 4200;
    const started = Date.now();

    await new Promise((resolve) => {
      const tick = () => {
        const elapsed = Date.now() - started;
        const t = Math.min(1, elapsed / duration);
        const eased = 1 - Math.pow(1 - t, 2.2);
        const percent = Math.round(eased * 100);
        updateProgress(percent, t > 0.72 ? "processing" : "downloading", t > 0.72 ? 0 : (2.4 * (1 - t * 0.3)) * 1024 * 1024);

        if (t < 1) {
          state.pollTimer = window.setTimeout(tick, 120);
        } else {
          resolve();
        }
      };
      tick();
    });

    const fakeJob = {
      size: state.type === "mp4" ? (state.info?.sizes?.[state.quality] || 0) : ((state.info?.duration || 272) * state.quality * 1000) / 8,
      filename: `mono-demo.${state.type}`,
    };

    finishJob(fakeJob, { demo: true });
  }

  /* ---------------- download ---------------- */

  function updateProgress(percent, status, speed) {
    const value = Math.max(0, Math.min(100, Number(percent) || 0));
    els.progressRow.hidden = false;
    els.progressFill.style.width = `${value}%`;
    els.progressTrack.setAttribute("aria-valuenow", String(Math.round(value)));
    els.progressText.textContent = status === "processing" ? "…" : `${Math.round(value)}%`;

    if (state.info) {
      if (status === "processing") {
        els.meta.textContent = "Processing the file…";
      } else if (speed) {
        els.meta.textContent = `${formatBytes(speed)}/s`;
      }
    }
  }

  async function startDownload() {
    if (state.busy) return;

    const url = normalizeUrl(els.url.value);
    if (!url) {
      showStatus("error", "Paste a valid link first — copy it straight from your browser’s address bar.");
      els.url.focus();
      els.card.classList.remove("shake");
      void els.card.offsetWidth;
      els.card.classList.add("shake");
      return;
    }

    if (url !== state.infoUrl) {
      state.info = null;
      state.infoUrl = "";
    }

    clearStatus();
    setBusy(true);
    ensurePreview();
    state.fileUrl = "";
    els.actions.hidden = true;
    els.save.hidden = true;
    els.preview.classList.remove("has-file");
    if (!state.info) {
      renderPlaceholder(platformFor(url) || "Web");
      els.title.textContent = "Preparing your file…";
    }

    els.progressRow.hidden = false;
    updateProgress(0, "queued", 0);

    if (state.demo) {
      state.info = state.info || demoInfo(platformFor(url) || "Web");
      await runDemoDownload();
      return;
    }

    try {
      const response = await fetch("/api/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, type: state.type, quality: state.quality }),
      });
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(data.hint ? `${data.error} ${data.hint}` : data.error || "The download could not be started.");
      }

      state.jobId = data.id;
      pollJob(data.id);
    } catch (error) {
      failDownload(error.message);
    }
  }

  async function pollJob(id) {
    let misses = 0;

    while (state.jobId === id) {
      await sleep(750);
      if (state.jobId !== id) return;

      try {
        const response = await fetch(`/api/jobs/${id}`);
        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          throw new Error(data.error || "The download job disappeared.");
        }
        const job = await response.json();
        misses = 0;
        updateProgress(job.progress, job.status, job.speed);

        if (job.status === "done") {
          finishJob(job);
          return;
        }
        if (job.status === "error") {
          failDownload(job.error || "The download failed.");
          return;
        }
      } catch (error) {
        misses += 1;
        if (misses >= 4) {
          failDownload(error.message);
          return;
        }
      }
    }
  }

  function finishJob(job, options = {}) {
    state.jobId = null;
    restoreCta();

    els.progressFill.style.width = "100%";
    els.progressTrack.setAttribute("aria-valuenow", "100");
    els.progressText.textContent = "100%";
    window.setTimeout(() => {
      els.progressRow.hidden = true;
    }, 900);

    if (!options.demo) {
      state.fileUrl = `/api/jobs/${job.id}/file`;
    }

    const sizeLabel = formatBytes(job.size);
    els.save.disabled = false;
    els.save.classList.add("is-ready");
    els.saveLabel.textContent = "Save file";
    els.meta.textContent = options.demo
      ? "Preview only — nothing was saved"
      : `Ready${sizeLabel ? ` · ${sizeLabel}` : ""} · saved to your downloads`;

    if (options.demo) {
      els.actions.hidden = true;
      els.save.hidden = true;
      els.preview.classList.remove("has-file");
      showStatus("info", "Preview complete. There is no real file — start the local server to download media.");
      return;
    }

    els.actions.hidden = false;
    els.save.hidden = false;
    els.preview.classList.add("has-file");
    showStatus("success", "Ready. Your download should begin now — use Save file if it doesn’t.");
    autoDownload(state.fileUrl);
  }

  function failDownload(message) {
    state.jobId = null;
    restoreCta();
    els.progressRow.hidden = true;
    els.actions.hidden = true;
    els.save.hidden = true;
    els.preview.classList.remove("has-file");
    els.meta.textContent = state.info ? [state.info.uploader, formatDuration(state.info.duration)].filter(Boolean).join(" · ") : "Just a moment";
    showStatus("error", message || "Something went wrong. Try again.");
    els.card.classList.remove("shake");
    void els.card.offsetWidth;
    els.card.classList.add("shake");
  }

  function autoDownload(href) {
    try {
      const link = document.createElement("a");
      link.href = href;
      link.download = "";
      link.rel = "noopener";
      document.body.append(link);
      link.click();
      link.remove();
    } catch {
      /* the Save file button remains available */
    }
  }

  /* ---------------- theme ---------------- */

  function applyTheme(theme) {
    const next = theme === "dark" ? "dark" : "light";
    document.documentElement.dataset.theme = next;
    els.theme.setAttribute("aria-pressed", String(next === "dark"));
    els.theme.setAttribute("aria-label", next === "dark" ? "Switch to light theme" : "Switch to dark theme");
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", next === "dark" ? "#000000" : "#ffffff");
    try {
      localStorage.setItem("mono:theme", next);
    } catch {
      /* private mode */
    }
  }

  function initTheme() {
    let stored = null;
    try {
      stored = localStorage.getItem("mono:theme");
    } catch {
      stored = null;
    }
    applyTheme(stored === "dark" ? "dark" : "light");
  }

  /* ---------------- boot ---------------- */

  async function checkHealth() {
    try {
      const response = await fetch("/api/health", { signal: AbortSignal.timeout(4000) });
      if (!response.ok) throw new Error("offline");
      const health = await response.json();
      state.health = health;

      if (!health.ok) {
        showStatus(
          "info",
          "yt-dlp was not found on this machine, so links can’t be read yet. Install yt-dlp, restart the server, and reload. See the setup guide."
        );
      } else if (health.ffmpeg === false) {
        showStatus("info", "ffmpeg was not found — MP3 conversion and 1080p+ MP4 merging will fail. Install ffmpeg and restart the server.");
      }
    } catch {
      setDemo(true);
    }
  }

  function initReveal() {
    const items = document.querySelectorAll("[data-reveal]");
    if (!("IntersectionObserver" in window)) {
      items.forEach((item) => item.classList.add("is-in"));
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-in");
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.12, rootMargin: "0px 0px -40px" }
    );
    items.forEach((item) => observer.observe(item));
  }

  function bindEvents() {
    els.form.addEventListener("submit", (event) => {
      event.preventDefault();
      startDownload();
    });

    els.url.addEventListener("input", onUrlChanged);

    els.paste.addEventListener("click", async () => {
      try {
        const text = await navigator.clipboard.readText();
        if (!text) {
          showStatus("info", "Your clipboard is empty. Copy a link first.");
          return;
        }
        els.url.value = text.trim();
        onUrlChanged();
        els.url.focus();
      } catch {
        showStatus("info", "Clipboard access was blocked — paste with Ctrl+V (⌘V on Mac).");
        els.url.focus();
      }
    });

    els.segBtns.forEach((btn) => {
      btn.addEventListener("click", () => {
        if (state.busy || btn.dataset.type === state.type) return;
        state.type = btn.dataset.type;
        els.segBtns.forEach((b) => {
          const active = b === btn;
          b.classList.toggle("is-active", active);
          b.setAttribute("aria-pressed", String(active));
        });
        buildQualityOptions();
        clearStatus();
      });
    });

    els.quality.addEventListener("change", () => {
      state.quality = Number(els.quality.value);
      setHint();
    });

    els.theme.addEventListener("click", () => {
      applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
    });

    els.save.addEventListener("click", () => {
      if (state.busy) return;
      if (state.demo && !state.fileUrl) {
        showStatus("info", "This is a preview — there is no file. Run `node server.js` to enable real downloads.");
        return;
      }
      if (state.fileUrl) {
        autoDownload(state.fileUrl);
      } else if (state.info) {
        startDownload();
      }
    });

    window.addEventListener(
      "scroll",
      () => {
        els.nav.classList.toggle("is-scrolled", window.scrollY > 8);
      },
      { passive: true }
    );

    window.addEventListener("beforeunload", () => {
      state.infoController?.abort();
    });
  }

  function init() {
    initTheme();
    bindEvents();
    initReveal();
    els.year.textContent = String(new Date().getFullYear());
    buildQualityOptions();
    checkHealth();
  }

  init();
})();
