import React, { useState, useEffect, useCallback } from 'react';
import { Loader2, FolderOpen, RefreshCw, Film, Trash2 } from 'lucide-react';
import { apiJson, apiFetch } from '../lib/api';
import { getApiUrl } from '../config';
import Modal from './ui/Modal';

// Self-host project list (GET /api/local/projects): every video processed on
// this server, newest first. Opening one loads it in the Clip Generator; a
// video still processing keeps running on the server either way.
const STATUS_LABEL = {
    completed: { text: 'done', cls: 'text-ok' },
    processing: { text: 'processing', cls: 'text-brass' },
    queued: { text: 'queued', cls: 'text-brass' },
    failed: { text: 'failed', cls: 'text-warn' },
};

function when(ts) {
    try {
        return new Date(ts * 1000).toLocaleString(undefined, {
            day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
        });
    } catch { return ''; }
}

export default function LocalProjectsTab({ currentJobId, onOpen, onDeleted }) {
    const [projects, setProjects] = useState(null);
    const [error, setError] = useState('');
    const [opening, setOpening] = useState(null);
    const [deleting, setDeleting] = useState(null);
    const [notice, setNotice] = useState('');

    const load = useCallback(() => {
        setError('');
        apiJson('/api/local/projects')
            .then((d) => setProjects(d.projects || []))
            .catch(() => setError('Could not load the project list.'));
    }, []);

    useEffect(() => {
        load();
        // Keep the status of running videos fresh while the list is open.
        const t = setInterval(load, 10000);
        return () => clearInterval(t);
    }, [load]);

    const open = async (p) => {
        setOpening(p.job_id);
        setError('');
        try {
            await onOpen(p.job_id);
        } catch (e) {
            setError(e.message || 'Could not open this project.');
        } finally {
            setOpening(null);
        }
    };

    // Asks first (DeleteDialog), optionally saving the source video to a
    // place the user picks, then deletes the files on the server for real
    // (clips, source, transcript, edits): DELETE /api/local/projects/{id}.
    const [confirming, setConfirming] = useState(null); // project being confirmed
    const [saveSource, setSaveSource] = useState(true);
    const [saveProgress, setSaveProgress] = useState(null); // 0..1 while saving

    const askDelete = (p) => {
        setSaveSource(!!p.source_file);
        setSaveProgress(null);
        setConfirming(p);
    };

    // Stream /api/source/{id} into a file the user picked (Chrome/Edge:
    // showSaveFilePicker, the OS "Save as" dialog). Returns false when the
    // user cancelled the dialog; null when the browser has no such dialog
    // (a plain download was started instead).
    const saveSourceFile = async (p) => {
        const name = p.source_file?.name || 'source.mp4';
        if (!window.showSaveFilePicker) {
            const a = document.createElement('a');
            a.href = getApiUrl(`/api/source/${p.job_id}`);
            a.download = name;
            document.body.appendChild(a);
            a.click();
            a.remove();
            return null;
        }
        let handle;
        try {
            handle = await window.showSaveFilePicker({ suggestedName: name });
        } catch (e) {
            if (e?.name === 'AbortError') return false;
            throw e;
        }
        const res = await apiFetch(`/api/source/${p.job_id}`);
        if (!res.ok || !res.body) throw new Error('Could not read the source video from the server.');
        const total = Number(res.headers.get('content-length')) || p.source_file?.size || 0;
        const writable = await handle.createWritable();
        const reader = res.body.getReader();
        let loaded = 0;
        try {
            setSaveProgress(0);
            for (;;) {
                const { value, done } = await reader.read();
                if (done) break;
                await writable.write(value);
                loaded += value.length;
                if (total) setSaveProgress(loaded / total);
            }
            await writable.close();
        } catch (e) {
            try { await writable.abort(); } catch { /* already closed */ }
            throw new Error(`Saving the source video failed: ${e.message || e}`);
        }
        if (total && loaded < total) throw new Error('The source video was not saved completely.');
        return true;
    };

    const remove = async () => {
        const p = confirming;
        if (!p) return;
        const name = p.title || p.source || p.job_id.slice(0, 8);
        setDeleting(p.job_id);
        setError('');
        setNotice('');
        try {
            if (saveSource && p.source_file) {
                const saved = await saveSourceFile(p);
                if (saved === false) return; // "Save as" cancelled: keep the project
                if (saved === null) {
                    // No save dialog in this browser: the download runs on its
                    // own, so the project must stay until it has finished.
                    setConfirming(null);
                    setNotice('The source video is downloading. Delete the project again once the download has finished (untick "save the source video").');
                    return;
                }
            }
            const res = await apiFetch(`/api/local/projects/${p.job_id}`, { method: 'DELETE' });
            if (!res.ok) {
                let msg = await res.text();
                try { msg = JSON.parse(msg).detail || msg; } catch { /* plain text */ }
                throw new Error(msg);
            }
            const data = await res.json();
            setProjects((list) => (list || []).filter((x) => x.job_id !== p.job_id));
            setNotice(`Deleted "${name}" — ${(data.freed_bytes / 1e9).toFixed(2)} GB freed on disk`
                + (saveSource && p.source_file ? ' (source video saved first).' : '.'));
            setConfirming(null);
            onDeleted?.(p.job_id);
        } catch (e) {
            setError(e.message || 'Could not delete this project.');
            setConfirming(null);
        } finally {
            setDeleting(null);
            setSaveProgress(null);
        }
    };

    const gb = (n) => (n ? `${(n / 1e9).toFixed(2)} GB` : '');

    return (
        <div className="h-full overflow-y-auto custom-scrollbar p-4 md:p-8">
            <div className="max-w-4xl mx-auto">
                <div className="flex items-center justify-between mb-6">
                    <div>
                        <p className="eyebrow mb-1">Clip Generator</p>
                        <h1 className="font-display lowercase text-2xl text-ink">projects</h1>
                    </div>
                    <button onClick={load} className="btn-ghost" title="refresh">
                        <RefreshCw size={14} /> refresh
                    </button>
                </div>

                {error && <p className="text-sm text-warn mb-4">{error}</p>}
                {notice && <p className="text-sm text-ok mb-4">{notice}</p>}

                {projects === null ? (
                    <div className="flex justify-center py-16"><Loader2 className="animate-spin text-muted" /></div>
                ) : projects.length === 0 ? (
                    <p className="text-muted text-sm py-16 text-center">No videos processed yet.</p>
                ) : (
                    <div className="space-y-2">
                        {projects.map((p) => {
                            const st = STATUS_LABEL[p.status] || { text: p.status, cls: 'text-muted' };
                            const isCurrent = p.job_id === currentJobId;
                            return (
                                <div
                                    key={p.job_id}
                                    className={`card p-3 flex items-center gap-3 ${isCurrent ? 'border-[color:var(--color-accent)]' : ''}`}
                                >
                                    <div className="w-12 h-20 shrink-0 rounded overflow-hidden bg-black/40 flex items-center justify-center">
                                        {p.thumb_url ? (
                                            <video
                                                src={`${getApiUrl(p.thumb_url)}#t=1`}
                                                className="w-full h-full object-cover"
                                                preload="metadata" muted playsInline
                                            />
                                        ) : <Film size={18} className="text-muted" />}
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <p className="text-sm text-ink truncate" title={p.title || p.source || p.job_id}>
                                            {p.title || p.source || `video ${p.job_id.slice(0, 8)}`}
                                        </p>
                                        {p.title && p.source && (
                                            <p className="text-xs text-muted truncate" title={p.source}>{p.source}</p>
                                        )}
                                        <p className="text-xs text-muted mt-1">
                                            <span className={st.cls}>{st.text}</span>
                                            {' · '}{p.clips} clip{p.clips === 1 ? '' : 's'}
                                            {' · '}{when(p.created)}
                                            {isCurrent && <span className="text-brass"> · open now</span>}
                                        </p>
                                    </div>
                                    <button
                                        onClick={() => open(p)}
                                        disabled={opening !== null || deleting !== null}
                                        className="btn-ghost shrink-0"
                                    >
                                        {opening === p.job_id ? <Loader2 size={14} className="animate-spin" /> : <FolderOpen size={14} />}
                                        open
                                    </button>
                                    <button
                                        onClick={() => askDelete(p)}
                                        disabled={opening !== null || deleting !== null}
                                        className="btn-ghost shrink-0 text-warn"
                                        title="delete project and its files"
                                    >
                                        {deleting === p.job_id ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                                        {deleting === p.job_id ? 'deleting…' : 'delete'}
                                    </button>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>

            <Modal
                isOpen={!!confirming}
                onClose={() => { if (!deleting) setConfirming(null); }}
                size="sm"
                eyebrow="PROJECTS · DELETE"
                title="delete project"
            >
                {confirming && (
                    <div className="space-y-4 text-sm">
                        <p className="text-ink break-words">
                            "{confirming.title || confirming.source || confirming.job_id.slice(0, 8)}"
                        </p>
                        {(confirming.status === 'processing' || confirming.status === 'queued') && (
                            <p className="text-warn text-xs">It is still processing: it will be stopped.</p>
                        )}
                        <p className="text-muted text-xs leading-relaxed">
                            All its files on the server (clips, source video, transcript, edits)
                            are deleted for good. This cannot be undone.
                        </p>

                        {confirming.source_file ? (
                            <label className="flex items-start gap-2 p-3 border border-rule rounded-input cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={saveSource}
                                    disabled={!!deleting}
                                    onChange={(e) => setSaveSource(e.target.checked)}
                                    className="mt-0.5 accent-[var(--color-accent)]"
                                />
                                <span>
                                    <span className="text-ink">Save the source video first</span>
                                    <span className="block text-xs text-muted mt-0.5 break-all">
                                        {confirming.source_file.name} {gb(confirming.source_file.size) && `· ${gb(confirming.source_file.size)}`}
                                    </span>
                                    <span className="block text-xs text-muted mt-0.5">
                                        You pick the folder and the name; the project is deleted only after it is saved.
                                    </span>
                                </span>
                            </label>
                        ) : (
                            <p className="text-xs text-muted">The source video is no longer on the server.</p>
                        )}

                        {saveProgress !== null && (
                            <div>
                                <div className="flex justify-between text-xs text-muted mb-1">
                                    <span>saving source video…</span>
                                    <span className="readout">{Math.round(saveProgress * 100)}%</span>
                                </div>
                                <div className="h-1.5 bg-rule rounded">
                                    <div className="h-1.5 rounded bg-[color:var(--color-accent)]" style={{ width: `${Math.round(saveProgress * 100)}%` }} />
                                </div>
                            </div>
                        )}

                        <div className="flex gap-2 pt-1">
                            <button onClick={() => setConfirming(null)} disabled={!!deleting} className="btn-ghost">cancel</button>
                            <button onClick={remove} disabled={!!deleting} className="btn-primary flex-1">
                                {deleting && <Loader2 size={16} className="animate-spin text-brassink" />}
                                {deleting
                                    ? (saveProgress !== null ? 'saving…' : 'deleting…')
                                    : (saveSource && confirming.source_file ? 'save & delete' : 'delete')}
                            </button>
                        </div>
                    </div>
                )}
            </Modal>
        </div>
    );
}
