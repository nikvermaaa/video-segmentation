"""
WEB DEMO - a small FastAPI server around the seven-stage ONM pipeline

Serves the single-page demo in web/static/ and runs uploaded or sample
videos through stages 1-6, one job at a time, reusing the stage modules
exactly as run_all.py does. Nothing in the pipeline itself is changed.

    pip install -r requirements.txt -r web/requirements.txt
    python web/server.py --port 8000 --samples web/samples

Optional: put .mp4 files in --samples; each one is processed once at start
and offered as a one-click sample. ffmpeg on PATH is used to normalise
uploads to H.264 (so every browser can play them) and to cap their length.
"""

import os
import io
import re
import sys
import json
import glob
import time
import uuid
import shutil
import argparse
import threading
import subprocess
import contextlib
from collections import deque

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)

import stage01_extract_frames as s1          # noqa: E402
import stage02_reduce_fps as s2              # noqa: E402
import stage03_enhance as s3                 # noqa: E402
import stage04_features as s4                # noqa: E402
import stage05_cluster_onm as s5             # noqa: E402
import stage06_map_to_original as s6         # noqa: E402

from fastapi import FastAPI, UploadFile, File, HTTPException   # noqa: E402
from fastapi.responses import FileResponse, JSONResponse       # noqa: E402
from fastapi.staticfiles import StaticFiles                    # noqa: E402

TARGET_FPS = 5
MAX_UPLOAD_MB = 60
MAX_SECONDS = 90          # uploads are trimmed to this length
MAX_HEIGHT = 480          # and scaled down to this height
KEEP_UPLOAD_JOBS = 25

STAGES = {
    1: "Extracting frames",
    2: "Reducing to 5 fps",
    3: "Greyscale + CLAHE",
    4: "379 features + PCA",
    5: "ONM clustering",
    6: "Mapping to original frames",
    7: "Building the report",
}

DATA = os.environ.get("VIDSEG_DATA", os.path.join(HERE, "data"))
JOBS_DIR = os.path.join(DATA, "jobs")
os.makedirs(JOBS_DIR, exist_ok=True)

jobs = {}                      # job_id -> state dict
samples = {}                   # sample_id -> {"title", "duration", "job_id"}
queue = deque()
qlock = threading.Lock()
qevent = threading.Event()
admission = threading.BoundedSemaphore(4)  # includes uploads, queued and running


# ----------------------------------------------------------------------
# helpers
# ----------------------------------------------------------------------
class _Tee(io.TextIOBase):
    """Collect the stages' print() output into the job log."""

    def __init__(self, job):
        self.job, self.buf = job, ""

    def write(self, s):
        self.buf += s
        while "\n" in self.buf:
            line, self.buf = self.buf.split("\n", 1)
            line = line.rstrip()
            if line:
                self.job["log"].append(line)
                del self.job["log"][:-60]
        return len(s)


def have_ffmpeg():
    return shutil.which("ffmpeg") is not None


def normalise(src, dst, max_seconds=MAX_SECONDS):
    """H.264 mp4, at most MAX_HEIGHT tall, at most max_seconds long."""
    if not have_ffmpeg():
        cap = cv2.VideoCapture(src)
        fps = cap.get(cv2.CAP_PROP_FPS) or 25
        duration = cap.get(cv2.CAP_PROP_FRAME_COUNT) / fps
        height = cap.get(cv2.CAP_PROP_FRAME_HEIGHT)
        cap.release()
        if duration > max_seconds or height > MAX_HEIGHT:
            raise RuntimeError("install ffmpeg to process clips longer than "
                               "90 seconds or taller than 480 pixels")
        shutil.copy(src, dst)
        return
    cmd = ["ffmpeg", "-y", "-loglevel", "error", "-i", src,
           "-t", str(max_seconds),
           "-vf", f"scale=-2:'min({MAX_HEIGHT},ih)'",
           "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
           "-pix_fmt", "yuv420p", "-movflags", "+faststart",
           "-c:a", "aac", "-b:a", "96k", dst]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
    if r.returncode != 0 or not os.path.isfile(dst):
        raise RuntimeError("could not decode this video: "
                           + (r.stderr.strip().splitlines() or ["?"])[-1])


def thumb(src, dst, width=320):
    img = cv2.imread(src)
    if img is None:
        return
    h, w = img.shape[:2]
    img = cv2.resize(img, (width, max(1, round(h * width / w))),
                     interpolation=cv2.INTER_AREA)
    cv2.imwrite(dst, img, [cv2.IMWRITE_JPEG_QUALITY, 82])


def runs(labels):
    out, start = [], 0
    for i in range(1, len(labels) + 1):
        if i == len(labels) or labels[i] != labels[start]:
            out.append((start, i - 1, int(labels[start])))
            start = i
    return out


