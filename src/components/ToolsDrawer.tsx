import type { ReactNode } from 'react';

type Props = {
  open: boolean;
  solidChrome?: boolean;
  onClose: () => void;
  children: ReactNode;
};

export function ToolsDrawer({
  open,
  solidChrome = false,
  onClose,
  children,
}: Props) {
  return (
    <>
      {open ? (
        <button
          type="button"
          className={`no-drag absolute inset-0 z-40 transition-opacity ${
            solidChrome ? 'bg-copilot-bg' : 'bg-black/45'
          }`}
          aria-label="Close tools"
          onClick={onClose}
        />
      ) : null}
      <aside
        className={`no-drag absolute right-0 top-0 z-50 flex h-full w-[min(100%,20.5rem)] flex-col border-l border-copilot-border shadow-2xl transition-transform duration-200 ease-out ${
          solidChrome
            ? 'bg-copilot-bg'
            : 'bg-copilot-bg/98 backdrop-blur-md'
        } ${open ? 'translate-x-0' : 'pointer-events-none translate-x-full'}`}
        aria-hidden={!open}
      >
        <div className="flex items-center justify-between border-b border-copilot-border px-3 py-2.5">
          <span className="text-sm font-semibold tracking-tight text-slate-100">
            Tools &amp; capture
          </span>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-copilot-border px-2 py-1 text-xs text-slate-300 hover:bg-copilot-surface"
          >
            Close
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-3">
          {children}
        </div>
      </aside>
    </>
  );
}
