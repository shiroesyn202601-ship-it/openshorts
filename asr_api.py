"""Online Whisper (TRANSCRIBE_BACKEND=api): any OpenAI-compatible
``/audio/transcriptions`` endpoint, e.g. Groq or OpenAI.

    ASR_API_KEY       required; several keys separated by commas. A key that
                      hits its rate limit (429) rests for the time the API
                      asks (retry-after) and the request moves to the next
                      key; a rejected key (401/403) is skipped from then on.
    ASR_API_MAX_WAIT  seconds to wait when EVERY key is resting (default 90);
                      past that the job falls back to local whisper
    ASR_API_BASE_URL  default https://api.groq.com/openai/v1
                      (OpenAI: https://api.openai.com/v1)
    ASR_API_MODEL     default whisper-large-v3-turbo (OpenAI: whisper-1)
    ASR_API_LANGUAGE  optional ISO 639-1 hint ("id"); auto-detected otherwise
    ASR_API_CHUNK_SECONDS  default 600; ASR_API_PARALLEL default 3

The audio is cut into chunks (the APIs cap an upload at ~25 MB), encoded as
small mono MP3s, sent in parallel, and stitched back with each chunk's
offset added, so the result keeps the transcript contract of
transcribe_backends (absolute timestamps, words with a leading space).
"""
import os
import shutil
import subprocess
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor

DEFAULT_BASE_URL = "https://api.groq.com/openai/v1"
DEFAULT_MODEL = "whisper-large-v3-turbo"

# verbose_json reports the language by name; the pipeline wants the code.
_LANG_NAMES = {
    "indonesian": "id", "english": "en", "malay": "ms", "javanese": "jw",
    "sundanese": "su", "spanish": "es", "portuguese": "pt", "french": "fr",
    "german": "de", "italian": "it", "dutch": "nl", "russian": "ru",
    "japanese": "ja", "korean": "ko", "chinese": "zh", "arabic": "ar",
    "hindi": "hi", "thai": "th", "vietnamese": "vi", "tagalog": "tl",
    "turkish": "tr", "polish": "pl", "ukrainian": "uk",
}


class ApiAsrError(Exception):
    pass


def _keys_from_env():
    raw = os.environ.get("ASR_API_KEY") or ""
    keys = []
    for k in raw.replace("\n", ",").replace(";", ",").split(","):
        k = k.strip()
        if k and k not in keys:
            keys.append(k)
    return keys


def enabled():
    return bool(_keys_from_env())


def _mask(key):
    return f"…{key[-4:]}" if len(key) > 8 else "…"


class KeyPool:
    """The configured keys, shared by the chunk threads of one transcription.

    ``acquire`` hands out the next key that is not resting (round robin, so
    the load spreads); ``rate_limited`` rests a key for ``seconds``;
    ``rejected`` drops it for good. When every key rests, ``acquire`` waits
    for the first to wake, up to ``max_wait`` seconds in total."""

    def __init__(self, keys, max_wait=90.0, clock=time.monotonic, sleep=time.sleep):
        self.keys = list(keys)
        self.rest_until = {}
        self.dead = set()
        self.max_wait = max_wait
        self.clock, self.sleep = clock, sleep
        self.lock = threading.Lock()
        self.turn = 0

    def acquire(self):
        waited = 0.0
        while True:
            with self.lock:
                live = [k for k in self.keys if k not in self.dead]
                if not live:
                    raise ApiAsrError("every ASR API key was rejected (check ASR_API_KEY)")
                now = self.clock()
                for i in range(len(live)):
                    k = live[(self.turn + i) % len(live)]
                    if self.rest_until.get(k, 0) <= now:
                        self.turn = (self.turn + i + 1) % len(live)
                        return k
                wake = min(self.rest_until[k] for k in live) - now
            if waited + wake > self.max_wait:
                raise ApiAsrError(f"every ASR API key is rate limited "
                                  f"(next one free in {wake:.0f}s)")
            print(f"⏳ [ASR] all {len(live)} key(s) rate limited — waiting {wake:.0f}s",
                  flush=True)
            self.sleep(wake + 0.5)
            waited += wake + 0.5

    def rate_limited(self, key, seconds):
        with self.lock:
            self.rest_until[key] = max(self.rest_until.get(key, 0), self.clock() + seconds)
        print(f"🔁 [ASR] key {_mask(key)} rate limited for {seconds:.0f}s — "
              f"switching key", flush=True)

    def rejected(self, key):
        with self.lock:
            self.dead.add(key)
        print(f"🚫 [ASR] key {_mask(key)} rejected — skipping it", flush=True)


