/** Small presentation helpers. Pure functions, no React. */

/**
 * Relative age, matching the `updated: 3d ago` vocabulary the MCP tools render.
 * The two surfaces describe the same pool, so they should read the same way.
 */
export function relativeAge(timestamp: number | null): string {
    if (timestamp === null || !Number.isFinite(timestamp)) return 'unknown';

    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ago`;
    const months = Math.floor(days / 30);
    if (months < 12) return `${months}mo ago`;
    return `${Math.floor(months / 12)}y ago`;
}

export function absoluteDate(timestamp: number | null): string {
    if (timestamp === null || !Number.isFinite(timestamp)) return 'unknown';
    return new Date(timestamp).toLocaleString();
}

export function formatBytes(bytes: number | null): string {
    if (bytes === null || !Number.isFinite(bytes)) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** A memory with no title still needs something clickable in the list. */
export function displayTitle(title: string | null, preview: string | null): string {
    const trimmed = (title ?? '').trim();
    if (trimmed) return trimmed;
    const fallback = (preview ?? '').trim();
    if (!fallback) return 'Untitled memory';
    return fallback.length > 60 ? `${fallback.slice(0, 60)}…` : fallback;
}
