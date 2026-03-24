import { useEffect, useRef } from 'react';
import type { ChatTurn } from '../../shared/types';

type Props = {
  messages: ChatTurn[];
  input: string;
  onInputChange: (v: string) => void;
  onSend: () => void;
  onClearChat?: () => void;
  solidChrome?: boolean;
  busy: boolean;
  disabled: boolean;
};

export function ChatDock({
  messages,
  input,
  onInputChange,
  onSend,
  onClearChat,
  solidChrome = false,
  busy,
  disabled,
}: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, busy]);

  return (
    <div
      className={`flex shrink-0 flex-col border-t border-copilot-border ${
        solidChrome ? 'bg-copilot-bg' : 'bg-copilot-bg/90'
      }`}
    >
      <div className="flex items-center justify-between gap-2 px-4 pt-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-copilot-muted">
          Chat with AI
        </span>
        {messages.length > 0 && onClearChat ? (
          <button
            type="button"
            onClick={onClearChat}
            className="rounded-md border border-copilot-border px-2 py-1 text-[10px] font-medium text-slate-400 hover:bg-copilot-surface hover:text-slate-200"
          >
            Clear chat
          </button>
        ) : null}
      </div>
      <div className="max-h-[min(28vh,220px)] min-h-[5.5rem] overflow-y-auto px-4 py-2">
        {messages.length === 0 ? (
          <p className="text-sm leading-relaxed text-copilot-muted">
            Ask follow-ups, drill a topic, or rehearse an answer — separate from
            the live interview transcript above.
          </p>
        ) : (
          messages.map((m, i) => (
            <div
              key={`${i}-${m.content.slice(0, 12)}`}
              className={`mb-2 rounded-xl px-3 py-2.5 text-sm leading-relaxed ${
                m.role === 'user'
                  ? solidChrome
                    ? 'ml-6 border border-copilot-accent/50 bg-copilot-surface text-slate-100'
                    : 'ml-6 border border-copilot-accent/25 bg-copilot-accent/10 text-slate-100'
                  : solidChrome
                    ? 'mr-6 border border-copilot-border bg-copilot-surface text-slate-200'
                    : 'mr-6 border border-copilot-border/80 bg-copilot-surface/90 text-slate-200'
              }`}
            >
              <div className="mb-1 text-[9px] font-semibold uppercase tracking-wide text-copilot-muted">
                {m.role === 'user' ? 'You' : 'Copilot'}
              </div>
              <div className="whitespace-pre-wrap font-sans">{m.content}</div>
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>
      <div className="flex gap-2 px-4 pb-4 pt-1">
        <textarea
          value={input}
          onChange={(e) => onInputChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              onSend();
            }
          }}
          rows={2}
          placeholder="Message… Enter send · Shift+Enter new line"
          disabled={disabled || busy}
          className={`min-h-[48px] flex-1 resize-none rounded-xl border border-copilot-border px-3 py-2.5 text-sm text-slate-100 placeholder:text-copilot-muted focus:border-copilot-accent/50 focus:outline-none ${
            solidChrome ? 'bg-copilot-surface' : 'bg-copilot-surface/95'
          }`}
        />
        <button
          type="button"
          disabled={disabled || busy || !input.trim()}
          onClick={onSend}
          className="self-end shrink-0 rounded-xl bg-copilot-accent/20 px-4 py-2.5 text-sm font-semibold text-copilot-accent hover:bg-copilot-accent/30 disabled:opacity-40"
        >
          {busy ? '…' : 'Send'}
        </button>
      </div>
    </div>
  );
}