def _retry_after(response, default=60.0):
    """Seconds the API asks us to wait: retry-after, else Groq's reset header
    ("7.66s", "2m59.56s"), else ``default``."""
    h = response.headers
    try:
        if h.get("retry-after"):
            return max(1.0, float(h["retry-after"]))
    except ValueError:
        pass
    for name in ("x-ratelimit-reset-audio-seconds", "x-ratelimit-reset-requests",
                 "x-ratelimit-reset-tokens"):
        v = h.get(name)
        if not v:
            continue
        total, num = 0.0, ""
        for ch in v:
            if ch.isdigit() or ch == ".":
                num += ch
            elif num:
                total += float(num) * {"h": 3600, "m": 60, "s": 1}.get(ch, 0)
                num = ""
        if num:
            total += float(num)
        if total > 0:
            return max(1.0, total)
    return default


def _cfg():
    def num(name, default):
        try:
            return max(1, int(os.environ.get(name, "") or default))
        except ValueError:
            return default
    try:
        max_wait = max(0.0, float(os.environ.get("ASR_API_MAX_WAIT", "") or 90))
    except ValueError:
        max_wait = 90.0
    return {
        "keys": _keys_from_env(),
        "max_wait": max_wait,
        "base": (os.environ.get("ASR_API_BASE_URL") or DEFAULT_BASE_URL).rstrip("/"),
        "model": (os.environ.get("ASR_API_MODEL") or DEFAULT_MODEL).strip(),
        "language": (os.environ.get("ASR_API_LANGUAGE") or "").strip().lower() or None,
        "chunk": num("ASR_API_CHUNK_SECONDS", 600),
        "parallel": num("ASR_API_PARALLEL", 3),
    }


def _duration(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                          "-of", "csv=p=0", path], capture_output=True, text=True, timeout=60)
    try:
        return float(out.stdout.strip().splitlines()[0])
    except (ValueError, IndexError):
        raise ApiAsrError("could not read the media duration")


def _encode_chunk(media_path, start, length, out_path):
    cmd = ["ffmpeg", "-v", "error", "-y", "-ss", f"{start:.3f}", "-t", f"{length:.3f}",
           "-i", media_path, "-vn", "-ac", "1", "-ar", "16000",
           "-c:a", "libmp3lame", "-b:a", "32k", out_path]
    res = subprocess.run(cmd, capture_output=True, timeout=600)
    if res.returncode != 0:
        raise ApiAsrError(f"ffmpeg could not extract audio: {res.stderr.decode(errors='replace')[-300:]}")


def _post(cfg, path, pool):
    """One chunk. A rate-limited or rejected key hands the same chunk to the
    next key; server errors and network hiccups are retried a few times."""
    import httpx
    # httpx takes a dict for multipart fields; a repeated field is a list.
    data = {"model": cfg["model"], "response_format": "verbose_json",
            "timestamp_granularities[]": ["word", "segment"], "temperature": "0"}
    if cfg["language"]:
        data["language"] = cfg["language"]
    last = None
    failures = 0
    while failures < 3:
        key = pool.acquire()
        try:
            with open(path, "rb") as f:
                r = httpx.post(f"{cfg['base']}/audio/transcriptions",
                               headers={"Authorization": f"Bearer {key}"},
                               data=data, files={"file": (os.path.basename(path), f, "audio/mpeg")},
                               timeout=600)
        except Exception as e:  # network hiccup: retry
            last = f"{type(e).__name__}: {e}"
            failures += 1
            time.sleep(5 * failures)
            continue
        if r.status_code == 200:
            return r.json()
        last = f"HTTP {r.status_code}: {r.text[:300]}"
        if r.status_code == 429:
            pool.rate_limited(key, _retry_after(r))
        elif r.status_code in (401, 403):
            pool.rejected(key)
        elif r.status_code in (500, 502, 503, 504):
            failures += 1
            time.sleep(5 * failures)
        else:
            break  # a bad request: another key would get the same answer
    raise ApiAsrError(last or "transcription request failed")