def build_result(job_id, video_dir, video_url, res, t0):
    with open(os.path.join(video_dir, "01_original_frames",
                           "video_meta.json")) as f:
        vm = json.load(f)
    with open(os.path.join(video_dir, "02_frames_5fps",
                           "reduce_meta.json")) as f:
        rm = json.load(f)
    X = np.load(os.path.join(video_dir, "04_feature_vectors",
                             "all_features.npy"))
    lab5 = np.asarray(res["labels"])
    lab_org = np.load(os.path.join(video_dir, "06_clusters_original",
                                   "labels.npy"))

    fps = vm["fps"] or 25.0
    orig = sorted(glob.glob(os.path.join(video_dir, "01_original_frames",
                                         "*.jpg")))
    five = sorted(glob.glob(os.path.join(video_dir, "02_frames_5fps",
                                         "*.jpg")))
    enh = sorted(glob.glob(os.path.join(video_dir, "03_gray_enhanced",
                                        "*.jpg")))
    tdir = os.path.join(video_dir, "web")
    os.makedirs(tdir, exist_ok=True)
    base = f"/files/{job_id}/run/web"

    # the 5 fps run that each original-rate segment came from, for samples
    stride = rm["stride"]
    segments = []
    for k, (a, b, _lab) in enumerate(runs(lab_org)):
        mid = (a + b) // 2
        name = f"seg_{k:03d}.jpg"
        thumb(orig[mid], os.path.join(tdir, name), 480)
        lo, hi = a // stride, min(len(five) - 1, b // stride)
        picks = sorted(set(np.linspace(lo, hi, num=min(5, hi - lo + 1))
                           .round().astype(int).tolist()))
        smp = []
        for p in picks:
            n = f"f5_{p:04d}.jpg"
            if not os.path.isfile(os.path.join(tdir, n)):
                thumb(five[p], os.path.join(tdir, n), 200)
            smp.append(f"{base}/{n}")
        segments.append({
            "id": k, "start_frame": int(a), "end_frame": int(b),
            "start_s": round(a / fps, 3), "end_s": round((b + 1) / fps, 3),
            "duration_s": round((b - a + 1) / fps, 3),
            "thumb_url": f"{base}/{name}", "sample_thumbs": smp,
        })

    # boundary signal: distance between consecutive 5 fps feature vectors
    d = np.linalg.norm(np.diff(X, axis=0), axis=1)
    novelty = [0.0] + [round(float(v), 4) for v in d]

    sx = X[:, 0] if X.shape[1] > 0 else np.zeros(len(X))
    sy = X[:, 1] if X.shape[1] > 1 else np.zeros(len(X))
    scatter = [[round(float(x), 4), round(float(y), 4), int(l)]
               for x, y, l in zip(sx, sy, lab5)]

    mid5 = len(five) // 2
    thumb(orig[min(len(orig) - 1, mid5 * stride)],
          os.path.join(tdir, "stage_original.jpg"), 640)
    thumb(five[mid5], os.path.join(tdir, "stage_reduced.jpg"), 640)
    thumb(enh[mid5], os.path.join(tdir, "stage_enhanced.jpg"), 640)

    return {
        "name": vm.get("source_file", job_id),
        "video_url": video_url,
        "elapsed_s": round(time.time() - t0, 1),
        "meta": {"fps": round(fps, 3), "width": vm["width"],
                 "height": vm["height"], "frames": vm["extracted_frames"],
                 "duration": round(vm["extracted_frames"] / fps, 2),
                 "stride": stride, "frames_5fps": rm["frames"],
                 "pca_dims": int(X.shape[1]), "raw_features": 379},
        "onm": {"T": round(float(res["T"]), 4), "CC": int(res["CC"]),
                "SL": round(float(res["SL"]), 4),
                "N_centroids": int(res["N_centroids"]),
                "N_clusters": int(res["N_clusters"]),
                "A": round(float(res["A"]), 2),
                "D": round(float(res["D"]), 2)},
        "segments": segments,
        "timeline_5fps": [int(v) for v in lab5],
        "novelty": novelty,
        "scatter": scatter,
        "stages": {"original_url": f"{base}/stage_original.jpg",
                   "reduced_url": f"{base}/stage_reduced.jpg",
                   "enhanced_url": f"{base}/stage_enhanced.jpg"},
    }


# ----------------------------------------------------------------------
# the worker: one job at a time, stages 1-6 exactly as run_all.py runs them
# ----------------------------------------------------------------------
def set_stage(job, n):
    job["stage"], job["stage_name"] = n, STAGES[n]
    job["progress"] = round((n - 1) / len(STAGES), 3)


