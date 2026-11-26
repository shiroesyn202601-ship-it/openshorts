import React, { useState, useEffect, useRef } from 'react';
import { Loader2, Play, Square } from 'lucide-react';
import RemotionPreview from './RemotionPreview';
import Modal from './ui/Modal';
import SegmentedControl from './ui/SegmentedControl';
import { apiFetch } from '../lib/api';

// Must mirror hook_voice.py VOICES / MIN_SPEED / MAX_SPEED.
const VOICE_OPTIONS = ['Kore', 'Puck', 'Charon', 'Fenrir', 'Aoede', 'Leda', 'Orus', 'Zephyr'];
const MIN_SPEED = 0.5;
const MAX_SPEED = 3.0;
const round1 = (x) => Math.round(x * 10) / 10;

const ENTRANCE_OPTIONS = [
    { value: 'spring', label: 'Bounce' },
    { value: 'fade', label: 'Fade' },
    { value: 'slide-up', label: 'Slide Up' },
    { value: 'none', label: 'None' },
];

// Must mirror hooks.py HOOK_STYLES.
const HOOK_STYLES = [
    { value: 'pill', label: 'Pills', box: 'rgba(255,255,255,0.98)', text: '#000', sans: true },
    { value: 'classic', label: 'Classic', box: 'rgba(255,255,255,0.94)', text: '#000' },
    { value: 'dark', label: 'Dark', box: 'rgba(18,18,20,0.92)', text: '#fff' },
    { value: 'yellow', label: 'Yellow', box: 'rgba(255,214,0,0.96)', text: '#000' },
    { value: 'red', label: 'Red', box: 'rgba(220,38,38,0.96)', text: '#fff' },
    { value: 'outline', label: 'Outline', box: 'transparent', text: '#fff', outline: true },
    { value: 'outline_yellow', label: 'Outline+', box: 'transparent', text: '#FFD600', outline: true },
];

// Must mirror hooks.py HOOK_FONTS (all bundled: /fonts/*.ttf).
const FONT_OPTIONS = [
    { value: 'montserrat', label: 'Montserrat' },
    { value: 'anton', label: 'Anton' },
    { value: 'serif', label: 'Serif' },
];
const FONT_CSS = {
    montserrat: { fontFamily: "'Montserrat-ExtraBold', 'Montserrat', sans-serif", fontWeight: 800 },
    anton: { fontFamily: "'Anton-Regular', Impact, sans-serif", fontWeight: 400 },
    serif: { fontFamily: "'Noto Serif', Georgia, serif", fontWeight: 700 },
};
// The style's own typeface when none is picked (what hooks.py renders).
const styleFont = (st) => (st === 'pill' ? 'montserrat' : 'serif');

// auto: the server keeps the hook off the speaker's face and the captions
// (hook_placement.py). The preview cannot see faces and draws it at the top.
const POSITION_OPTIONS = [
    { value: 'auto', label: 'auto' },
    { value: 'top', label: 'top' },
    { value: 'center', label: 'center' },
    { value: 'bottom', label: 'bottom' },
];

const SIZE_OPTIONS = [
    { value: 'S', label: 'Small' },
    { value: 'M', label: 'Medium' },
    { value: 'L', label: 'Large' },
];

// Last-used hook settings, restored on the next open (style always reset to
// classic otherwise, which users read as the picker being broken).
function loadHookPrefs() {
    try { return JSON.parse(localStorage.getItem('os_hook_prefs')) || {}; } catch { return {}; }
}

