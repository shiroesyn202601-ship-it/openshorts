import React, { useState, useEffect, useCallback } from 'react';
import { Loader2, FolderOpen, RefreshCw, Film } from 'lucide-react';
import { apiJson } from '../lib/api';
import { getApiUrl } from '../config';

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

export default function LocalProjectsTab({ currentJobId, onOpen }) {
    const [projects, setProjects] = useState(null);
    const [error, setError] = useState('');
    const [opening, setOpening] = useState(null);

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
                                        disabled={opening !== null}
                                        className="btn-ghost shrink-0"
                                    >
                                        {opening === p.job_id ? <Loader2 size={14} className="animate-spin" /> : <FolderOpen size={14} />}
                                        open
                                    </button>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>
        </div>
    );
}
