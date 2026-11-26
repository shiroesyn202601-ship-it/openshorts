import React, { useState, useEffect, useRef } from 'react';
import { Loader2, Upload, X } from 'lucide-react';
import Modal from './ui/Modal';
import SegmentedControl from './ui/SegmentedControl';
import { apiFetch } from '../lib/api';

// Overlay + blur + logo, previewed live with CSS over the video. Nothing is
// rendered until "apply": the server (clip_style.py) then burns exactly
// what the preview shows, under the hook and the captions.
// Must mirror clip_style.py (PREVIEW_WIDTH, DIRECTIONS, POSITIONS).
const PREVIEW_WIDTH = 360;

const TYPE_OPTIONS = [
    { value: 'none', label: 'none' },
    { value: 'solid', label: 'solid' },
    { value: 'gradient', label: 'gradient' },
    { value: 'image', label: 'image' },
];

const DIRECTION_OPTIONS = [
    { value: 'to_bottom', label: '↓ top→bottom' },
    { value: 'to_top', label: '↑ bottom→top' },
    { value: 'to_left', label: '← right→left' },
    { value: 'to_right', label: '→ left→right' },
    { value: 'radial', label: '◎ radial' },
];

const POSITIONS = [
    'top-left', 'top-center', 'top-right',
    'center-left', 'center', 'center-right',
    'bottom-left', 'bottom-center', 'bottom-right',
];

const CSS_DIRECTION = {
    to_bottom: 'to bottom', to_top: 'to top', to_left: 'to left', to_right: 'to right',
};

const DEFAULT_OVERLAY = {
    type: 'none', color: '#000000', color2: '#ffffff', color2_transparent: true,
    direction: 'to_top', opacity: 0.5,
};
const DEFAULT_LOGO = { position: 'top-right', size: 0.2, opacity: 1, margin: 0.04 };

function hexToRgba(hex, alpha) {
    const n = parseInt((hex || '#000000').slice(1), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = () => reject(new Error('Could not read the file'));
        r.readAsDataURL(file);
    });
}

function Slider({ label, value, min, max, step, onChange, format }) {
    return (
        <div>
            <div className="flex items-center justify-between mb-1">
                <p className="eyebrow">{label}</p>
                <span className="readout">{format ? format(value) : value}</span>
            </div>
            <input
                type="range" min={min} max={max} step={step} value={value}
                onChange={(e) => onChange(parseFloat(e.target.value))}
                className="w-full accent-[var(--color-accent)]"
            />
        </div>
    );
}

function ImagePicker({ label, src, onPick, onClear }) {
    const inputRef = useRef(null);
    return (
        <div>
            <p className="eyebrow mb-2">{label}</p>
            <div className="flex items-center gap-2">
                <button type="button" onClick={() => inputRef.current?.click()} className="btn-ghost">
                    <Upload size={14} /> {src ? 'change' : 'upload'}
                </button>
                {src && (
                    <>
                        <img src={src} alt="" className="h-9 w-9 object-contain rounded border border-rule bg-black/40" />
                        <button type="button" onClick={onClear} className="text-muted hover:text-ink" title="remove">
                            <X size={16} />
                        </button>
                    </>
                )}
                <input
                    ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden"
                    onChange={async (e) => {
                        const f = e.target.files?.[0];
                        e.target.value = '';
                        if (f) onPick(f);
                    }}
                />
            </div>
        </div>
    );
}

