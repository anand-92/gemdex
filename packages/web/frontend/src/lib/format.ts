const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

export function relativeTime(timestamp: number): string {
  const delta = Date.now() - timestamp;
  if (delta < MINUTE) return 'just now';
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)}m ago`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)}h ago`;
  if (delta < WEEK) return `${Math.floor(delta / DAY)}d ago`;
  if (delta < 5 * WEEK) return `${Math.floor(delta / WEEK)}w ago`;
  return `${Math.floor(delta / (30 * DAY))}mo ago`;
}

export function fullDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  });
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

export function pluralize(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/** Truncate long POSIX paths from the left, the way a terminal breadcrumb would. */
export function truncatePath(path: string, maxLength = 34): string {
  if (path.length <= maxLength) return path;
  return `…${path.slice(path.length - maxLength + 1)}`;
}