type Props = {
  interactionMode: boolean;
  toolsOpen: boolean;
  /** Solid fills when window opacity slider is ~100% */
  solidChrome?: boolean;
  onToggleInteraction: () => void;
  onToggleTools: () => void;
  onMinimize: () => void;
};

export function TitleBar({
  interactionMode,
  toolsOpen,
  solidChrome = false,
  onToggleInteraction,
  onToggleTools,
  onMinimize,
}: Props) {
  return (
    <header
      className={`drag-region flex shrink-0 items-center justify-between gap-2 border-b border-copilot-border px-3 py-2 text-xs text-copilot-muted ${
        solidChrome ? 'bg-copilot-surface' : 'bg-copilot-surface/95'
      }`}
    >
      <div className="flex flex-col">
        <span className="text-sm font-semibold text-slate-100">
          Interview Copilot
        </span>
        <span className="text-[10px]">
          {interactionMode
            ? 'Interact · drag / buttons'
            : 'Click-through · Alt+Shift+I'}
        </span>
      </div>
      <div className="no-drag flex gap-1">
        <button
          type="button"
          onClick={onToggleTools}
          className={`rounded-md border px-2.5 py-1.5 text-[11px] font-medium transition-colors ${
            toolsOpen
              ? 'border-copilot-accent/60 bg-copilot-accent/15 text-copilot-accent'
              : 'border-copilot-border bg-copilot-bg text-slate-200 hover:border-copilot-accent/50'
          }`}
        >
          Tools
        </button>
        <button
          type="button"
          onClick={onToggleInteraction}
          className="rounded-md border border-copilot-border bg-copilot-bg px-2.5 py-1.5 text-[11px] text-slate-200 hover:border-copilot-accent/60"
        >
          {interactionMode ? 'Stealth' : 'Interact'}
        </button>
        <button
          type="button"
          onClick={onMinimize}
          className="rounded-md border border-copilot-border bg-copilot-bg px-2.5 py-1.5 text-[11px] text-slate-200 hover:border-copilot-accent/60"
        >
          Hide
        </button>
      </div>
    </header>
  );
}
