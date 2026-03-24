import type { CopilotAnswer } from '../../shared/types';

type Props = { answer: CopilotAnswer; solidChrome?: boolean };

export function AnswerCard({ answer, solidChrome = false }: Props) {
  return (
    <div className="space-y-5 text-base text-slate-200">
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-copilot-muted">
        <span className="rounded-md bg-copilot-border px-2 py-1 font-semibold text-copilot-accent">
          {answer.kind}
        </span>
        {answer.languageGuess ? (
          <span className="rounded-md bg-copilot-bg px-2 py-1">
            {answer.languageGuess}
          </span>
        ) : null}
        {answer.timeComplexity ? (
          <span>T {answer.timeComplexity}</span>
        ) : null}
        {answer.spaceComplexity ? (
          <span>S {answer.spaceComplexity}</span>
        ) : null}
      </div>
      {answer.codeSnippet ? (
        <section>
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-copilot-muted">
            Code
          </h3>
          <pre
            className={`max-h-[min(78vh,44rem)] overflow-auto rounded-xl border border-copilot-border p-4 font-mono text-[13px] leading-relaxed text-cyan-100 ${
              solidChrome ? 'bg-[#060708]' : 'bg-black/50'
            }`}
          >
            {answer.codeSnippet}
          </pre>
        </section>
      ) : null}
      <section>
        <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-copilot-muted">
          Short
        </h3>
        <p className="text-lg font-medium leading-relaxed text-slate-50">
          {answer.shortAnswer}
        </p>
      </section>
      <section>
        <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-copilot-muted">
          Detail
        </h3>
        <p className="whitespace-pre-wrap text-[15px] leading-relaxed text-slate-300">
          {answer.detailedExplanation}
        </p>
      </section>
      {answer.edgeCases.length > 0 ? (
        <section>
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-copilot-muted">
            Edge cases
          </h3>
          <ul className="list-inside list-disc space-y-1 text-[15px] leading-relaxed text-slate-300">
            {answer.edgeCases.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </section>
      ) : null}
      {answer.followUpHints.length > 0 ? (
        <section>
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-copilot-muted">
            Follow-ups
          </h3>
          <ul className="list-inside list-disc space-y-1 text-[15px] leading-relaxed text-slate-300">
            {answer.followUpHints.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
