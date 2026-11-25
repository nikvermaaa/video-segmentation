# Web demo

A browser front end for the seven-stage ONM pipeline. Pick a sample clip or
upload your own, watch each stage run, then scrub the video by scene.

The server calls the existing stage modules exactly as `run_all.py` does. No
stage file is changed. The only difference is that stage 5 and 6 skip the
per-cluster frame copies (`copy_frames=False`), since the page reads the labels
directly.

## Run

```bash
pip install -r requirements.txt -r web/requirements.txt
python web/fetch_samples.py       # optional: two Blender trailers
python web/server.py --port 8000 --samples web/samples
# open http://127.0.0.1:8000
```

`ffmpeg` on PATH is optional but recommended: uploads are re-encoded to H.264,
480p and at most 90 seconds, so every browser can play them back and a long
video cannot fill the disk.

## Samples

Any `.mp4` in `--samples` is processed once at start-up and listed on the page.
A `<name>.title` file next to it sets the display name. Clicking a sample runs
it live through every stage.

## API

| method | path | returns |
|---|---|---|
| GET | `/api/samples` | sample list |
| POST | `/api/jobs/sample/{id}` | `{job_id}` |
| POST | `/api/jobs` (multipart `file`, max 60 MB) | `{job_id}` |
| GET | `/api/jobs/{job_id}` | status, stage 1-7, log, and the result when done |
| GET | `/files/{job_id}/...` | the normalised video and thumbnails |

The result carries the scene segments (in seconds and original frames), the
5 fps label timeline, the frame-to-frame feature distance used as a boundary
signal, the first two PCA dimensions per frame, and the ONM numbers
(SDCO N, clusters, T, CC, SL, A(C), D(C)).

Jobs run one at a time in a background thread, with at most four uploads,
queued or running jobs admitted together (further requests get HTTP 429).
Upload jobs beyond the 25 most
recent are deleted. Output lives in `web/data/` (override with `VIDSEG_DATA`).