export default function HookModal({ isOpen, onClose, onGenerate, onRemove, isProcessing, videoUrl, initialText, durationInSeconds, existingSubtitles, hasCaptions, serverRender, burnedHook, jobId, geminiApiKey }) {
    const prefs = loadHookPrefs();
    const [text, setText] = useState(initialText || 'POV: You are using the viral hook feature');
    // Stored as `pos`, not `position`: before 'auto' existed every save wrote
    // 'top' whether or not the user ever touched the control.
    const [position, setPosition] = useState(prefs.pos || 'auto');
    const [size, setSize] = useState(prefs.size || 'M');
    const [style, setStyle] = useState(prefs.style || 'pill');
    // null = follow the style's own typeface.
    const [font, setFont] = useState(prefs.font || null);
    const effectiveFont = font || styleFont(style);
    const [entranceAnimation, setEntranceAnimation] = useState(prefs.entranceAnimation || 'spring');
    const [displayDuration, setDisplayDuration] = useState(5);

    // Spoken hook (Gemini TTS). voiceDur is the natural length of the line;
    // targetDur is how long the user wants it to last. Speed = voiceDur /
    // targetDur: the whole line is played faster, nothing is cut.
    const [voiceOn, setVoiceOn] = useState(!!prefs.voiceOn);
    const [voiceName, setVoiceName] = useState(prefs.voiceName || 'Kore');
    const [voiceText, setVoiceText] = useState(null); // text the current audio was made from
    const [voiceUrl, setVoiceUrl] = useState(null);
    const [voiceDur, setVoiceDur] = useState(null);
    const [targetDur, setTargetDur] = useState(null);
    const [voiceLoading, setVoiceLoading] = useState(false);
    const [voiceError, setVoiceError] = useState(null);
    const [playing, setPlaying] = useState(false);
    const audioRef = useRef(null);

    const voiceStale = voiceText !== null && (voiceText.text !== text.trim() || voiceText.name !== voiceName);
    const voiceReady = !!voiceUrl && !voiceStale;
    const speed = voiceReady && targetDur
        ? Math.min(MAX_SPEED, Math.max(MIN_SPEED, voiceDur / targetDur))
        : 1.0;

    useEffect(() => () => {
        if (audioRef.current) audioRef.current.pause();
        if (voiceUrl) URL.revokeObjectURL(voiceUrl);
    }, [voiceUrl]);

    useEffect(() => {
        if (!isOpen && audioRef.current) { audioRef.current.pause(); setPlaying(false); }
    }, [isOpen]);

    const generateVoice = async () => {
        setVoiceLoading(true);
        setVoiceError(null);
        try {
            const res = await apiFetch('/api/hook/voice/preview', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(geminiApiKey ? { 'X-Gemini-Key': geminiApiKey } : {}),
                },
                body: JSON.stringify({ job_id: jobId, text: text.trim(), voice_name: voiceName }),
            });
            if (!res.ok) {
                let msg = await res.text();
                try { msg = JSON.parse(msg).detail || msg; } catch { /* plain text */ }
                throw new Error(msg);
            }
            const dur = parseFloat(res.headers.get('X-Voice-Duration')) || null;
            const blob = await res.blob();
            setVoiceUrl(URL.createObjectURL(blob));
            setVoiceText({ text: text.trim(), name: voiceName });
            setVoiceDur(dur);
            setTargetDur(dur ? round1(dur) : null);
        } catch (e) {
            setVoiceError(e.message || 'Could not generate the voice');
        } finally {
            setVoiceLoading(false);
        }
    };

    // Instant intro preview, no render: the first frame held with the hook
    // text while the voice plays at its speed, then the clip runs with its
    // own audio (what the server will render: hook_voice.py).
    const [intro, setIntro] = useState(null); // null | 'voice' | 'video'
    const [introText, setIntroText] = useState(true);
    const introVideoRef = useRef(null);

    const stopIntro = () => {
        if (audioRef.current) audioRef.current.pause();
        if (introVideoRef.current) introVideoRef.current.pause();
        setPlaying(false);
        setIntro(null);
    };

    const startIntro = () => {
        if (!voiceReady) return;
        if (audioRef.current) audioRef.current.pause();
        setPlaying(false);
        setIntroText(true);
        setIntro('voice');
        const a = new Audio(voiceUrl);
        a.preservesPitch = true;
        a.playbackRate = speed;
        a.onended = () => {
            setIntro('video');
            const v = introVideoRef.current;
            if (v) { v.currentTime = 0; v.muted = false; v.play().catch(() => {}); }
        };
        audioRef.current = a;
        const v = introVideoRef.current;
        if (v) { v.pause(); v.currentTime = 0; }
        a.play().catch(() => setIntro(null));
    };

    useEffect(() => {
        if (!isOpen) setIntro(null);
    }, [isOpen]);

    const togglePlay = () => {
        if (!voiceReady) return;
        setIntro(null);
        if (playing && audioRef.current) {
            audioRef.current.pause();
            setPlaying(false);
            return;
        }
        if (audioRef.current) audioRef.current.pause();
        const a = new Audio(voiceUrl);
        a.preservesPitch = true;
        a.playbackRate = speed;
        a.onended = () => setPlaying(false);
        audioRef.current = a;
        a.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
    };

    if (!isOpen) return null;

    // Build hook config for Remotion preview
    const hookConfig = {
        text: text || 'Enter your text...',
        position,
        size,
        style,
        font: effectiveFont,
        entranceAnimation,
        displayDurationSec: displayDuration,
    };

    const useRemotionPreview = !!videoUrl;

    // Fallback preview logic (same as original)
    const getPositionClass = () => {
        switch (position) {
            case 'center': return 'items-center justify-center';
            case 'bottom': return 'items-center justify-end pb-[20%]';
            case 'top': default: return 'items-center justify-start pt-[20%]';
        }
    };

    const getSizeStyle = () => {
        switch (size) {
            case 'S': return { fontSize: '14px', maxWidth: '80%' };
            case 'L': return { fontSize: '24px', maxWidth: '95%' };
            case 'M': default: return { fontSize: '18px', maxWidth: '90%' };
        }
    };

    const pillFontFace = "@font-face{font-family:'Montserrat-ExtraBold';src:url('/fonts/Montserrat-ExtraBold.ttf') format('truetype');font-weight:800;}"
        + "@font-face{font-family:'Anton-Regular';src:url('/fonts/Anton-Regular.ttf') format('truetype');font-weight:400;}";

    return (
        <Modal isOpen={isOpen} onClose={onClose} size="lg" eyebrow="EDITOR · HOOK" title="edit hook">
            <style>{pillFontFace}</style>
            <div className="flex flex-col md:flex-row gap-6">
                {/* Left: Preview */}
                <div className="w-full max-w-[300px] mx-auto md:mx-0 md:w-[300px] shrink-0 self-start flex flex-col items-center justify-center bg-black rounded-card border border-rule overflow-hidden relative aspect-[9/16]">
                    {intro ? (
                        <>
                            <video
                                ref={introVideoRef}
                                src={videoUrl}
                                className="w-full h-full object-contain"
                                playsInline
                                preload="auto"
                                onTimeUpdate={(e) => setIntroText(e.currentTarget.currentTime < displayDuration)}
                                onEnded={() => setIntro(null)}
                            />
                            {introText && (
                                <div className={`absolute w-full px-6 text-center pointer-events-none flex flex-col h-full ${getPositionClass()}`}>
                                    <div
                                        className="font-bold px-3 py-2 rounded-xl text-center whitespace-pre-wrap"
                                        style={{
                                            ...getSizeStyle(),
                                            ...FONT_CSS[effectiveFont],
                                            backgroundColor: (HOOK_STYLES.find((s) => s.value === style) || HOOK_STYLES[0]).box,
                                            color: (HOOK_STYLES.find((s) => s.value === style) || HOOK_STYLES[0]).text,
                                        }}
                                    >
                                        {text}
                                    </div>
                                </div>
                            )}
                            <div className="absolute top-2 left-2 right-2 flex items-center justify-between">
                                <span className="readout bg-black/60 px-1.5 py-0.5 rounded">
                                    {intro === 'voice' ? `intro ${targetDur?.toFixed(1)}s` : 'clip'}
                                </span>
                                <button onClick={stopIntro} className="readout bg-black/60 px-1.5 py-0.5 rounded hover:text-ink">
                                    stop
                                </button>
                            </div>
                        </>
                    ) : useRemotionPreview ? (
                        <RemotionPreview
                            videoUrl={videoUrl}
                            durationInSeconds={durationInSeconds || 30}
                            hook={hookConfig}
                            subtitles={existingSubtitles || null}
                        />
                    ) : (
                        <>
                            <video src={videoUrl} className="w-full h-full object-contain opacity-50" muted playsInline />
                            <div className={`absolute w-full px-8 text-center transition-all duration-300 pointer-events-none flex flex-col h-full ${getPositionClass()}`}>
                                <div
                                    className="text-black font-bold px-3 py-2 rounded-xl shadow-2xl text-center whitespace-pre-wrap transition-all duration-200"
                                    style={{
                                        ...getSizeStyle(),
                                        backgroundColor: 'rgba(255, 255, 255, 0.82)',
                                        ...FONT_CSS[effectiveFont],
                                        boxShadow: '0 4px 15px rgba(0,0,0,0.5)',
                                        paddingTop: '10px',
                                        paddingBottom: '10px',
                                        paddingLeft: '12px',
                                        paddingRight: '12px'
                                    }}
                                >
                                    {text || "Enter your text..."}
                                </div>
                            </div>
                        </>
                    )}
                </div>

                {/* Right: Controls */}
                <div className="w-full md:w-80 flex flex-col">
                    <div className="space-y-5 flex-1 overflow-y-auto custom-scrollbar pr-1">
                        {/* Text Input */}
                        <div>
                            <p className="eyebrow mb-2">Text</p>
                            <textarea
                                value={text}
                                onChange={(e) => setText(e.target.value)}
                                rows={4}
                                className="input-field resize-none"
                                placeholder="Enter text that will stop the scroll..."
                            />
                        </div>

                        {/* Style (new) */}
                        <div>
                            <p className="eyebrow mb-2">Style</p>
                            <div className="grid grid-cols-3 gap-1.5">
                                {HOOK_STYLES.map((s) => (
                                    <button
                                        key={s.value}
                                        onClick={() => setStyle(s.value)}
                                        className={`px-1 py-2 rounded-input border text-xs transition-colors
                                            ${style === s.value ? 'border-[color:var(--color-accent)]' : 'border-rule2 hover:border-[color:var(--color-accent)]'}`}
                                        title={s.label}
                                    >
                                        {s.value === 'pill' ? (
                                            <span className="flex flex-col items-center gap-0.5 py-0.5" style={FONT_CSS[font || styleFont(s.value)]}>
                                                <span className="rounded-md px-1.5 text-[13px] leading-5 bg-white text-black">Aa Bb</span>
                                                <span className="rounded-md px-1.5 text-[13px] leading-5 bg-white text-black">Cc</span>
                                            </span>
                                        ) : (
                                            <span
                                                className="block rounded-md px-1 py-1.5 text-[15px] leading-5"
                                                style={{
                                                    ...FONT_CSS[font || styleFont(s.value)],
                                                    backgroundColor: s.box,
                                                    color: s.text,
                                                    textShadow: s.outline ? '-1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000' : 'none',
                                                }}
                                            >Aa</span>
                                        )}
                                        <span className="block mt-1 text-muted">{s.label}</span>
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* Typeface */}
                        <div>
                            <p className="eyebrow mb-2">Font</p>
                            <div className="grid grid-cols-3 gap-1.5">
                                {FONT_OPTIONS.map((f) => (
                                    <button
                                        key={f.value}
                                        onClick={() => setFont(f.value)}
                                        className={`px-1 py-2 rounded-input border text-[15px] text-ink transition-colors
                                            ${effectiveFont === f.value ? 'border-[color:var(--color-accent)]' : 'border-rule2 hover:border-[color:var(--color-accent)]'}`}
                                        style={FONT_CSS[f.value]}
                                    >
                                        {f.label}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* Position Control */}
                        <div>
                            <p className="eyebrow mb-2">Position</p>
                            <SegmentedControl
                                options={POSITION_OPTIONS}
                                value={position}
                                onChange={setPosition}
                                size="sm"
                            />
                            {position === 'auto' && (
                                <p className="text-[11px] text-muted mt-1.5 leading-relaxed">
                                    Placed where it covers no face and no captions.
                                    The preview shows it at the top.
                                </p>
                            )}
                            {position === 'bottom' && hasCaptions && (
                                <p className="text-[11px] text-warn mt-1.5 leading-relaxed">
                                    This clip has captions near the bottom — the hook may
                                    overlap them (and TikTok's UI). Top is the safe zone.
                                </p>
                            )}
                        </div>

                        {/* Size Control */}
                        <div>
                            <p className="eyebrow mb-2">Size</p>
                            <SegmentedControl
                                options={SIZE_OPTIONS}
                                value={size}
                                onChange={setSize}
                                size="sm"
                            />
                        </div>

                        {/* Entrance Animation (new) */}
                        {!serverRender && !voiceOn && (
                        <div>
                            <p className="eyebrow mb-2">Entrance</p>
                            <SegmentedControl
                                options={ENTRANCE_OPTIONS}
                                value={entranceAnimation}
                                onChange={setEntranceAnimation}
                                columns={2}
                                size="sm"
                            />
                        </div>
                        )}

                        {/* Display Duration (new) */}
                        <div>
                            <div className="flex items-center justify-between mb-2">
                                <p className="eyebrow">Duration</p>
                                <span className="readout">{displayDuration}S</span>
                            </div>
                            <input
                                type="range"
                                min="2"
                                max="15"
                                value={displayDuration}
                                onChange={(e) => setDisplayDuration(parseInt(e.target.value))}
                                className="w-full accent-[var(--color-accent)]"
                            />
                            <div className="flex justify-between">
                                <span className="readout">2S</span>
                                <span className="readout">15S</span>
                            </div>
                        </div>

                        {/* Spoken hook (Gemini TTS) */}
                        <div>
                            <label className="flex items-center justify-between cursor-pointer">
                                <p className="eyebrow">Voice</p>
                                <input
                                    type="checkbox"
                                    checked={voiceOn}
                                    onChange={(e) => setVoiceOn(e.target.checked)}
                                    className="accent-[var(--color-accent)]"
                                />
                            </label>
                            <p className="text-[11px] text-muted mt-1 leading-relaxed">
                                Read the hook aloud with a Gemini voice as an intro: the first
                                frame is held while it plays, then the whole clip follows
                                (nothing is cut, the clip gets longer by the voice length).
                            </p>
                            {voiceOn && (
                                <div className="mt-3 space-y-3">
                                    <div className="flex gap-2">
                                        <select
                                            value={voiceName}
                                            onChange={(e) => setVoiceName(e.target.value)}
                                            className="input-field flex-1"
                                        >
                                            {VOICE_OPTIONS.map((v) => <option key={v} value={v}>{v}</option>)}
                                        </select>
                                        <button
                                            onClick={generateVoice}
                                            disabled={voiceLoading || !text.trim()}
                                            className="btn-ghost shrink-0"
                                        >
                                            {voiceLoading && <Loader2 size={14} className="animate-spin" />}
                                            {voiceLoading ? 'generating...' : (voiceReady ? 'regenerate' : 'generate voice')}
                                        </button>
                                    </div>
                                    {voiceStale && (
                                        <p className="text-[11px] text-warn">Text or voice changed: generate the voice again.</p>
                                    )}
                                    {voiceError && (
                                        <p className="text-[11px] text-warn break-words">{voiceError}</p>
                                    )}
                                    {voiceReady && voiceDur && (
                                        <div className="space-y-2">
                                            <div className="flex items-center justify-between">
                                                <div className="flex gap-2">
                                                    <button onClick={togglePlay} className="btn-ghost">
                                                        {playing ? <Square size={14} /> : <Play size={14} />}
                                                        {playing ? 'stop' : 'listen'}
                                                    </button>
                                                    <button onClick={intro ? stopIntro : startIntro} className="btn-ghost" disabled={!videoUrl}>
                                                        {intro ? <Square size={14} /> : <Play size={14} />}
                                                        {intro ? 'stop' : 'preview intro'}
                                                    </button>
                                                </div>
                                                <span className="readout">{speed.toFixed(2)}x</span>
                                            </div>
                                            <div className="flex items-center justify-between">
                                                <p className="eyebrow">Voice length</p>
                                                <span className="readout">{voiceDur.toFixed(1)}S → {targetDur?.toFixed(1)}S</span>
                                            </div>
                                            <input
                                                type="range"
                                                min={Math.max(0.3, round1(voiceDur / MAX_SPEED + 0.05))}
                                                max={round1(voiceDur / MIN_SPEED)}
                                                step="0.1"
                                                value={targetDur || voiceDur}
                                                onChange={(e) => {
                                                    setTargetDur(parseFloat(e.target.value));
                                                    if (audioRef.current) { audioRef.current.pause(); setPlaying(false); }
                                                }}
                                                className="w-full accent-[var(--color-accent)]"
                                            />
                                            <p className="text-[11px] text-muted leading-relaxed">
                                                Shorter = the whole line is played faster (same pitch), nothing is cut.
                                            </p>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>

                        {burnedHook && (
                            <div className="p-3 border border-rule rounded-input text-xs text-muted space-y-2">
                                <p>
                                    This clip has a hook burned in ("{burnedHook}").
                                    Generating replaces it with the new one.
                                </p>
                                {onRemove && (
                                    <button
                                        onClick={onRemove}
                                        disabled={isProcessing}
                                        className="text-warn underline underline-offset-2 hover:opacity-80 transition-opacity"
                                    >
                                        remove hook from clip
                                    </button>
                                )}
                            </div>
                        )}

                        <div className="p-3 border border-rule rounded-input text-xs text-muted">
                            Tip: keep it short and punchy. Using "POV:" or specific questions works best for retention.
                        </div>
                    </div>

                    <div className="flex gap-2 mt-5 shrink-0">
                        <button onClick={onClose} className="btn-ghost">
                            cancel
                        </button>
                        <button
                            onClick={() => {
                                try {
                                    localStorage.setItem('os_hook_prefs', JSON.stringify({
                                        style, font, pos: position, size, entranceAnimation,
                                        voiceOn, voiceName,
                                    }));
                                } catch { /* ignore */ }
                                if (audioRef.current) { audioRef.current.pause(); setPlaying(false); }
                                onGenerate({
                                    text, position, size, style, font: effectiveFont,
                                    // Remotion data
                                    remotion: hookConfig,
                                    voice: voiceOn ? { enabled: true, name: voiceName, speed } : null,
                                });
                            }}
                            disabled={isProcessing || !text.trim() || (voiceOn && !voiceReady)}
                            className="btn-primary flex-1"
                        >
                            {isProcessing && <Loader2 size={16} className="animate-spin text-brassink" />}
                            {isProcessing ? 'saving...' : (burnedHook ? 'update hook' : 'add hook')}
                        </button>
                    </div>
                </div>
            </div>
        </Modal>
    );
}
