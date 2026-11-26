"""Spoken hook: the hook text read aloud by Gemini TTS, as an intro.

The voice is generated once per (text, voice) and kept next to the clip as a
dot file (``.hookvoice_<hash>.wav``), so changing only the speed never asks
Gemini again. Speed is applied with ffmpeg ``atempo``: the whole line is
played faster (or slower), never cut, and the pitch stays the same.

The voice is PREPENDED, never laid over the clip: the first frame (with the
burned hook text) is held for as long as the voice plays, then the clip runs
whole with its own audio untouched. A 28 s clip with a 4 s voice is 32 s.
Because it shifts the timeline, it is the LAST layer (after the captions).
"""
import hashlib
import os
import subprocess
import uuid
import wave

from ffmpeg_utils import METADATA_SCRUB, QUALITY, video_encode_args

# Gemini TTS models, tried in order. GEMINI_TTS_MODEL goes first when set.
_DEFAULT_MODELS = ("gemini-2.5-flash-preview-tts", "gemini-2.5-pro-preview-tts")

# Gemini's prebuilt voices offered in the editor (the API accepts more).
VOICES = ("Kore", "Puck", "Charon", "Fenrir", "Aoede", "Leda", "Orus", "Zephyr")
DEFAULT_VOICE = "Kore"

MIN_SPEED, MAX_SPEED = 0.5, 3.0
MAX_TEXT_CHARS = 400

# Gemini TTS returns raw 16-bit little-endian mono PCM at 24 kHz.
_PCM_RATE = 24000

PREFIX = ".hookvoice_"


def _models():
    first = (os.environ.get("GEMINI_TTS_MODEL") or "").strip()
    return ([first] if first else []) + [m for m in _DEFAULT_MODELS if m != first]


def clamp_speed(speed):
    try:
        speed = float(speed)
    except (TypeError, ValueError):
        return 1.0
    if speed != speed:  # NaN
        return 1.0
    return min(MAX_SPEED, max(MIN_SPEED, speed))


def voice_name(voice):
    return voice if voice in VOICES else DEFAULT_VOICE


def cache_path(output_dir, text, voice):
    key = hashlib.sha1(f"{voice_name(voice)}\n{text.strip()}".encode("utf-8")).hexdigest()[:16]
    return os.path.join(output_dir, f"{PREFIX}{key}.wav")


def wav_duration(path):
    with wave.open(path, "rb") as w:
        return w.getnframes() / float(w.getframerate())


def _synthesize_pcm(text, api_key, voice):
    from google import genai
    from google.genai import types

    client = genai.Client(api_key=api_key)
    config = types.GenerateContentConfig(
        response_modalities=["AUDIO"],
        speech_config=types.SpeechConfig(
            voice_config=types.VoiceConfig(
                prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name=voice))),
    )
    last = None
    for model in _models():
        try:
            resp = client.models.generate_content(model=model, contents=text, config=config)
            for cand in resp.candidates or []:
                for part in (cand.content.parts if cand.content else None) or []:
                    data = getattr(part.inline_data, "data", None) if part.inline_data else None
                    if data:
                        return data
            last = RuntimeError(f"{model} returned no audio")
        except Exception as e:  # model missing/retired: try the next one
            last = e
            print(f"⚠️ Gemini TTS with {model} failed: {e}")
    raise RuntimeError(f"Gemini TTS failed: {last}")


def ensure_voice(output_dir, text, voice, api_key):
    """Path to the spoken hook (WAV), generating it with Gemini if not cached.
    Returns (path, duration_seconds)."""
    text = (text or "").strip()
    if not text:
        raise ValueError("Hook text is empty")
    if len(text) > MAX_TEXT_CHARS:
        raise ValueError(f"Hook text is too long for a voice (max {MAX_TEXT_CHARS} characters)")
    voice = voice_name(voice)
    path = cache_path(output_dir, text, voice)
    if not os.path.exists(path):
        if not api_key:
            raise ValueError("A Gemini API key is needed to generate the hook voice")
        pcm = _synthesize_pcm(text, api_key, voice)
        tmp = f"{path}.{uuid.uuid4().hex[:8]}.part"
        with wave.open(tmp, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(_PCM_RATE)
            w.writeframes(pcm)
        os.replace(tmp, path)
    return path, wav_duration(path)


def _atempo_chain(speed):
    """atempo takes 0.5..2.0 per stage on older ffmpeg builds: chain stages."""
    stages = []
    s = speed
    while s > 2.0:
        stages.append(2.0)
        s /= 2.0
    while s < 0.5:
        stages.append(0.5)
        s /= 0.5
    stages.append(s)
    return ",".join(f"atempo={x:.6f}" for x in stages)


def _has_audio(video_path):
    try:
        out = subprocess.check_output(
            ["ffprobe", "-v", "error", "-select_streams", "a", "-show_entries",
             "stream=index", "-of", "csv=p=0", video_path], timeout=60).decode().strip()
        return bool(out)
    except Exception:
        return False


def mix_into(video_path, voice_path, speed, output_path):
    """Write ``output_path`` = the voice (played at ``speed``) over the held
    first frame, followed by the whole of ``video_path``. Returns the intro's
    length in seconds (the clip grows by exactly that)."""
    speed = clamp_speed(speed)
    played = round(wav_duration(voice_path) / speed, 3)
    tempo = _atempo_chain(speed)
    fmt = "aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo"
    # Voice trimmed/padded to exactly `played` so audio and the held frame
    # line up to the millisecond; then the clip's own audio follows.
    intro = f"[1:a]{tempo},{fmt},apad,atrim=0:{played:.3f},asetpts=PTS-STARTPTS[vo]"
    video = f"[0:v]tpad=start_duration={played:.3f}:start_mode=clone[v]"
    if _has_audio(video_path):
        audio = f"[0:a]{fmt},asetpts=PTS-STARTPTS[ca];[vo][ca]concat=n=2:v=0:a=1[a]"
    else:
        audio = "[vo]apad[a]"
    cmd = ["ffmpeg", "-y", "-i", video_path, "-i", voice_path,
           "-filter_complex", f"{video};{intro};{audio}",
           "-map", "[v]", "-map", "[a]",
           *video_encode_args(QUALITY), "-c:a", "aac", "-b:a", "192k",
           *([] if _has_audio(video_path) else ["-shortest"]),
           *METADATA_SCRUB, "-movflags", "+faststart", output_path]
    res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=600)
    if res.returncode != 0:
        tail = res.stderr.decode(errors="replace").strip().splitlines()[-3:]
        raise RuntimeError(f"ffmpeg voice mix failed: {' | '.join(tail)}")
    return played


def voiced_name(filename):
    """The outermost layer's name: ``voiced_<ts>_<file>`` (app.py strips it
    first, before captions and the hook)."""
    import time
    return f"voiced_{int(time.time())}_{filename}"


def apply(video_path, output_path, text, voice, speed, api_key):
    """Write ``output_path`` = the spoken hook followed by ``video_path``
    (via a temp file). Returns {"voice", "speed", "duration", "played"}."""
    output_dir = os.path.dirname(output_path)
    path, duration = ensure_voice(output_dir, text, voice, api_key)
    tmp = os.path.join(output_dir, f".part_{uuid.uuid4().hex[:8]}_{os.path.basename(output_path)}")
    try:
        played = mix_into(video_path, path, speed, tmp)
        os.replace(tmp, output_path)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)
    return {"voice": voice_name(voice), "speed": clamp_speed(speed),
            "duration": round(duration, 3), "played": round(played, 3)}