def _language_code(value, text):
    v = (value or "").strip().lower()
    if len(v) == 2:
        return v
    if v in _LANG_NAMES:
        return _LANG_NAMES[v]
    from transcribe_backends import _detect_language
    return _detect_language(text)


def _segments_from(resp, offset):
    """[(segment dict with absolute times and its words)] for one chunk."""
    words = []
    for w in resp.get("words") or []:
        text = (w.get("word") or "").strip()
        if not text:
            continue
        words.append({"word": " " + text,
                      "start": float(w["start"]) + offset,
                      "end": float(w["end"]) + offset})
    segs = []
    for s in resp.get("segments") or []:
        text = (s.get("text") or "").strip()
        if not text:
            continue
        segs.append({"start": float(s["start"]) + offset, "end": float(s["end"]) + offset,
                     "text": " " + text, "words": []})
    if not segs and words:
        segs = [{"start": words[0]["start"], "end": words[-1]["end"],
                 "text": " " + " ".join(w["word"].strip() for w in words), "words": []}]
    # Each word joins the last segment that starts at or before it.
    i = 0
    for w in words:
        while i + 1 < len(segs) and segs[i + 1]["start"] <= w["start"]:
            i += 1
        if segs:
            segs[i]["words"].append(w)
    for s in segs:
        if s["words"]:
            s["start"] = min(s["start"], s["words"][0]["start"])
            s["end"] = max(s["end"], s["words"][-1]["end"])
    return segs


def transcribe(media_path):
    cfg = _cfg()
    if not cfg["keys"]:
        raise ApiAsrError("ASR_API_KEY is not set")
    pool = KeyPool(cfg["keys"], max_wait=cfg["max_wait"])
    total = _duration(media_path)
    chunk = float(cfg["chunk"])
    starts = []
    t = 0.0
    while t < total:
        starts.append(t)
        t += chunk
    tmp = tempfile.mkdtemp(prefix="asr_api_")
    print(f"🎙️ [ASR] online whisper ({cfg['model']} @ {cfg['base']}, "
          f"{len(cfg['keys'])} key(s)): {total:.0f}s in {len(starts)} chunk(s)", flush=True)
    done = {"n": 0}

    def work(idx):
        start = starts[idx]
        path = os.path.join(tmp, f"chunk_{idx:03d}.mp3")
        _encode_chunk(media_path, start, min(chunk, total - start), path)
        resp = _post(cfg, path, pool)
        done["n"] += 1
        print(f"🎙️ Transcribing… {int(100 * done['n'] / len(starts))}% "
              f"(chunk {done['n']}/{len(starts)})", flush=True)
        return resp, start

    try:
        with ThreadPoolExecutor(max_workers=cfg["parallel"]) as executor:
            results = list(executor.map(work, range(len(starts))))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    segments, langs = [], []
    for resp, offset in results:
        segments.extend(_segments_from(resp, offset))
        langs.append(resp.get("language"))
    text = " ".join(s["text"].strip() for s in segments).strip()
    if not any(s["words"] for s in segments):
        raise ApiAsrError("the API returned no words")
    language = cfg["language"] or _language_code(next((l for l in langs if l), None), text)
    return {"text": text, "language": language, "segments": segments}
