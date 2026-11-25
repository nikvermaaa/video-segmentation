"""Exercise a running demo with real video processing.

    python web/smoke_test.py http://127.0.0.1:8000

Samples must have been installed first. Checks sample processing, every
thumbnail, segment coverage, media range requests and invalid input errors.
"""
import json
import sys
import time
import urllib.request
import urllib.error

BASE = sys.argv[1].rstrip("/") if len(sys.argv) > 1 else "http://127.0.0.1:8000"


def req(path, data=None, headers=None):
    r = urllib.request.Request(BASE + path, data=data, headers=headers or {})
    return urllib.request.urlopen(r, timeout=90)


def get(path):
    with req(path) as r:
        return json.load(r)


def wait(jid):
    for _ in range(180):
        d = get("/api/jobs/" + jid)
        if d["status"] in ("done", "error"):
            assert d["status"] == "done", d
            return d["result"]
        time.sleep(1)
    raise AssertionError("job took over three minutes")


def check(r):
    segs, m, o = r["segments"], r["meta"], r["onm"]
    assert len(segs) == o["N_clusters"] > 0
    assert len(r["timeline_5fps"]) == m["frames_5fps"]
    assert len(r["novelty"]) == len(r["scatter"]) == m["frames_5fps"]
    assert segs[0]["start_frame"] == 0
    assert segs[-1]["end_frame"] == m["frames"] - 1
    for a, b in zip(segs, segs[1:]):
        assert a["end_frame"] + 1 == b["start_frame"]
        assert abs(a["end_s"] - b["start_s"]) < .01
    assert abs(o["A"] + o["D"] - 100) < .02
    urls = {s["thumb_url"] for s in segs}
    urls |= {p for s in segs for p in s["sample_thumbs"]}
    urls |= set(r["stages"].values())
    for u in sorted(urls):
        with req(u) as f:
            assert f.status == 200 and f.read(2) == b"\xff\xd8", u
    with req(r["video_url"], headers={"Range": "bytes=0-1023"}) as f:
        assert f.status == 206 and len(f.read()) == 1024
    print(f"PASS {r['name']}: {len(segs)} scenes, "
          f"{m['frames']} original / {m['frames_5fps']} sampled frames, "
          f"{len(urls)} images, {r['elapsed_s']}s, media range OK")


assert get("/api/health")["ok"]
for path in ("/files/unknown//etc/hosts", "/files/sample-sintel//etc/hosts",
             "/files/sample-sintel/%2e%2e/%2e%2e/etc/hosts"):
    try:
        req(path)
        raise AssertionError("unsafe media path was accepted: " + path)
    except urllib.error.HTTPError as e:
        assert e.code == 404, e
print("PASS absolute / traversal / unknown-job media paths rejected")
with req("/") as r:
    assert "ONM Video Slicer" in r.read().decode()
ss = get("/api/samples")
assert ss, "install sample videos first"
for s in ss:
    with req("/api/jobs/sample/" + s["id"], data=b"") as f:
        jid = json.load(f)["job_id"]
    check(wait(jid))

# invalid suffix rejected, and an invalid video handled without killing worker
for filename, expected in [("bad.txt", 400), ("bad.mp4", 200)]:
    boundary = "ONM_SMOKE_BOUNDARY"
    body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; "
            f"filename=\"{filename}\"\r\nContent-Type: application/octet-stream"
            f"\r\n\r\nnot a video\r\n--{boundary}--\r\n").encode()
    headers = {"Content-Type": "multipart/form-data; boundary=" + boundary}
    try:
        with req("/api/jobs", data=body, headers=headers) as f:
            assert expected == 200
            jid = json.load(f)["job_id"]
        for _ in range(30):
            d = get("/api/jobs/" + jid)
            if d["status"] == "error":
                assert d["error"]
                print("PASS invalid-video error visible:", d["error"][:120])
                break
            time.sleep(1)
        else:
            raise AssertionError("invalid video never failed")
    except urllib.error.HTTPError as e:
        assert e.code == expected, e
        print("PASS invalid suffix rejected:", e.code)

# worker is still alive after the bad video
with req("/api/jobs/sample/" + ss[0]["id"], data=b"") as f:
    jid = json.load(f)["job_id"]
assert wait(jid)["segments"]
print("PASS worker recovered after invalid input")
