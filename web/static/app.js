/* ONM Video Slicer: front end for the scene-segmentation demo.
   Plain JS, no dependencies. Add ?mock=1 to the URL to run against fake data. */
(() => {
  "use strict";

  const MOCK = new URLSearchParams(location.search).has("mock");
  const POLL_MS = 700;
  const MAX_BYTES = 60 * 1024 * 1024;
  const OK_EXT = /\.(mp4|mov|webm)$/i;
  const PALETTE = [
    "#3cc8b4", // teal
    "#f0a23b", // amber
    "#f2735a", // coral
    "#a8d65a", // lime
    "#5ab4f0", // sky
    "#e8506a", // rose red
    "#d9c08c", // sand
    "#7de0b0", // mint
    "#f58a3c", // orange
    "#4fd6e8", // cyan
    "#c9cf5a", // olive
    "#f0c75a", // gold
  ];
  const STAGES = ["Waiting for a turn", "Reading the video", "Choosing pictures to compare", "Making details clearer", "Comparing visual details", "Grouping similar pictures", "Locating scene changes", "Preparing your scenes"];
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const $ = (s, r = document) => r.querySelector(s);
  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const colour = (label) => PALETTE[((Number(label) || 0) % PALETTE.length + PALETTE.length) % PALETTE.length];
  const segLabel = (s) => (s.label ?? s.cluster ?? s.id);
  // Early cached samples predate the /run/web media layout. Live jobs already use it.
  const sampleAsset = (url) => String(url || "").replace(/^(\/files\/sample-[^/]+)\/web\//, "$1/run/web/");

  function fmtTime(s) {
    s = Math.max(0, Number(s) || 0);
    const m = Math.floor(s / 60);
    const r = s - m * 60;
    return `${String(m).padStart(2, "0")}:${r.toFixed(1).padStart(4, "0")}`;
  }
  function fmtNum(n, d = 0) {
    if (n == null || Number.isNaN(Number(n))) return "n/a";
    return Number(n).toLocaleString("en-IN", { maximumFractionDigits: d, minimumFractionDigits: d });
  }

  /* ---------------- elements ---------------- */
  const ui = {
    body: document.body,
    samples: $("#samples"),
    drop: $("#drop"),
    file: $("#file"),
    panel: $("#runPanel"),
    title: $("#runTitle"),
    status: $("#runStatus"),
    stepper: $("#stepper"),
    bar: $("#progressBar"),
    log: $("#log"),
    queue: $("#runQueue"),
    cancel: $("#cancelBtn"),
    results: $("#results"),
    resTitle: $("#resTitle"),
    resEyebrow: $("#resEyebrow"),
    reset: $("#resetBtn"),
    video: $("#video"),
    videoMock: $("#videoMock"),
    videoMockText: $("#videoMockText"),
    tlTrack: $("#tlTrack"),
    tlHead: $("#tlHead"),
    tlScale: $("#tlScale"),
    now: $("#nowLine"),
    metrics: $("#metrics"),
    scenes: $("#scenes"),
    novelty: $("#novelty"),
    scatter: $("#scatter"),
    sawOrig: $("#sawOrig"),
    sawRed: $("#sawRed"),
    sawEnh: $("#sawEnh"),
    toast: $("#toast"),
    summary: $("#resultSummary"),
    technical: $("#technical"),
    preview: $("#previewContent"),
  };

  const state = { jobId: null, pollTimer: null, pollFails: 0, result: null, duration: 0, current: -1, runToken: 0 };

  /* ---------------- toast ---------------- */
  let toastTimer = null;
  function toast(msg) {
    ui.toast.textContent = msg;
    ui.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { ui.toast.hidden = true; }, 6000);
  }
  ui.toast.addEventListener("click", () => { ui.toast.hidden = true; });

  /* ---------------- API ---------------- */
  async function api(path, opts = {}) {
    if (MOCK) return mockApi(path, opts);
    const res = await fetch(path, opts);
    let data = null;
    try { data = await res.json(); } catch (_) { /* not json */ }
    if (!res.ok) {
      const detail = data && (typeof data.detail === "string" ? data.detail : JSON.stringify(data.detail));
      throw new Error(detail || `Server returned ${res.status}`);
    }
    return data;
  }

  function uploadFile(file, onProgress) {
    if (MOCK) return mockApi("/api/jobs", { method: "POST", file });
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const fd = new FormData();
      fd.append("file", file, file.name);
      xhr.open("POST", "/api/jobs");
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
      xhr.onload = () => {
        let data = null;
        try { data = JSON.parse(xhr.responseText); } catch (_) { /* ignore */ }
        if (xhr.status >= 200 && xhr.status < 300 && data) resolve(data);
        else reject(new Error((data && data.detail) || `Upload failed (HTTP ${xhr.status})`));
      };
      xhr.onerror = () => reject(new Error("Upload failed: the server could not be reached."));
      xhr.send(fd);
    });
  }

  /* ---------------- samples ---------------- */
  async function loadSamples() {
    try {
      const list = await api("/api/samples");
      ui.samples.innerHTML = "";
      if (!list || !list.length) {
        ui.samples.append(el("p", "samples-empty", "No sample clips on this machine. Upload a video below."));
        return;
      }
      list.sort((a, b) => Number(b.id === "sintel") - Number(a.id === "sintel"));
      list.forEach((s, i) => {
        const b = el("button", "sample");
        b.type = "button";
        b.style.setProperty("--c", PALETTE[i % PALETTE.length]);
        b.innerHTML = `<span class="sample-poster" hidden></span><span class="sample-body"><span class="sample-title">${esc(s.title || s.id)}</span>
          <span class="sample-meta"><span>${s.duration ? fmtNum(s.duration, 0) + " seconds" : "Short film"}</span>
          <span class="sample-run">Find scenes →</span></span></span>`;
        if (!MOCK && s.ready) {
          api(`/api/jobs/sample-${encodeURIComponent(s.id)}`).then((job) => {
            const r = job.result;
            if (!r?.segments?.length) return;
            const poster = r.segments[Math.floor(r.segments.length / 2)].thumb_url;
            const slot = b.querySelector(".sample-poster");
            slot.innerHTML = `<img src="${esc(sampleAsset(poster))}" alt="" loading="eager">`;
            slot.hidden = false;
            if (i === 0) renderPreview(r, s);
          }).catch(() => { if (i === 0) previewUnavailable(); });
        } else if (i === 0) previewUnavailable();
        b.setAttribute("aria-label", `Run ${s.title || s.id}`);
        b.addEventListener("click", () => startSample(s));
        ui.samples.append(b);
      });
    } catch (err) {
      ui.samples.innerHTML = "";
      ui.samples.append(el("p", "samples-empty", `Could not load sample clips: ${esc(err.message)}`));
    }
  }

  function previewUnavailable() {
    ui.preview.innerHTML = `<div class="preview-placeholder"><span class="preview-play" aria-hidden="true">▶</span><p>Choose a film to see its scenes.</p></div>`;
  }

  function renderPreview(r, sample) {
    const segs = r.segments;
    const indexes = [Math.min(1, segs.length - 1), Math.floor(segs.length / 2), Math.max(0, segs.length - 3)];
    const hero = segs[indexes[1]];
    ui.preview.innerHTML = `<div class="preview-video"><img src="${esc(sampleAsset(hero.thumb_url))}" alt="A frame from ${esc(sample.title)}"></div>
      <div class="preview-caption"><strong>One original video</strong><span>${esc(sample.title)}</span></div>
      <div class="preview-connector">${segs.length} scenes found in this film</div>
      <div class="preview-scenes">${indexes.map((idx) => `<div class="preview-scene"><img src="${esc(sampleAsset(segs[idx].thumb_url))}" alt="Preview of scene ${idx + 1}"><span>Scene ${idx + 1} · ${fmtTime(segs[idx].start_s)}</span></div>`).join("")}</div>`;
  }

  /* ---------------- run lifecycle ---------------- */
  function setBusy(on) {
    ui.body.classList.toggle("is-busy", on);
    ui.samples.querySelectorAll("button").forEach((b) => { b.disabled = on; });
    ui.file.disabled = on;
  }

  function resetPanel(title) {
    ui.panel.hidden = false;
    ui.panel.dataset.state = "queued";
    ui.title.textContent = title;
    ui.status.textContent = "Waiting";
    ui.bar.style.width = "0%";
    ui.queue.textContent = "";
    ui.cancel.hidden = true;
    ui.stepper.querySelectorAll("li").forEach((li) => { li.className = ""; li.style.removeProperty("--p"); });
    ui.log.textContent = "";
  }

  function logLines(lines) {
    ui.log.innerHTML = lines.slice(-200).map((l) => {
      const t = esc(l);
      if (/error|failed|traceback/i.test(l)) return `<span class="l-err">${t}</span>`;
      if (/done|finished|complete/i.test(l)) return `<span class="l-ok">${t}</span>`;
      return t;
    }).join("\n");
    ui.log.scrollTop = ui.log.scrollHeight;
  }

  function scrollToPanel() {
    ui.panel.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
  }

  async function startSample(s) {
    hideResults();
    resetPanel(`Finding scenes in ${s.title || s.id}`);
    setBusy(true);
    scrollToPanel();
    try {
      const { job_id } = await api(`/api/jobs/sample/${encodeURIComponent(s.id)}`, { method: "POST" });
      watch(job_id);
    } catch (err) {
      fail(err.message);
    }
  }

  async function startUpload(file) {
    if (!file) return;
    if (!OK_EXT.test(file.name) && !/^video\/(mp4|quicktime|webm)$/.test(file.type)) {
      toast("That file type is not supported. Use an MP4, MOV or WebM video.");
      return;
    }
    if (file.size > MAX_BYTES) {
      toast(`That video is ${(file.size / 1048576).toFixed(0)} MB. The limit is 60 MB, so trim it and try again.`);
      return;
    }
    hideResults();
    resetPanel(`Finding scenes in ${file.name}`);
    setBusy(true);
    scrollToPanel();
    ui.status.textContent = "Uploading";
    try {
      const { job_id } = await uploadFile(file, (p) => {
        ui.bar.style.width = `${(p * 100).toFixed(0)}%`;
        logLines([`$ upload ${file.name}`, `  ${(file.size / 1048576).toFixed(1)} MB  ${(p * 100).toFixed(0)}%`]);
      });
      ui.bar.style.width = "0%";
      watch(job_id);
    } catch (err) {
      fail(err.message);
    }
  }

  /* Pacing: the backend can finish a clip in a few seconds, so the stepper
     advances at most one stage per DWELL_MS and the log streams with it. */
  const DWELL_MS = 550;

  function watch(jobId) {
    state.jobId = jobId;
    state.pollFails = 0;
    const token = ++state.runToken;
    const pace = { latest: null, shown: 0, since: performance.now(), polling: true };
    const tick = async () => {
      if (token !== state.runToken || !pace.polling) return;
      try {
        const job = await api(`/api/jobs/${encodeURIComponent(jobId)}`);
        if (token !== state.runToken) return;
        state.pollFails = 0;
        if (job.status === "error") { fail(job.error || "The pipeline stopped with an error.", job); return; }
        pace.latest = job;
        if (job.status === "done") { pace.polling = false; return; }
      } catch (err) {
        state.pollFails += 1;
        if (state.pollFails >= 6) { fail(`Lost contact with the server: ${err.message}`); return; }
      }
      state.pollTimer = setTimeout(tick, POLL_MS);
    };
    const pacer = () => {
      if (token !== state.runToken) return;
      const job = pace.latest;
      if (job) {
        const now = performance.now();
        const real = job.status === "done" ? 8 : Math.max(0, Math.min(7, Number(job.stage) || 0));
        const dwell = reduceMotion ? 150 : DWELL_MS;
        if (pace.shown < real && (pace.shown === 0 || now - pace.since >= dwell)) { pace.shown += 1; pace.since = now; }
        if (pace.shown >= 8) { finish(job); return; }
        const shown = pace.shown;
        const catching = shown < real;
        const prog = catching ? Math.min(1, (now - pace.since) / dwell) : Number(job.progress) || 0;
        const realLog = Array.isArray(job.log) ? job.log : [];
        let log;
        if (realLog.length) {
          log = catching || job.status === "done" ? realLog.slice(0, Math.max(1, Math.round(realLog.length * shown / 7))) : realLog;
        } else {
          log = [];
          for (let k = 1; k <= shown; k++) log.push(`[${k}/7] ${STAGES[k]}${k < shown ? "  ok" : " ..."}`);
        }
        renderJob({ ...job, status: shown === 0 ? (job.status === "queued" ? "queued" : "running") : "running", stage: shown, stage_name: STAGES[shown], progress: prog, log });
      }
      state.pollTimer2 = setTimeout(pacer, 80);
    };
    tick();
    pacer();
  }

  function renderJob(job) {
    const stage = Math.max(0, Math.min(7, Number(job.stage) || 0));
    const prog = Math.max(0, Math.min(1, Number(job.progress) || 0));
    const status = job.status || "running";
    ui.panel.dataset.state = status === "done" ? "done" : status === "error" ? "error" : status === "queued" ? "queued" : "running";
    ui.status.textContent = ({queued: "Waiting", running: "Working", done: "Ready", error: "Please try again"})[status] || "Working";
    ui.stepper.querySelectorAll("li").forEach((li) => {
      const n = Number(li.dataset.s);
      li.className = "";
      li.style.removeProperty("--p");
      if (status === "done" || n < stage) li.classList.add("done");
      else if (n === stage) {
        li.classList.add(status === "error" ? "err" : "active");
        li.style.setProperty("--p", `${(prog * 100).toFixed(0)}%`);
      }
    });
    const overall = status === "done" ? 1 : stage === 0 ? 0 : ((stage - 1) + prog) / 7;
    ui.bar.style.width = `${(overall * 100).toFixed(1)}%`;
    if (status === "queued" && job.queue_position) ui.queue.textContent = `Position ${job.queue_position} in the queue`;
    else if (stage > 0 && status === "running") ui.queue.textContent = `Step ${stage} of 7: ${STAGES[stage]}`;
    else ui.queue.textContent = "";
    if (Array.isArray(job.log) && job.log.length) logLines(job.log);
  }

  function finish(job) {
    clearTimeout(state.pollTimer);
    clearTimeout(state.pollTimer2);
    state.runToken++;
    renderJob({ ...job, status: "done", stage: 7, progress: 1 });
    setBusy(false);
    ui.cancel.hidden = false;
    ui.panel.dataset.state = "done";
    ui.status.textContent = "Ready";
    const r = job.result;
    if (!r) { fail("The job finished but returned no result."); return; }
    ui.queue.textContent = `Finished in ${fmtNum(r.elapsed_s, 1)} s · ${r.segments ? r.segments.length : 0} scenes`;
    showResults(r);
  }

  function fail(msg, job) {
    clearTimeout(state.pollTimer);
    clearTimeout(state.pollTimer2);
    state.runToken++;
    setBusy(false);
    ui.panel.dataset.state = "error";
    ui.status.textContent = "Please try again";
    ui.cancel.hidden = false;
    const lines = (job && Array.isArray(job.log) ? job.log : ui.log.textContent.split("\n").filter(Boolean));
    logLines([...lines, `error: ${msg}`]);
    const friendly = /decode|invalid data|opening input|no frames|could not read/i.test(msg)
      ? "This video could not be read. Try another MP4, MOV or WebM file."
      : /four videos|429/i.test(msg)
      ? "The demo is busy with other videos. Please try again in a moment."
      : /lost contact|could not be reached|failed to fetch/i.test(msg)
      ? "The connection was interrupted. Please try your video again."
      : msg;
    ui.title.textContent = "Your video could not be processed";
    ui.queue.textContent = friendly;
    toast(friendly);
  }

  function resetAll() {
    clearTimeout(state.pollTimer);
    clearTimeout(state.pollTimer2);
    state.runToken++;
    state.jobId = null;
    setBusy(false);
    hideResults();
    ui.panel.dataset.state = "idle";
    ui.title.textContent = "Choose a video to begin";
    ui.status.textContent = "Ready";
    ui.panel.hidden = true;
    ui.bar.style.width = "0%";
    ui.queue.textContent = "";
    ui.cancel.hidden = true;
    ui.stepper.querySelectorAll("li").forEach((li) => { li.className = ""; });
    ui.log.textContent = "Choose a film or upload a video to begin.";
    ui.file.value = "";
    window.scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" });
  }

  /* ---------------- results ---------------- */
  function hideResults() {
    ui.results.hidden = true;
    ui.body.classList.remove("has-results");
    ui.technical.open = false;
    try { ui.video.pause(); } catch (_) { /* ignore */ }
    stopMockClock();
    state.result = null;
  }

  function showResults(r) {
    state.result = r;
    const segs = r.segments || [];
    const meta = r.meta || {};
    state.duration = Number(meta.duration) || (segs.length ? segs[segs.length - 1].end_s : 0) || 1;
    state.current = -1;

    ui.resEyebrow.textContent = `Result · ${r.name || "video"}`;
    ui.resTitle.textContent = `${segs.length} suggested scene${segs.length === 1 ? "" : "s"}`;
    ui.summary.innerHTML = `<span><strong>${segs.length}</strong> scenes found</span><span><strong>${fmtNum(state.duration, 1)} seconds</strong> of video</span><span><strong>${fmtNum(r.elapsed_s, 1)} seconds</strong> to process</span>`;

    renderMetrics(r);
    renderTimeline(segs);
    renderScenes(segs);
    ui.sawOrig.src = r.stages?.original_url || "";
    ui.sawRed.src = r.stages?.reduced_url || "";
    ui.sawEnh.src = r.stages?.enhanced_url || "";

    ui.results.hidden = false;
    ui.body.classList.add("has-results");
    setupPlayer(r);
    // charts need layout
    requestAnimationFrame(() => {
      updatePlayhead(0);
    });
    ui.results.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
  }

  function renderMetrics(r) {
    const o = r.onm || {};
    const m = r.meta || {};
    const items = [
      ["Initial groups (SDCO N)", fmtNum(o.N_centroids), "", "hl"],
      ["Final groups", fmtNum(o.N_clusters), "", "hl"],
      ["Within-group association A(C)", fmtNum(o.A, 1), "%", ""],
      ["Outside-group dissociation D(C)", fmtNum(o.D, 1), "%", ""],
      ["Similarity threshold (T)", fmtNum(o.T, 3), "", ""],
      ["Recurrence count (CC)", fmtNum(o.CC), "", ""],
      ["Validation limit (SL)", fmtNum(o.SL, 3), "", ""],
      ["Features before / after PCA", `${fmtNum(m.raw_features ?? 379)}<small>→</small>${fmtNum(m.pca_dims)}`, "", ""],
      ["Original / sampled frames", `${fmtNum(m.frames)}<small>→</small>${fmtNum(m.frames_5fps)}`, "", "wide"],
      ["Source fps", fmtNum(m.fps, 2), "", ""],
      ["Processing", fmtNum(r.elapsed_s, 1), "s", ""],
    ];
    ui.metrics.innerHTML = items.map(([k, v, unit, cls]) =>
      `<div class="metric ${cls}"><dt>${k}</dt><dd>${v}${unit ? `<small>${unit}</small>` : ""}</dd></div>`).join("");
  }

  function renderTimeline(segs) {
    ui.tlTrack.innerHTML = "";
    const D = state.duration;
    segs.forEach((s, i) => {
      const b = el("button", "tl-seg");
      b.type = "button";
      const dur = Math.max(0, (s.end_s ?? 0) - (s.start_s ?? 0)) || s.duration_s || 0;
      b.style.flex = `${Math.max(dur, 0.001)} 1 0`;
      b.style.setProperty("--c", colour(segLabel(s)));
      b.title = `Scene ${i + 1} · ${fmtTime(s.start_s)} – ${fmtTime(s.end_s)}`;
      b.setAttribute("aria-label", `Jump to scene ${i + 1}, ${fmtTime(s.start_s)}`);
      if (dur / D > 0.045) b.innerHTML = `<span>${i + 1}</span>`;
      b.addEventListener("click", () => seek(s.start_s));
      ui.tlTrack.append(b);
    });
    // scale ticks
    const ticks = window.innerWidth < 620 ? 3 : 5;
    ui.tlScale.innerHTML = Array.from({ length: ticks + 1 }, (_, k) => {
      const t = (D * k) / ticks;
      return `<span style="left:${(k / ticks) * 100}%">${fmtTime(t)}</span>`;
    }).join("");
  }

  function renderScenes(segs) {
    ui.scenes.innerHTML = "";
    const quick = $("#quickScenes");
    quick.innerHTML = "";
    const picks = [...new Set([Math.min(1, segs.length - 1), Math.floor(segs.length / 2), Math.max(0, segs.length - 2)])].filter((i) => i >= 0);
    picks.forEach((i) => {
      const s = segs[i];
      const b = el("button", "quick-scene");
      b.type = "button";
      b.setAttribute("aria-label", `Watch scene ${i + 1} from ${fmtTime(s.start_s)}`);
      b.innerHTML = `<img src="${esc(s.thumb_url)}" alt=""><span><strong>Scene ${i + 1}</strong><small>${fmtTime(s.start_s)} <span aria-hidden="true">▶</span></small></span>`;
      b.addEventListener("click", () => seek(s.start_s));
      quick.append(b);
    });
    segs.forEach((s, i) => {
      const c = colour(segLabel(s));
      const card = el("button", "scene");
      card.type = "button";
      card.style.setProperty("--c", c);
      card.setAttribute("aria-label", `Watch scene ${i + 1} from ${fmtTime(s.start_s)}`);
      const dur = s.duration_s ?? (s.end_s - s.start_s);
      card.innerHTML = `
        <div class="scene-thumb"><img src="${esc(s.thumb_url || "")}" alt="Scene ${i + 1} key frame" loading="lazy"><span class="scene-tag">Scene ${i + 1}</span></div>
        <div class="scene-body">
          <span class="scene-title">Scene ${i + 1}<span class="scene-play">Watch →</span></span>
          <span class="scene-time">${fmtTime(s.start_s)} – ${fmtTime(s.end_s)}</span>
          <span class="scene-dur">${fmtNum(dur, 1)} seconds</span>
        </div>
`;
      card.addEventListener("click", () => {
        seek(s.start_s);
        $(".player").scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "center" });
      });
      ui.scenes.append(card);
    });
  }

  /* ---------------- player ---------------- */
  let mockClock = null;
  const mock = { t: 0, playing: true, last: 0 };

  function setupPlayer(r) {
    if (MOCK) {
      ui.video.hidden = true;
      ui.videoMock.hidden = false;
      mock.t = 0; mock.playing = !reduceMotion; mock.last = performance.now();
      ui.videoMock.onclick = () => { mock.playing = !mock.playing; mock.last = performance.now(); };
      startMockClock();
      return;
    }
    ui.video.hidden = false;
    ui.videoMock.hidden = true;
    ui.video.poster = r.segments?.[Math.min(1, r.segments.length - 1)]?.thumb_url || "";
    ui.video.src = r.video_url || "";
    ui.video.load();
  }

  function startMockClock() {
    stopMockClock();
    const step = (now) => {
      if (mock.playing) { mock.t += (now - mock.last) / 1000; if (mock.t > state.duration) mock.t = 0; }
      mock.last = now;
      updatePlayhead(mock.t);
      mockClock = requestAnimationFrame(step);
    };
    mockClock = requestAnimationFrame(step);
  }
  function stopMockClock() { if (mockClock) cancelAnimationFrame(mockClock); mockClock = null; }

  function seek(t) {
    t = Math.max(0, Number(t) || 0) + 0.01;
    if (MOCK) { mock.t = t; updatePlayhead(t); return; }
    try {
      ui.video.currentTime = t;
      const p = ui.video.play();
      if (p && p.catch) p.catch(() => {});
    } catch (_) { /* ignore */ }
    updatePlayhead(t);
  }

  function updatePlayhead(t) {
    const r = state.result;
    if (!r) return;
    const D = state.duration || 1;
    const w = ui.tlTrack.clientWidth;
    ui.tlHead.style.transform = `translateX(${Math.min(w - 2, (t / D) * w)}px)`;
    const segs = r.segments || [];
    let idx = segs.findIndex((s) => t >= s.start_s && t < s.end_s);
    if (idx < 0) idx = t >= D - 0.05 ? segs.length - 1 : 0;
    if (idx !== state.current) {
      state.current = idx;
      ui.tlTrack.querySelectorAll(".tl-seg").forEach((b, i) => b.classList.toggle("is-current", i === idx));
      ui.scenes.querySelectorAll(".scene").forEach((b, i) => b.classList.toggle("is-current", i === idx));
      const s = segs[idx];
      if (s) {
        ui.now.innerHTML = `<i style="--c:${colour(segLabel(s))}"></i>${ui.video.paused ? "Selected" : "Playing"}: Scene ${idx + 1} · ${fmtTime(s.start_s)} to ${fmtTime(s.end_s)}`;
        if (MOCK) ui.videoMock.style.backgroundImage = `url("${s.thumb_url}")`;
      }
    }
    if (MOCK) ui.videoMockText.textContent = `${fmtTime(t)} / ${fmtTime(D)} · mock preview, click to ${mock.playing ? "pause" : "play"}`;
  }

  ui.video.addEventListener("timeupdate", () => updatePlayhead(ui.video.currentTime));
  ui.video.addEventListener("seeked", () => updatePlayhead(ui.video.currentTime));
  ui.video.addEventListener("play", () => {
    state.current = -1;
    const loop = () => { if (!ui.video.paused && !ui.video.ended) { updatePlayhead(ui.video.currentTime); requestAnimationFrame(loop); } };
    requestAnimationFrame(loop);
  });

  ui.video.addEventListener("pause", () => { state.current = -1; updatePlayhead(ui.video.currentTime); });
  ui.technical.addEventListener("toggle", () => {
    const r = state.result;
    if (!r || !ui.technical.open) return;
    requestAnimationFrame(() => { renderNovelty(r.novelty || [], r.segments || []); renderScatter(r.scatter || []); });
  });

  /* ---------------- charts ---------------- */
  function renderNovelty(values, segs) {
    const box = ui.novelty;
    const W = Math.max(280, box.clientWidth);
    const H = box.clientHeight || 300;
    const pad = { l: 36, r: 10, t: 12, b: 26 };
    const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
    if (!values.length) { box.innerHTML = `<p class="samples-empty">No boundary signal in this result.</p>`; return; }
    const n = values.length;
    const m = state.result?.meta || {};
    const sampleFps = m.fps && m.stride ? m.fps / m.stride : 5;
    const T = (n - 1) / sampleFps;
    let max = 0;
    for (const v of values) if (v > max) max = v;
    max = max || 1;
    const x = (i) => pad.l + (i / Math.max(1, n - 1)) * iw;
    const xs = (s) => pad.l + Math.min(1, s / T) * iw;
    const y = (v) => pad.t + ih - (v / max) * ih;

    let line = "";
    values.forEach((v, i) => { line += `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`; });
    const area = `${line}L${x(n - 1).toFixed(1)},${(pad.t + ih).toFixed(1)}L${x(0).toFixed(1)},${(pad.t + ih).toFixed(1)}Z`;

    // background bands by segment colour
    const bands = segs.map((s) => {
      const x0 = xs(s.start_s), x1 = xs(s.end_s);
      return `<rect x="${x0.toFixed(1)}" y="${pad.t}" width="${Math.max(0, x1 - x0).toFixed(1)}" height="${ih}" fill="${colour(segLabel(s))}" opacity="0.07"/>`;
    }).join("");
    const marks = segs.slice(1).map((s) => {
      const xx = xs(s.start_s).toFixed(1);
      return `<line x1="${xx}" x2="${xx}" y1="${pad.t}" y2="${pad.t + ih}" stroke="${colour(segLabel(s))}" stroke-width="1.5" stroke-dasharray="3 3"/>`;
    }).join("");

    const step = niceStep(T, W < 500 ? 4 : 8);
    let ticks = "";
    for (let s = 0; s <= T + 1e-6; s += step) {
      ticks += `<text class="axis" x="${xs(s).toFixed(1)}" y="${H - 6}" text-anchor="middle">${Math.round(s)}s</text>`;
    }
    const grid = [0.25, 0.5, 0.75, 1].map((f) => `<line x1="${pad.l}" x2="${pad.l + iw}" y1="${(pad.t + ih - f * ih).toFixed(1)}" y2="${(pad.t + ih - f * ih).toFixed(1)}"/>`).join("");
    const yl = [0, 0.5, 1].map((f) => `<text class="axis" x="${pad.l - 8}" y="${(pad.t + ih - f * ih + 4).toFixed(1)}" text-anchor="end">${(max * f).toFixed(max < 10 ? 1 : 0)}</text>`).join("");

    box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Boundary signal over time with ${segs.length - 1} cuts">
      <defs><linearGradient id="nvg" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#245bd6" stop-opacity=".45"/><stop offset="1" stop-color="#245bd6" stop-opacity="0"/></linearGradient></defs>
      ${bands}
      <g class="grid">${grid}</g>
      <path d="${area}" fill="url(#nvg)"/>
      <path d="${line}" fill="none" stroke="#245bd6" stroke-width="1.5" stroke-linejoin="round"/>
      ${marks}
      <line x1="${pad.l}" x2="${pad.l + iw}" y1="${pad.t + ih}" y2="${pad.t + ih}" stroke="#2f363d"/>
      ${ticks}${yl}
    </svg>`;
  }

  function niceStep(span, target) {
    const raw = span / target;
    const p = Math.pow(10, Math.floor(Math.log10(raw || 1)));
    const m = raw / p;
    return (m < 1.5 ? 1 : m < 3 ? 2 : m < 7 ? 5 : 10) * p;
  }

  function renderScatter(points) {
    const cv = ui.scatter;
    const W = cv.clientWidth || 300, H = cv.clientHeight || 300;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    const ctx = cv.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (!points.length) return;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const [x, y] of points) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    const pad = 16;
    const sx = (W - pad * 2) / ((x1 - x0) || 1), sy = (H - pad * 2) / ((y1 - y0) || 1);
    // frame
    ctx.strokeStyle = "#dce3ed"; ctx.lineWidth = 1;
    for (let k = 1; k < 4; k++) {
      ctx.beginPath(); ctx.moveTo(pad + (k * (W - 2 * pad)) / 4, pad); ctx.lineTo(pad + (k * (W - 2 * pad)) / 4, H - pad); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(pad, pad + (k * (H - 2 * pad)) / 4); ctx.lineTo(W - pad, pad + (k * (H - 2 * pad)) / 4); ctx.stroke();
    }
    // faint path through time
    ctx.strokeStyle = "rgba(23,44,75,0.1)";
    ctx.beginPath();
    points.forEach(([x, y], i) => { const px = pad + (x - x0) * sx, py = H - pad - (y - y0) * sy; i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); });
    ctx.stroke();
    const r = points.length > 600 ? 2.2 : 3.2;
    for (const [x, y, lab] of points) {
      ctx.fillStyle = colour(lab);
      ctx.globalAlpha = 0.85;
      ctx.beginPath(); ctx.arc(pad + (x - x0) * sx, H - pad - (y - y0) * sy, r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#566781"; ctx.font = "11px 'IBM Plex Mono', monospace";
    ctx.fillText("PC1 →", W - pad - 40, H - 4);
    ctx.save(); ctx.translate(10, pad + 36); ctx.rotate(-Math.PI / 2); ctx.fillText("PC2 →", 0, 0); ctx.restore();
  }

  let resizeT = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeT);
    resizeT = setTimeout(() => {
      const r = state.result;
      if (!r) return;
      if (ui.technical.open) {
        renderNovelty(r.novelty || [], r.segments || []);
        renderScatter(r.scatter || []);
      }
      state.current = -1;
      updatePlayhead(MOCK ? mock.t : ui.video.currentTime || 0);
    }, 120);
  });

  /* ---------------- upload wiring ---------------- */
  ui.file.addEventListener("change", () => startUpload(ui.file.files && ui.file.files[0]));
  ["dragenter", "dragover"].forEach((ev) => ui.drop.addEventListener(ev, (e) => { e.preventDefault(); ui.drop.classList.add("is-over"); }));
  ["dragleave", "dragend"].forEach((ev) => ui.drop.addEventListener(ev, () => ui.drop.classList.remove("is-over")));
  ui.drop.addEventListener("drop", (e) => {
    e.preventDefault();
    ui.drop.classList.remove("is-over");
    if (ui.body.classList.contains("is-busy")) return;
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    startUpload(f);
  });
  // stop the browser from opening a file dropped outside the zone
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => e.preventDefault());

  ui.reset.addEventListener("click", resetAll);
  ui.cancel.addEventListener("click", resetAll);

  /* ---------------- mock backend (?mock=1 only) ---------------- */
  const mockJobs = {};
  function mockThumb(label, variant, grey) {
    const c = document.createElement("canvas");
    c.width = 320; c.height = 180;
    const g = c.getContext("2d");
    const base = colour(label);
    const grad = g.createLinearGradient(0, 0, 320, 180);
    grad.addColorStop(0, "#0d1114");
    grad.addColorStop(1, base);
    g.fillStyle = grad; g.fillRect(0, 0, 320, 180);
    let seed = (Number(label) + 1) * 97 + variant * 13;
    const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
    for (let k = 0; k < 5; k++) {
      g.fillStyle = `rgba(255,255,255,${0.05 + rnd() * 0.12})`;
      g.beginPath(); g.arc(rnd() * 320, rnd() * 180, 20 + rnd() * 70, 0, Math.PI * 2); g.fill();
    }
    g.fillStyle = "rgba(0,0,0,.35)"; g.fillRect(0, 128 + rnd() * 20, 320, 60);
    if (grey) {
      const d = g.getImageData(0, 0, 320, 180);
      for (let i = 0; i < d.data.length; i += 4) {
        let v = 0.299 * d.data[i] + 0.587 * d.data[i + 1] + 0.114 * d.data[i + 2];
        v = Math.min(255, Math.max(0, (v - 60) * 1.6 + 40));
        d.data[i] = d.data[i + 1] = d.data[i + 2] = v;
      }
      g.putImageData(d, 0, 0);
    }
    return c.toDataURL("image/jpeg", 0.8);
  }

  function mockResult(name, duration) {
    const fps = 24, stride = 5;
    const frames = Math.round(duration * fps);
    const f5 = Math.round(duration * 5);
    const cuts = [0, 4.2, 9.8, 13.1, 19.6, 24.0, 31.4, 35.2, 41.7, 47.5].filter((c) => c < duration - 1);
    const labels = [0, 1, 2, 1, 3, 4, 5, 2, 6, 7];
    const segments = cuts.map((s, i) => {
      const e = i + 1 < cuts.length ? cuts[i + 1] : duration;
      const lab = labels[i % labels.length];
      return {
        id: lab, start_frame: Math.round(s * fps), end_frame: Math.round(e * fps) - 1, start_s: s, end_s: e, duration_s: +(e - s).toFixed(2),
        thumb_url: mockThumb(lab, 0), sample_thumbs: [1, 2, 3, 4].map((v) => mockThumb(lab, v)),
      };
    });
    const timeline = Array.from({ length: f5 }, (_, i) => { const t = i / 5; const s = segments.find((x) => t >= x.start_s && t < x.end_s) || segments[segments.length - 1]; return s.id; });
    const novelty = timeline.map((lab, i) => {
      const isCut = i > 0 && timeline[i - 1] !== lab;
      return +(isCut ? 0.7 + Math.random() * 0.3 : 0.04 + Math.random() * 0.12 + (Math.sin(i / 3) + 1) * 0.03).toFixed(3);
    });
    const centres = {};
    const scatter = timeline.map((lab) => {
      if (!centres[lab]) { const a = lab * 2.1; centres[lab] = [Math.cos(a) * (3 + lab * 0.4), Math.sin(a) * (3 + lab * 0.3)]; }
      const [cx, cy] = centres[lab];
      return [+(cx + (Math.random() - 0.5) * 1.6).toFixed(3), +(cy + (Math.random() - 0.5) * 1.6).toFixed(3), lab];
    });
    return {
      name: "Sintel trailer", video_url: "", elapsed_s: 4.0,
      meta: { fps, width: 1280, height: 720, frames, duration, stride, frames_5fps: f5, pca_dims: 42, raw_features: 379 },
      onm: { T: 0.412, CC: 7, SL: 1.873, N_centroids: 8, N_clusters: 8, A: 91.6, D: 8.4 },
      segments, timeline_5fps: timeline, novelty, scatter,
      stages: { original_url: mockThumb(4, 0), reduced_url: mockThumb(4, 1), enhanced_url: mockThumb(4, 1, true) },
    };
  }

  function mockApi(path, opts) {
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        if (path === "/api/samples") {
          resolve([
            { id: "sintel", title: "Sintel trailer", duration: 52.2, ready: true },
            { id: "lecture", title: "Lecture, three cameras", duration: 38.0, ready: true },
            { id: "news", title: "News bulletin", duration: 44.6, ready: false },
          ]);
          return;
        }
        if (path.startsWith("/api/jobs") && opts && opts.method === "POST") {
          const id = "mock" + Math.random().toString(36).slice(2, 8);
          const name = opts.file ? opts.file.name : decodeURIComponent(path.split("/").pop());
          mockJobs[id] = { t0: Date.now(), name };
          resolve({ job_id: id });
          return;
        }
        const id = path.split("/").pop();
        const j = mockJobs[id];
        if (!j) { reject(new Error("Unknown job")); return; }
        const secs = (Date.now() - j.t0) / 1000;
        const per = 1.1;
        const stage = Math.min(7, Math.floor(secs / per) + 1);
        const prog = Math.min(1, (secs % per) / per);
        const log = [];
        for (let s = 1; s <= stage; s++) {
          log.push(`[stage ${s}] ${STAGES[s]}`);
          if (s === 1) log.push("  1253 frames at 24.00 fps, 1280x720");
          if (s === 2 && stage > 2) log.push("  stride 5 -> 251 frames at 5 fps");
          if (s === 4 && stage > 4) log.push("  379 raw features -> 42 PCA dims (95% variance)");
          if (s === 5 && stage > 5) log.push("  T=0.412  CC=7  SDCO N=8  A(C)=91.6%  D(C)=8.4%");
        }
        if (secs > per * 7.2) {
          log.push("done in 4.0 s");
          resolve({ job_id: id, status: "done", stage: 7, stage_name: "Report", progress: 1, log, error: null, queue_position: 0, result: mockResult(j.name, 52.2) });
        } else {
          resolve({ job_id: id, status: "running", stage, stage_name: STAGES[stage], progress: prog, log, error: null, queue_position: 0, result: null });
        }
      }, 120);
    });
  }

  /* ---------------- boot ---------------- */
  loadSamples();
  if (MOCK && new URLSearchParams(location.search).has("auto")) {
    setTimeout(() => startSample({ id: "sintel", title: "Sintel trailer" }), 300);
  }
})();
