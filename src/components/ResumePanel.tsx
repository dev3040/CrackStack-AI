import { useRef, useState } from 'react';
import type { ResumeData, ResumeInterviewAnswer, ResumeQuestion } from '../../shared/types';

const api = window.copilotApi;

type Props = {
  solidChrome: boolean;
  aiReady: boolean;
  resumeData: ResumeData | null;
  resumeText: string;
  resumeQuestions: ResumeQuestion[];
  resumeParsing: boolean;
  onResumeText: (t: string) => void;
  onResumeParsed: (data: ResumeData, questions: ResumeQuestion[]) => void;
  onSetResumeParsing: (v: boolean) => void;
  onClearResume: () => void;
  onError: (msg: string) => void;
};

type QaEntry = {
  question: string;
  result: ResumeInterviewAnswer | null;
  loading: boolean;
  error: string | null;
};

const CATEGORY_STYLES: Record<string, string> = {
  TECHNICAL: 'bg-sky-900/50 text-sky-200',
  PROJECT: 'bg-violet-900/50 text-violet-200',
  BEHAVIORAL: 'bg-amber-900/50 text-amber-200',
  HR: 'bg-slate-700/60 text-slate-300',
};

export function ResumePanel({
  solidChrome,
  aiReady,
  resumeData,
  resumeText,
  resumeQuestions,
  resumeParsing,
  onResumeText,
  onResumeParsed,
  onSetResumeParsing,
  onClearResume,
  onError,
}: Props) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [customQuestion, setCustomQuestion] = useState('');
  const [qaHistory, setQaHistory] = useState<QaEntry[]>([]);
  const [summaryExpanded, setSummaryExpanded] = useState(false);
  const answerEndRef = useRef<HTMLDivElement>(null);

  // ── File handling ──────────────────────────────────────────────────────────

  async function processFile(file: File) {
    onSetResumeParsing(true);
    onError('');
    try {
      let text = '';
      const lower = file.name.toLowerCase();
      if (
        file.type === 'application/pdf' ||
        lower.endsWith('.pdf') ||
        file.type ===
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
        lower.endsWith('.docx')
      ) {
        const arrayBuf = await file.arrayBuffer();
        const base64 = btoa(
          String.fromCharCode(...new Uint8Array(arrayBuf)),
        );
        const res = await api.resumeUploadFile({
          base64,
          mimeType: file.type,
          fileName: file.name,
        });
        if (!res.ok) {
          onError(res.error);
          onSetResumeParsing(false);
          return;
        }
        text = res.text;
      } else {
        // Plain text
        text = await file.text();
      }
      onResumeText(text);
      await parseAndLoad(text);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
      onSetResumeParsing(false);
    }
  }

  async function parseAndLoad(text: string) {
    onSetResumeParsing(true);
    const res = await api.resumeParse(text);
    if (!res.ok) {
      onError(res.error);
      onSetResumeParsing(false);
      return;
    }
    const qRes = await api.resumeQuestions(res.data);
    onResumeParsed(res.data, qRes.ok ? qRes.questions : []);
    onSetResumeParsing(false);
    setQaHistory([]);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) void processFile(file);
  }

  function handleFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) void processFile(file);
    e.target.value = '';
  }

  // ── Interview Q&A ─────────────────────────────────────────────────────────

  async function askQuestion(question: string) {
    if (!question.trim() || !resumeData || !aiReady) return;
    const entry: QaEntry = {
      question: question.trim(),
      result: null,
      loading: true,
      error: null,
    };
    setQaHistory((prev) => [...prev, entry]);
    const idx = qaHistory.length;

    setTimeout(() => {
      answerEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, 50);

    const res = await api.resumeInterviewAnswer({
      question: question.trim(),
      resumeData,
    });

    setQaHistory((prev) =>
      prev.map((e, i) =>
        i === idx
          ? {
              ...e,
              loading: false,
              result: res.ok ? res.result : null,
              error: res.ok ? null : res.error,
            }
          : e,
      ),
    );

    setTimeout(() => {
      answerEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, 100);
  }

  function handleAskCustom() {
    const q = customQuestion.trim();
    if (!q) return;
    setCustomQuestion('');
    void askQuestion(q);
  }

  // ── Render: no resume loaded ──────────────────────────────────────────────

  if (!resumeData) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
        {/* Upload area */}
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
          className={`flex cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed p-8 transition-colors ${
            dragging
              ? 'border-copilot-accent bg-copilot-accent/10'
              : 'border-copilot-border/70 hover:border-copilot-accent/50 hover:bg-copilot-surface/30'
          }`}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,.docx,.txt,text/plain,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            className="hidden"
            onChange={handleFileInput}
          />
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-copilot-surface/60">
            <svg
              className="h-6 w-6 text-copilot-accent"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.5}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5"
              />
            </svg>
          </div>
          <div className="text-center">
            <div className="text-sm font-medium text-slate-100">
              {resumeParsing ? 'Parsing resume…' : 'Upload your resume'}
            </div>
            <div className="mt-1 text-[11px] text-copilot-muted">
              Drag &amp; drop or click — PDF, DOCX, or TXT
            </div>
          </div>
          {resumeParsing && (
            <div className="h-1 w-32 overflow-hidden rounded-full bg-copilot-surface">
              <div className="h-full animate-pulse rounded-full bg-copilot-accent" />
            </div>
          )}
        </div>

        {/* Paste text fallback */}
        <div>
          <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-copilot-muted">
            Or paste resume text
          </label>
          <textarea
            value={resumeText}
            onChange={(e) => onResumeText(e.target.value)}
            rows={6}
            className={`w-full resize-none rounded-lg border border-copilot-border p-2 font-mono text-xs text-slate-100 ${
              solidChrome ? 'bg-copilot-surface' : 'bg-copilot-surface/90'
            }`}
            placeholder="Paste resume text here…"
          />
          <button
            type="button"
            disabled={resumeParsing || !resumeText.trim() || !aiReady}
            onClick={() => void parseAndLoad(resumeText)}
            className="mt-2 w-full rounded-lg bg-copilot-accent/20 py-2 text-xs font-semibold text-copilot-accent disabled:opacity-40"
          >
            {resumeParsing ? 'Parsing…' : 'Parse resume & load'}
          </button>
        </div>
      </div>
    );
  }

  // ── Render: resume loaded ─────────────────────────────────────────────────

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* Resume summary header */}
      <div
        className={`shrink-0 border-b border-copilot-border/60 px-3 py-2 ${
          solidChrome ? 'bg-copilot-surface' : 'bg-copilot-surface/40'
        }`}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="inline-flex h-5 w-5 items-center justify-center rounded bg-emerald-900/50 text-[10px] text-emerald-300">
              ✓
            </span>
            <span className="text-xs font-semibold text-slate-100">
              {resumeData.name ?? 'Resume loaded'}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setSummaryExpanded((v) => !v)}
              className="text-[10px] text-copilot-muted hover:text-slate-200"
            >
              {summaryExpanded ? 'Hide details' : 'Show details'}
            </button>
            <button
              type="button"
              onClick={() => {
                onClearResume();
                setQaHistory([]);
              }}
              className="text-[10px] text-rose-300/70 hover:text-rose-200"
            >
              Clear
            </button>
          </div>
        </div>

        {/* Skills row */}
        {resumeData.skills.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {resumeData.skills.slice(0, 10).map((s, i) => (
              <span
                key={i}
                className="rounded bg-copilot-bg/60 px-1.5 py-0.5 text-[10px] text-slate-300"
              >
                {s}
              </span>
            ))}
            {resumeData.skills.length > 10 && (
              <span className="text-[10px] text-copilot-muted">
                +{resumeData.skills.length - 10} more
              </span>
            )}
          </div>
        )}

        {/* Expanded details */}
        {summaryExpanded && (
          <div className="mt-2 space-y-2 text-[10px] text-slate-300">
            {resumeData.detailedExperience?.length ? (
              <div>
                <div className="mb-0.5 font-semibold uppercase tracking-wide text-copilot-muted">
                  Experience
                </div>
                {resumeData.detailedExperience.map((exp, i) => (
                  <div key={i} className="mb-1">
                    <span className="font-medium text-slate-100">{exp.role}</span>
                    <span className="text-copilot-muted"> at {exp.company}</span>
                    {exp.duration && (
                      <span className="text-copilot-muted"> · {exp.duration}</span>
                    )}
                  </div>
                ))}
              </div>
            ) : null}

            {resumeData.detailedProjects?.length ? (
              <div>
                <div className="mb-0.5 font-semibold uppercase tracking-wide text-copilot-muted">
                  Projects
                </div>
                {resumeData.detailedProjects.map((p, i) => (
                  <div key={i} className="mb-1">
                    <span className="font-medium text-slate-100">{p.name}</span>
                    {p.tech.length > 0 && (
                      <span className="text-copilot-muted"> · {p.tech.join(', ')}</span>
                    )}
                  </div>
                ))}
              </div>
            ) : null}

            {resumeData.education?.length ? (
              <div>
                <div className="mb-0.5 font-semibold uppercase tracking-wide text-copilot-muted">
                  Education
                </div>
                {resumeData.education.map((edu, i) => (
                  <div key={i}>
                    {edu.degree} — {edu.institution}
                    {edu.year ? ` (${edu.year})` : ''}
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        )}
      </div>

      {/* Q&A area */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {/* Suggested questions */}
        {resumeQuestions.length > 0 && qaHistory.length === 0 && (
          <div className="shrink-0 border-b border-copilot-border/60 px-3 py-2">
            <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-copilot-muted">
              Suggested questions
            </div>
            <div className="flex max-h-36 flex-col gap-1 overflow-y-auto">
              {resumeQuestions.map((rq, i) => (
                <button
                  key={i}
                  type="button"
                  disabled={!aiReady}
                  onClick={() => void askQuestion(rq.question)}
                  className="rounded-md border border-copilot-border/60 bg-copilot-bg/60 px-2 py-1.5 text-left text-[10px] leading-snug text-slate-200 hover:bg-copilot-surface/70 disabled:opacity-40"
                >
                  <span
                    className={`mr-1.5 rounded px-1 py-0.5 text-[9px] font-semibold uppercase ${CATEGORY_STYLES[rq.category] ?? 'bg-slate-700/60 text-slate-300'}`}
                  >
                    {rq.category}
                  </span>
                  {rq.question}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Answer history */}
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3 space-y-4">
          {qaHistory.length === 0 && (
            <div className="flex h-full items-center justify-center text-[11px] text-copilot-muted">
              Ask a question above or type one below to get a personalized answer
            </div>
          )}

          {qaHistory.map((entry, i) => (
            <div key={i} className="space-y-2">
              {/* Question bubble */}
              <div className="flex justify-end">
                <div className="max-w-[85%] rounded-xl rounded-tr-sm bg-copilot-accent/20 px-3 py-2 text-xs text-slate-100">
                  {entry.question}
                </div>
              </div>

              {/* Answer bubble */}
              <div className="flex justify-start">
                <div
                  className={`max-w-[92%] rounded-xl rounded-tl-sm border px-3 py-2.5 text-xs text-slate-100 ${
                    solidChrome
                      ? 'border-copilot-border bg-copilot-surface'
                      : 'border-copilot-border/60 bg-copilot-surface/60'
                  }`}
                >
                  {entry.loading ? (
                    <div className="flex items-center gap-2 text-copilot-muted">
                      <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-copilot-accent border-t-transparent" />
                      Generating answer…
                    </div>
                  ) : entry.error ? (
                    <span className="text-rose-300">{entry.error}</span>
                  ) : entry.result ? (
                    <div>
                      <p className="leading-relaxed whitespace-pre-wrap">
                        {entry.result.answer}
                      </p>
                      {entry.result.keyPoints.length > 0 && (
                        <div className="mt-2.5 border-t border-copilot-border/40 pt-2">
                          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-copilot-muted">
                            Resume highlights used
                          </div>
                          <ul className="space-y-0.5">
                            {entry.result.keyPoints.map((kp, ki) => (
                              <li key={ki} className="flex items-start gap-1.5 text-[10px] text-slate-300">
                                <span className="mt-0.5 shrink-0 text-copilot-accent">✓</span>
                                {kp}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                      <button
                        type="button"
                        onClick={() =>
                          void navigator.clipboard.writeText(entry.result!.answer)
                        }
                        className="mt-2 text-[10px] text-copilot-muted hover:text-slate-200"
                      >
                        Copy answer
                      </button>
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          ))}
          <div ref={answerEndRef} />
        </div>

        {/* Question input */}
        <div
          className={`shrink-0 border-t border-copilot-border/60 p-3 ${
            solidChrome ? 'bg-copilot-surface' : 'bg-copilot-surface/40'
          }`}
        >
          {qaHistory.length > 0 && (
            <button
              type="button"
              onClick={() => setQaHistory([])}
              className="mb-2 text-[10px] text-copilot-muted hover:text-slate-200"
            >
              Clear history
            </button>
          )}
          <div className="flex gap-2">
            <textarea
              value={customQuestion}
              onChange={(e) => setCustomQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleAskCustom();
                }
              }}
              rows={2}
              placeholder="Type an interview question… (Enter to send)"
              className={`min-h-0 flex-1 resize-none rounded-lg border border-copilot-border px-2 py-1.5 text-xs text-slate-100 placeholder:text-copilot-muted/70 ${
                solidChrome ? 'bg-copilot-bg' : 'bg-copilot-bg/80'
              }`}
            />
            <button
              type="button"
              disabled={!customQuestion.trim() || !aiReady}
              onClick={handleAskCustom}
              className="shrink-0 self-end rounded-lg bg-copilot-accent/20 px-3 py-2 text-xs font-semibold text-copilot-accent disabled:opacity-40"
            >
              Ask
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
