import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface MarkdownViewerProps {
  content: string;
  className?: string;
}

export function MarkdownViewer({ content, className }: MarkdownViewerProps) {
  return (
    <div
      className={[
        'min-h-0 flex-1 overflow-y-auto px-5 py-4 font-sans text-[13px] leading-[1.7] text-ink-dim',
        className ?? '',
      ].join(' ')}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => (
            <h1 className="display mb-3 mt-4 text-[20px] font-semibold text-ink border-b border-edge pb-1.5">
              {children}
            </h1>
          ),
          h2: ({ children }) => (
            <h2 className="display mb-2.5 mt-4 text-[17px] font-semibold text-ink">
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3 className="display mb-2 mt-3 text-[14.5px] font-semibold text-ink">
              {children}
            </h3>
          ),
          p: ({ children }) => (
            <p className="mb-3 leading-relaxed text-ink-dim last:mb-0">{children}</p>
          ),
          ul: ({ children }) => (
            <ul className="mb-3 list-disc pl-5 space-y-1 text-ink-dim">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="mb-3 list-decimal pl-5 space-y-1 text-ink-dim">{children}</ol>
          ),
          li: ({ children }) => <li className="leading-relaxed">{children}</li>,
          blockquote: ({ children }) => (
            <blockquote className="my-3 border-l-2 border-accent/60 bg-accent/[0.04] py-1.5 pl-3.5 italic text-ink-muted rounded-r-card">
              {children}
            </blockquote>
          ),
          code({ className, children, ...props }) {
            const isInline = !className && !String(children).includes('\n');
            if (isInline) {
              return (
                <code className="rounded-[5px] border border-edge bg-white/[0.06] px-1.5 py-0.5 font-mono text-[11.5px] text-accent">
                  {children}
                </code>
              );
            }
            return (
              <pre className="my-3 overflow-x-auto rounded-card border border-edge bg-black/60 p-3.5 font-mono text-[11.5px] text-ink shadow-card">
                <code className={className} {...props}>
                  {children}
                </code>
              </pre>
            );
          },
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent underline decoration-accent/40 underline-offset-2 transition-colors hover:text-accent-hover hover:decoration-accent"
            >
              {children}
            </a>
          ),
          table: ({ children }) => (
            <div className="my-3 overflow-x-auto rounded-card border border-edge">
              <table className="w-full text-left font-mono text-[11.5px]">{children}</table>
            </div>
          ),
          thead: ({ children }) => (
            <thead className="border-b border-edge bg-white/[0.04] text-ink">{children}</thead>
          ),
          th: ({ children }) => (
            <th className="px-3 py-2 font-semibold uppercase tracking-wider text-[10px] text-ink-faint">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border-t border-edge/50 px-3 py-2 text-ink-dim">{children}</td>
          ),
          hr: () => <hr className="my-4 border-edge" />,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
