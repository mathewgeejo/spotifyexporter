import { useEffect, useRef, type ReactNode } from 'react';
import { LoaderCircle, Music2, X } from 'lucide-react';

export function Spinner() { return <LoaderCircle size={17} className="spin"/>; }
export function Badge({ status }: { status: string }) {
  return <span className={`badge ${status}`}>{status.replaceAll('_', ' ')}</span>;
}
export function Cover({ id, name, small = false }: { id: string; name: string; small?: boolean }) {
  const theme = parseInt(id.slice(0, 2), 16) % 6 || 0;
  return <div className={`cover theme-${theme} ${small ? 'cover-small' : ''}`} aria-hidden="true"><div className="cover-orbit"/><span>{name.slice(0, 1).toUpperCase()}</span><Music2 size={small ? 15 : 25}/></div>;
}
export function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose); close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    ref.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close.current();
      if (event.key !== 'Tab') return;
      const items = [...(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select,summary,a[href]') || [])].filter(item => item.getClientRects().length);
      if (!items.length) { event.preventDefault(); return; }
      if (event.shiftKey && (document.activeElement === items[0] || document.activeElement === ref.current)) { event.preventDefault(); items.at(-1)?.focus(); }
      else if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0].focus(); }
    };
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('keydown', key); document.body.style.overflow = overflow; previous?.focus(); };
  }, []);
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="modal" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref}>
      <div className="modal-heading"><h2>{title}</h2><button className="icon-button" aria-label="Close dialog" onClick={onClose}><X size={20}/></button></div>
      {children}
    </div>
  </div>;
}