export default function StyleModal({ isOpen, onClose, onApply, onRemove, isProcessing, videoUrl, jobId, existingStyle }) {
    const [overlay, setOverlay] = useState({ ...DEFAULT_OVERLAY, ...(existingStyle?.overlay || {}) });
    const [blur, setBlur] = useState(existingStyle?.blur || 0);
    const [logo, setLogo] = useState({ ...DEFAULT_LOGO, ...(existingStyle?.logo || {}) });
    // Image sources for the preview: a data: URL for a freshly picked file,
    // or an object URL of the stored image of a saved style.
    const [overlaySrc, setOverlaySrc] = useState(null);
    const [logoSrc, setLogoSrc] = useState(null);
    const [overlayData, setOverlayData] = useState(null); // new upload, sent on apply
    const [logoData, setLogoData] = useState(null);
    const [error, setError] = useState(null);
    const boxRef = useRef(null);
    const [boxW, setBoxW] = useState(300);

    // Reset to the clip's saved style each time the modal opens.
    useEffect(() => {
        if (!isOpen) return;
        setOverlay({ ...DEFAULT_OVERLAY, ...(existingStyle?.overlay || {}) });
        setBlur(existingStyle?.blur || 0);
        setLogo({ ...DEFAULT_LOGO, ...(existingStyle?.logo || {}) });
        setOverlayData(null);
        setLogoData(null);
        setOverlaySrc(null);
        setLogoSrc(null);
        setError(null);
        const urls = [];
        const load = async (name, set) => {
            if (!name || !jobId) return;
            try {
                const res = await apiFetch(`/api/style/image/${jobId}/${encodeURIComponent(name)}`);
                if (!res.ok) return;
                const url = URL.createObjectURL(await res.blob());
                urls.push(url);
                set(url);
            } catch { /* preview without it */ }
        };
        load(existingStyle?.overlay?.image, setOverlaySrc);
        load(existingStyle?.logo?.image, setLogoSrc);
        return () => urls.forEach((u) => URL.revokeObjectURL(u));
    }, [isOpen, existingStyle, jobId]);

    useEffect(() => {
        if (!isOpen || !boxRef.current) return;
        const el = boxRef.current;
        const ro = new ResizeObserver(() => setBoxW(el.clientWidth || 300));
        ro.observe(el);
        setBoxW(el.clientWidth || 300);
        return () => ro.disconnect();
    }, [isOpen]);

    if (!isOpen) return null;

    const setOv = (patch) => setOverlay((o) => ({ ...o, ...patch }));
    const setLg = (patch) => setLogo((l) => ({ ...l, ...patch }));

    const pickImage = async (file, kind) => {
        setError(null);
        if (file.size > 10 * 1024 * 1024) { setError('Image is larger than 10 MB'); return; }
        try {
            const data = await readFileAsDataUrl(file);
            if (kind === 'overlay') { setOverlayData(data); setOverlaySrc(data); setOv({ type: 'image' }); }
            else { setLogoData(data); setLogoSrc(data); }
        } catch (e) { setError(e.message); }
    };

    // --- live preview (CSS mirror of clip_style.py) -----------------------
    const overlayCss = (() => {
        const base = { position: 'absolute', inset: 0, pointerEvents: 'none', opacity: overlay.opacity };
        if (overlay.type === 'solid') return { ...base, background: overlay.color };
        if (overlay.type === 'gradient') {
            const c1 = hexToRgba(overlay.color, 1);
            const c2 = overlay.color2_transparent ? hexToRgba(overlay.color, 0) : hexToRgba(overlay.color2, 1);
            const g = overlay.direction === 'radial'
                ? `radial-gradient(ellipse farthest-corner at center, ${c1}, ${c2})`
                : `linear-gradient(${CSS_DIRECTION[overlay.direction] || 'to bottom'}, ${c1}, ${c2})`;
            return { ...base, background: g };
        }
        if (overlay.type === 'image' && overlaySrc) {
            return { ...base, backgroundImage: `url(${overlaySrc})`, backgroundSize: 'cover', backgroundPosition: 'center' };
        }
        return null;
    })();

    const logoCss = (() => {
        if (!logoSrc) return null;
        const m = logo.margin * boxW;
        const [v, h] = logo.position === 'center' ? ['center', 'center'] : logo.position.split('-');
        const css = { position: 'absolute', width: `${logo.size * 100}%`, opacity: logo.opacity, pointerEvents: 'none' };
        const tf = [];
        if (h === 'left') css.left = m; else if (h === 'right') css.right = m; else { css.left = '50%'; tf.push('translateX(-50%)'); }
        if (v === 'top') css.top = m; else if (v === 'bottom') css.bottom = m; else { css.top = '50%'; tf.push('translateY(-50%)'); }
        if (tf.length) css.transform = tf.join(' ');
        return css;
    })();

    const blurPx = blur * boxW / PREVIEW_WIDTH;

    const apply = () => {
        const style = {
            overlay: { ...overlay, ...(overlayData ? { image_data: overlayData } : {}) },
            blur,
            logo: { ...logo, ...(logoData ? { image_data: logoData } : {}) },
        };
        if (!logoSrc) { delete style.logo.image; delete style.logo.image_data; }
        if (overlay.type === 'image' && !overlaySrc) style.overlay.type = 'none';
        onApply(style);
    };

    const hasSaved = !!existingStyle;

    return (
        <Modal isOpen={isOpen} onClose={onClose} size="lg" eyebrow="EDITOR · OVERLAY" title="overlay & logo">
            <div className="flex flex-col md:flex-row gap-6">
                {/* Live preview: no render until apply */}
                <div
                    ref={boxRef}
                    className="w-full max-w-[300px] mx-auto md:mx-0 md:w-[300px] shrink-0 self-start bg-black rounded-card border border-rule overflow-hidden relative aspect-[9/16]"
                >
                    <video
                        src={videoUrl}
                        className="w-full h-full object-cover"
                        style={blurPx > 0 ? { filter: `blur(${blurPx}px)`, transform: 'scale(1.04)' } : undefined}
                        controls playsInline loop muted
                    />
                    {overlayCss && <div style={overlayCss} />}
                    {logoCss && <img src={logoSrc} alt="" style={logoCss} />}
                </div>

                <div className="w-full md:w-80 flex flex-col">
                    <div className="space-y-5 flex-1 overflow-y-auto custom-scrollbar pr-1">
                        <div>
                            <p className="eyebrow mb-2">Overlay</p>
                            <SegmentedControl options={TYPE_OPTIONS} value={overlay.type} onChange={(v) => setOv({ type: v })} size="sm" />
                        </div>

                        {(overlay.type === 'solid' || overlay.type === 'gradient') && (
                            <div className="flex items-center gap-3">
                                <label className="flex items-center gap-2 text-xs text-muted">
                                    {overlay.type === 'gradient' ? 'from' : 'color'}
                                    <input type="color" value={overlay.color} onChange={(e) => setOv({ color: e.target.value })} />
                                </label>
                                {overlay.type === 'gradient' && (
                                    <>
                                        <label className="flex items-center gap-2 text-xs text-muted">
                                            to
                                            <input
                                                type="color" value={overlay.color2}
                                                disabled={overlay.color2_transparent}
                                                onChange={(e) => setOv({ color2: e.target.value })}
                                            />
                                        </label>
                                        <label className="flex items-center gap-1 text-xs text-muted">
                                            <input
                                                type="checkbox" checked={overlay.color2_transparent}
                                                onChange={(e) => setOv({ color2_transparent: e.target.checked })}
                                                className="accent-[var(--color-accent)]"
                                            />
                                            transparent
                                        </label>
                                    </>
                                )}
                            </div>
                        )}

                        {overlay.type === 'gradient' && (
                            <div>
                                <p className="eyebrow mb-2">Direction</p>
                                <SegmentedControl options={DIRECTION_OPTIONS} value={overlay.direction} onChange={(v) => setOv({ direction: v })} columns={2} size="sm" />
                            </div>
                        )}

                        {overlay.type === 'image' && (
                            <ImagePicker
                                label="Overlay image" src={overlaySrc}
                                onPick={(f) => pickImage(f, 'overlay')}
                                onClear={() => { setOverlaySrc(null); setOverlayData(null); setOv({ image: null }); }}
                            />
                        )}

                        {overlay.type !== 'none' && (
                            <Slider
                                label="Opacity" value={overlay.opacity} min={0} max={1} step={0.01}
                                onChange={(v) => setOv({ opacity: v })} format={(v) => `${Math.round(v * 100)}%`}
                            />
                        )}

                        <Slider label="Blur video" value={blur} min={0} max={20} step={0.5} onChange={setBlur} format={(v) => (v ? v : 'off')} />

                        <div className="border-t border-rule pt-4 space-y-4">
                            <ImagePicker
                                label="Logo" src={logoSrc}
                                onPick={(f) => pickImage(f, 'logo')}
                                onClear={() => { setLogoSrc(null); setLogoData(null); setLg({ image: null }); }}
                            />
                            {logoSrc && (
                                <>
                                    <div>
                                        <p className="eyebrow mb-2">Logo position</p>
                                        <div className="grid grid-cols-3 gap-1 w-32">
                                            {POSITIONS.map((p) => (
                                                <button
                                                    key={p} type="button" title={p}
                                                    onClick={() => setLg({ position: p })}
                                                    className={`h-8 rounded border transition-colors ${logo.position === p
                                                        ? 'border-[color:var(--color-accent)] bg-[color:var(--color-accent)]/30'
                                                        : 'border-rule2 hover:border-[color:var(--color-accent)]'}`}
                                                />
                                            ))}
                                        </div>
                                    </div>
                                    <Slider label="Logo size" value={logo.size} min={0.05} max={0.6} step={0.01} onChange={(v) => setLg({ size: v })} format={(v) => `${Math.round(v * 100)}%`} />
                                    <Slider label="Logo opacity" value={logo.opacity} min={0} max={1} step={0.01} onChange={(v) => setLg({ opacity: v })} format={(v) => `${Math.round(v * 100)}%`} />
                                    <Slider label="Edge margin" value={logo.margin} min={0} max={0.15} step={0.005} onChange={(v) => setLg({ margin: v })} format={(v) => `${Math.round(v * 100)}%`} />
                                </>
                            )}
                        </div>

                        <p className="text-[11px] text-muted leading-relaxed">
                            The preview is live; the clip is rendered once, when you apply.
                            The overlay sits under the hook and the captions.
                        </p>
                        {error && <p className="text-[11px] text-warn break-words">{error}</p>}
                        {hasSaved && onRemove && (
                            <button
                                onClick={onRemove} disabled={isProcessing}
                                className="text-xs text-warn underline underline-offset-2 hover:opacity-80"
                            >
                                remove overlay & logo from clip
                            </button>
                        )}
                    </div>

                    <div className="flex gap-2 mt-5 shrink-0">
                        <button onClick={onClose} className="btn-ghost">cancel</button>
                        <button onClick={apply} disabled={isProcessing} className="btn-primary flex-1">
                            {isProcessing && <Loader2 size={16} className="animate-spin text-brassink" />}
                            {isProcessing ? 'rendering...' : 'apply'}
                        </button>
                    </div>
                </div>
            </div>
        </Modal>
    );
}