def process(job):
    jid = job["job_id"]
    jdir = os.path.join(JOBS_DIR, jid)
    vdir = os.path.join(jdir, "run")
    video = os.path.join(jdir, "video.mp4")
    t0 = time.time()
    job["status"] = "running"
    tee = _Tee(job)
    with contextlib.redirect_stdout(tee):
        set_stage(job, 1)
        if job.get("raw"):
            print("  [0] normalising video (H.264, <=480p, <=90 s)")
            normalise(job["raw"], video)
            os.remove(job["raw"])
        info = s1.extract_frames(video, os.path.join(vdir,
                                                     "01_original_frames"))
        if not info or info["extracted_frames"] < 10:
            raise RuntimeError("the video has too few frames to segment")

        set_stage(job, 2)
        s2.reduce_fps(os.path.join(vdir, "01_original_frames"),
                      os.path.join(vdir, "02_frames_5fps"),
                      info["fps"], TARGET_FPS,
                      (info["width"], info["height"]))

        set_stage(job, 3)
        s3.enhance_dir(os.path.join(vdir, "02_frames_5fps"),
                       os.path.join(vdir, "03_gray_enhanced"), False)

        set_stage(job, 4)
        s4.build_features(os.path.join(vdir, "03_gray_enhanced"),
                          os.path.join(vdir, "04_feature_vectors"))

        set_stage(job, 5)
        res = s5.cluster_video(vdir, jid, s5.resolve_params(),
                               copy_frames=False)
        if res is None:
            raise RuntimeError("no frame repeated often enough to form a "
                               "scene; try a longer clip")

        set_stage(job, 6)
        s6.export_clusters = lambda *a, **k: _labels_only(*a, **k)
        s6.run(vdir)

        set_stage(job, 7)
        result = build_result(jid, vdir, f"/files/{jid}/video.mp4", res, t0)
        result["name"] = job.get("title") or result["name"]
        with open(os.path.join(jdir, "result.json"), "w") as f:
            json.dump(result, f)
        print(f"  [7] {len(result['segments'])} scenes in "
              f"{result['elapsed_s']} s")
    job["result"] = result
    job["progress"] = 1.0
    job["status"] = "done"


def _labels_only(frame_paths, labels, out_dir):
    """Stage 6 without the per-cluster frame copies (the demo never reads
    them); labels.npy and segments.txt are written exactly as before."""
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, "segments.txt"), "w") as f:
        for a, b, lab in runs(labels):
            f.write(f"frames {a:6d} - {b:6d}  ->  cluster {lab}\n")
    np.save(os.path.join(out_dir, "labels.npy"), labels)


def worker():
    while True:
        qevent.wait()
        with qlock:
            if not queue:
                qevent.clear()
                continue
            jid = queue.popleft()
        job = jobs[jid]
        try:
            process(job)
        except (Exception, SystemExit) as e:          # stage CLI helpers may raise SystemExit
            job["status"], job["error"] = "error", str(e)
            job["log"].append(f"  [error] {e}")
        finally:
            if job.pop("admitted", False):
                admission.release()
        prune()


def prune():
    ups = sorted((j for j in jobs.values()
                  if not j.get("sample") and j["status"] in ("done", "error")),
                 key=lambda j: j["created"])
    for j in ups[:-KEEP_UPLOAD_JOBS]:
        shutil.rmtree(os.path.join(JOBS_DIR, j["job_id"]), ignore_errors=True)
        jobs.pop(j["job_id"], None)


def new_job(sample=None):
    if not admission.acquire(blocking=False):
        raise HTTPException(429, "four videos are already uploading or processing; "
                                 "please try again in a moment")
    jid = uuid.uuid4().hex[:12]
    job = {"job_id": jid, "status": "queued", "stage": 0,
           "stage_name": "Waiting in queue", "progress": 0.0, "log": [],
           "error": None, "result": None, "created": time.time(),
           "sample": sample, "admitted": True}
    os.makedirs(os.path.join(JOBS_DIR, jid), exist_ok=True)
    jobs[jid] = job
    return job


def enqueue(job):
    with qlock:
        queue.append(job["job_id"])
        qevent.set()


def load_samples(folder):
    """Each sample is processed once and cached under jobs/sample-<id>."""
    for path in sorted(glob.glob(os.path.join(folder, "*.mp4"))):
        sid = re.sub(r"[^a-z0-9]+", "-",
                     os.path.splitext(os.path.basename(path))[0].lower())
        title_file = os.path.splitext(path)[0] + ".title"
        title = (open(title_file).read().strip() if os.path.isfile(title_file)
                 else sid.replace("-", " ").title())
        jid = f"sample-{sid}"
        jdir = os.path.join(JOBS_DIR, jid)
        cached = os.path.join(jdir, "result.json")
        job = {"job_id": jid, "status": "queued", "stage": 0,
               "stage_name": "Waiting in queue", "progress": 0.0, "log": [],
               "error": None, "result": None, "created": 0, "sample": sid,
               "title": title}
        jobs[jid] = job
        if os.path.isfile(cached):
            with open(cached) as f:
                job["result"] = json.load(f)
            job["result"]["name"] = title
            job.update(status="done", stage=7, progress=1.0,
                       stage_name=STAGES[7])
            dur = job["result"]["meta"]["duration"]
        else:
            os.makedirs(jdir, exist_ok=True)
            job["raw"] = os.path.join(jdir, "upload.bin")
            shutil.copy(path, job["raw"])
            cap = cv2.VideoCapture(path)
            fps = cap.get(cv2.CAP_PROP_FPS) or 25
            dur = min(MAX_SECONDS, cap.get(cv2.CAP_PROP_FRAME_COUNT) / fps)
            cap.release()
            enqueue(job)
        samples[sid] = {"title": title, "duration": round(dur, 1),
                        "job_id": jid, "path": path}


# ----------------------------------------------------------------------
# HTTP
# ----------------------------------------------------------------------
app = FastAPI(title="ONM Video Slicer")


def public(job):
    pos = 0
    if job["status"] == "queued":
        with qlock:
            q = list(queue)
        pos = q.index(job["job_id"]) + 1 if job["job_id"] in q else 0
    return {k: job[k] for k in ("job_id", "status", "stage", "stage_name",
                                "progress", "log", "error", "result")} \
        | {"queue_position": pos}


@app.get("/api/health")
def health():
    return {"ok": True, "jobs": len(jobs), "queue": len(queue)}


@app.get("/api/samples")
def list_samples():
    return [{"id": sid, "title": s["title"], "duration": s["duration"],
             "ready": jobs[s["job_id"]]["status"] == "done"}
            for sid, s in samples.items()]


@app.post("/api/jobs/sample/{sid}")
def run_sample(sid: str):
    """Run the sample live, so visitors watch every stage. Falls back to the
    cached result if the sample file is gone."""
    if sid not in samples:
        raise HTTPException(404, "unknown sample")
    src = samples[sid].get("path")
    if not src or not os.path.isfile(src):
        return {"job_id": samples[sid]["job_id"]}
    job = new_job()
    job["title"] = samples[sid]["title"]
    job["raw"] = os.path.join(JOBS_DIR, job["job_id"], "upload.mp4")
    shutil.copy(src, job["raw"])
    enqueue(job)
    return {"job_id": job["job_id"]}


@app.post("/api/jobs")
async def upload(file: UploadFile = File(...)):
    ext = os.path.splitext(file.filename or "")[1].lower()
    if ext not in (".mp4", ".mov", ".webm", ".mkv", ".avi", ".m4v"):
        raise HTTPException(400, "please upload an mp4, mov, webm, mkv or "
                                 "avi video")
    job = new_job()
    raw = os.path.join(JOBS_DIR, job["job_id"], "upload" + ext)
    size = 0
    try:
        with open(raw, "wb") as f:
            while chunk := await file.read(1 << 20):
                size += len(chunk)
                if size > MAX_UPLOAD_MB << 20:
                    raise HTTPException(413, f"video is over {MAX_UPLOAD_MB} MB")
                f.write(chunk)
        job["raw"] = raw
        job["title"] = os.path.basename(file.filename or "your video")[:80]
        enqueue(job)
    except BaseException:
        shutil.rmtree(os.path.dirname(raw), ignore_errors=True)
        jobs.pop(job["job_id"], None)
        if job.pop("admitted", False):
            admission.release()
        raise
    return {"job_id": job["job_id"]}


@app.get("/api/jobs/{jid}")
def job_status(jid: str):
    if jid not in jobs:
        raise HTTPException(404, "unknown job")
    return JSONResponse(public(jobs[jid]))


@app.get("/files/{jid}/{path:path}")
def files(jid: str, path: str):
    if (jid not in jobs or not re.fullmatch(r"[a-z0-9-]+", jid)
            or os.path.isabs(path) or ".." in path):
        raise HTTPException(404)
    root = os.path.realpath(os.path.join(JOBS_DIR, jid))
    p = os.path.realpath(os.path.join(root, path))
    if os.path.commonpath([root, p]) != root or not os.path.isfile(p):
        raise HTTPException(404)
    return FileResponse(p, headers={"Cache-Control": "public, max-age=3600"})


app.mount("/", StaticFiles(directory=os.path.join(HERE, "static"),
                           html=True), name="static")


def main():
    import uvicorn
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--samples", default=os.path.join(HERE, "samples"))
    args = ap.parse_args()
    threading.Thread(target=worker, daemon=True).start()
    if os.path.isdir(args.samples):
        load_samples(args.samples)
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
