import OpenAI from 'openai';
import type {
  AiProvider,
  ChatTurn,
  CopilotAnswer,
  GenerateInput,
} from '../../shared/types';

export type {
  AiProvider,
  ChatTurn,
  CopilotAnswer,
  GenerateInput,
  GenerateMode,
  QuestionKind,
} from '../../shared/types';

export type LlmConfig = {
  client: OpenAI;
  model: string;
  provider: 'groq' | 'openrouter' | 'openai';
};

const MULTI_QUESTION_HINT = `If the latest utterance contains several distinct questions in one turn, answer all of them: one shortAnswer line that covers each briefly, then detailedExplanation addressing each in order (optional light Q1/Q2 labels). If they are unrelated coding tasks, prioritize the main one in codeSnippet and mention the other in text.`;

const SYSTEM_PROMPT = `You are CrackStack AI. Given interview dialogue, produce interview-ready help.

Rules:
- Return ONLY valid JSON matching the schema in the user message (one JSON object, no markdown outside it).
- shortAnswer must be plain English sentences only — never source code, never lines with { } blocks, never a full function signature.
- Put ALL source code exclusively in codeSnippet (complete solution when code is required).
- If the utterance is not a technical question, set kind to HR or UNKNOWN and answer briefly.
- ${MULTI_QUESTION_HINT}
- Escape newlines inside JSON strings as \\n.`;

/** Phase 1 (coding): JSON without code body — code comes from a second request. */
const SYSTEM_PROMPT_CODING_META = `You are CrackStack AI. Return ONE JSON object only.

Rules:
- shortAnswer: 2–4 sentences of plain English ONLY. No code, no { }, no "function" lines, no semicolon-terminated program lines.
- detailedExplanation: explain the approach in words. No multi-line code; tiny inline pseudo like O(n) is OK.
- codeSnippet: MUST be exactly "" (empty string). Do not put any code there — a separate step will generate code.
- Set kind to CODING or DSA when appropriate; fill languageGuess, time/space complexity, edgeCases, followUpHints.
- Return valid JSON only.`;

const CODE_GEN_SYSTEM = `You are an interview assistant. Output ONLY raw source code for the solution.

Rules:
- No markdown. No backticks. No commentary before or after the code.
- Complete runnable solution: imports if needed, all functions, all closing braces.
- If the problem is trivial, still output a complete minimal program or function as requested.`;

function looksLikeCodeRequest(text: string): boolean {
  return /\b(write|implement|code|program|function|class|solve|solution|leetcode|working code|full code|complete code|show (me )?(the )?code|give me .{0,40}code|dry run|pseudocode|snippet|editor|whiteboard|from scratch)\b/i.test(
    text,
  );
}

function maxTokensStructured(input: GenerateInput): number {
  const fromEnv = parseInt(process.env.LLM_MAX_TOKENS ?? '', 10);
  if (!Number.isNaN(fromEnv) && fromEnv >= 256) {
    return Math.min(fromEnv, 16_384);
  }
  if (input.mode === 'hint_only') return 1024;
  const haystack = `${input.latestUtterance}\n${input.conversationSummary}`.slice(
    -4000,
  );
  if (looksLikeCodeRequest(haystack)) return 3500;
  return 2500;
}

/** Tokens for the plain-text code-only completion (second call). */
function maxTokensCodeOnly(): number {
  const codeEnv = parseInt(process.env.LLM_CODE_MAX_TOKENS ?? '', 10);
  if (!Number.isNaN(codeEnv) && codeEnv >= 256) {
    return Math.min(codeEnv, 16_384);
  }
  const general = parseInt(process.env.LLM_MAX_TOKENS ?? '', 10);
  if (!Number.isNaN(general) && general >= 512) {
    return Math.min(general, 16_384);
  }
  return 8192;
}

function userPayload(input: GenerateInput): string {
  const modeHint =
    input.mode === 'hint_only'
      ? 'MODE: hint_only — give only brief hints and follow-up hints; keep shortAnswer as a single hint line; minimize code.'
      : input.mode === 'explain_simpler'
        ? 'MODE: explain_simpler — simplify jargon; shorter detailedExplanation; keep structure.'
        : 'MODE: full — full structured answer.';

  const haystack = `${input.latestUtterance}\n${input.conversationSummary}`.slice(
    -4000,
  );
  const codeUrgency = looksLikeCodeRequest(haystack)
    ? `

CODE TASK: Put the **entire** working solution in codeSnippet only (never in shortAnswer). No "// ..." omissions.
`
    : '';

  return `${modeHint}
${codeUrgency}
Latest utterance (candidate or interviewer):
"""
${input.latestUtterance}
"""
${MULTI_QUESTION_HINT}

Rolling conversation (compressed):
"""
${input.conversationSummary}
"""

Optional manual notes from candidate:
"""
${input.manualContext ?? ''}
"""

JSON shape (all string values must be valid JSON-escaped):
{
  "kind": "DSA" | "SYSTEM_DESIGN" | "HR" | "CODING" | "DEBUGGING" | "UNKNOWN",
  "languageGuess": string optional,
  "shortAnswer": string,
  "detailedExplanation": string,
  "codeSnippet": string optional,
  "timeComplexity": string optional,
  "spaceComplexity": string optional,
  "edgeCases": string[],
  "followUpHints": string[]
}`;
}

function userPayloadCodingMeta(input: GenerateInput): string {
  const modeHint =
    input.mode === 'explain_simpler'
      ? 'MODE: explain_simpler — use simple words in shortAnswer and detailedExplanation.'
      : 'MODE: full — thorough verbal explanation; still no code in this JSON.';

  return `${modeHint}

Latest utterance:
"""
${input.latestUtterance}
"""
${MULTI_QUESTION_HINT}

Rolling conversation:
"""
${input.conversationSummary}
"""

Manual notes:
"""
${input.manualContext ?? ''}
"""

Return JSON with keys: kind, languageGuess (if known), shortAnswer, detailedExplanation, codeSnippet (must be ""), timeComplexity, spaceComplexity, edgeCases, followUpHints.`;
}

function normalizeParsed(parsed: CopilotAnswer): CopilotAnswer {
  if (!parsed.shortAnswer || !parsed.detailedExplanation) {
    throw new Error('Invalid answer shape');
  }
  parsed.edgeCases = Array.isArray(parsed.edgeCases) ? parsed.edgeCases : [];
  parsed.followUpHints = Array.isArray(parsed.followUpHints)
    ? parsed.followUpHints
    : [];
  return parsed;
}

function parseCopilotJson(raw: string | null | undefined): CopilotAnswer {
  if (!raw) throw new Error('Empty model response');
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();

  try {
    return normalizeParsed(JSON.parse(text) as CopilotAnswer);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) {
      throw new Error('Model did not return JSON');
    }
    const sliced = text.slice(start, end + 1);
    return normalizeParsed(JSON.parse(sliced) as CopilotAnswer);
  }
}

async function createCompletion(
  llm: LlmConfig,
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  max_tokens: number,
  useJsonObject: boolean,
) {
  const base = {
    model: llm.model,
    temperature: 0.25,
    max_tokens,
    messages,
  } as const;

  if (useJsonObject) {
    try {
      return await llm.client.chat.completions.create({
        ...base,
        response_format: { type: 'json_object' },
      });
    } catch {
      return llm.client.chat.completions.create({ ...base });
    }
  }
  return llm.client.chat.completions.create({ ...base });
}

function stripMarkdownFences(s: string): string {
  let t = s.trim();
  const fenced = t.match(/^```(?:\w+)?\s*([\s\S]*?)```$/m);
  if (fenced) return fenced[1].trim();
  t = t.replace(/^```\w*\s*/i, '').replace(/\s*```$/i, '');
  return t.trim();
}

async function generateRawCodeOnly(
  llm: LlmConfig,
  input: GenerateInput,
  meta: CopilotAnswer,
): Promise<string> {
  const lang =
    meta.languageGuess?.trim() ||
    /javascript|js|typescript|ts|python|java|go|rust|c\+\+|csharp/i.exec(
      `${input.latestUtterance} ${input.conversationSummary}`,
    )?.[0] ||
    'the language implied in the question';

  const user = `Target language: ${lang}

Problem / request:
${input.latestUtterance}

Extra context:
${input.conversationSummary.slice(-3500)}

Algorithm to implement (follow this):
${meta.detailedExplanation}

Write the complete solution now.`;

  const max_tokens = maxTokensCodeOnly();
  const completion = await llm.client.chat.completions.create({
    model: llm.model,
    temperature: 0.15,
    max_tokens,
    messages: [
      { role: 'system', content: CODE_GEN_SYSTEM },
      { role: 'user', content: user },
    ],
  });

  const raw = completion.choices[0]?.message?.content;
  return stripMarkdownFences(raw ?? '');
}

function shouldUseTwoStepCoding(input: GenerateInput): boolean {
  if (input.mode === 'hint_only') return false;
  const haystack = `${input.latestUtterance}\n${input.conversationSummary}`.slice(
    -4000,
  );
  return looksLikeCodeRequest(haystack);
}

/**
 * Priority: Groq (free tier) → OpenRouter (incl. :free models) → OpenAI.
 * Set LLM_MODEL in .env to override the default for the active provider.
 */
export function getAiCapabilitiesFromEnv(): {
  aiReady: boolean;
  aiProvider: AiProvider;
} {
  if (process.env.GROQ_API_KEY?.trim()) {
    return { aiReady: true, aiProvider: 'groq' };
  }
  if (process.env.OPENROUTER_API_KEY?.trim()) {
    return { aiReady: true, aiProvider: 'openrouter' };
  }
  if (process.env.OPENAI_API_KEY?.trim()) {
    return { aiReady: true, aiProvider: 'openai' };
  }
  return { aiReady: false, aiProvider: null };
}

export function resolveLlmConfig(): LlmConfig {
  const groq = process.env.GROQ_API_KEY?.trim();
  if (groq) {
    return {
      client: new OpenAI({
        apiKey: groq,
        baseURL: 'https://api.groq.com/openai/v1',
      }),
      model: process.env.LLM_MODEL?.trim() || 'llama-3.1-8b-instant',
      provider: 'groq',
    };
  }

  const openrouter = process.env.OPENROUTER_API_KEY?.trim();
  if (openrouter) {
    return {
      client: new OpenAI({
        apiKey: openrouter,
        baseURL: 'https://openrouter.ai/api/v1',
        defaultHeaders: {
          'HTTP-Referer':
            process.env.OPENROUTER_HTTP_REFERER?.trim() || 'http://localhost',
          'X-Title': 'CrackStack AI',
        },
      }),
      model:
        process.env.LLM_MODEL?.trim() ||
        'meta-llama/llama-3.2-3b-instruct:free',
      provider: 'openrouter',
    };
  }

  const openai = process.env.OPENAI_API_KEY?.trim();
  if (openai) {
    return {
      client: new OpenAI({ apiKey: openai }),
      model: process.env.LLM_MODEL?.trim() || 'gpt-4o-mini',
      provider: 'openai',
    };
  }

  throw new Error(
    'No AI API key. Add GROQ_API_KEY (free: https://console.groq.com), OPENROUTER_API_KEY, or OPENAI_API_KEY to .env',
  );
}

const RETRY_USER = `Your previous answer was invalid or truncated.

Reply with ONE valid JSON object only:
- shortAnswer: max 2 plain-English sentences (no code).
- detailedExplanation: max 5 short sentences, no code blocks.
- codeSnippet: the COMPLETE solution — full source, every brace. Use \\n for newlines inside the JSON string.
- kind must be CODING or DSA if this is a coding task.`;

export async function generateStructuredAnswer(
  llm: LlmConfig,
  input: GenerateInput,
): Promise<CopilotAnswer> {
  if (shouldUseTwoStepCoding(input)) {
    const metaMessages = [
      { role: 'system' as const, content: SYSTEM_PROMPT_CODING_META },
      { role: 'user' as const, content: userPayloadCodingMeta(input) },
    ];
    const metaMax = Math.min(maxTokensStructured(input), 3000);
    let completion = await createCompletion(
      llm,
      metaMessages,
      metaMax,
      true,
    );
    let answer: CopilotAnswer;
    try {
      answer = parseCopilotJson(completion.choices[0]?.message?.content);
    } catch {
      completion = await createCompletion(
        llm,
        [
          ...metaMessages,
          { role: 'user' as const, content: RETRY_USER },
        ],
        metaMax + 1024,
        true,
      );
      answer = parseCopilotJson(completion.choices[0]?.message?.content);
    }

    answer.codeSnippet = '';
    let code = '';
    try {
      code = await generateRawCodeOnly(llm, input, answer);
    } catch {
      code = '';
    }
    if (code.length >= 12) {
      answer.codeSnippet = code;
    }

    if (!answer.codeSnippet) {
      return generateStructuredAnswerSingleShot(llm, input);
    }
    return answer;
  }

  return generateStructuredAnswerSingleShot(llm, input);
}

async function generateStructuredAnswerSingleShot(
  llm: LlmConfig,
  input: GenerateInput,
): Promise<CopilotAnswer> {
  const max_tokens = maxTokensStructured(input);
  const baseMessages = [
    { role: 'system' as const, content: SYSTEM_PROMPT },
    { role: 'user' as const, content: userPayload(input) },
  ];

  let completion = await createCompletion(llm, baseMessages, max_tokens, true);
  let choice = completion.choices[0];
  let content = choice?.message?.content;
  const fr = choice?.finish_reason;

  try {
    return parseCopilotJson(content);
  } catch (firstErr) {
    const needsRetry =
      fr === 'length' ||
      (firstErr instanceof SyntaxError) ||
      (firstErr instanceof Error &&
        (firstErr.message.includes('JSON') ||
          firstErr.message.includes('Invalid answer')));

    if (!needsRetry) throw firstErr;

    const retryMessages = [
      ...baseMessages,
      {
        role: 'user' as const,
        content: RETRY_USER,
      },
    ];

    completion = await createCompletion(
      llm,
      retryMessages,
      Math.min(max_tokens + 2048, 16_384),
      true,
    );
    choice = completion.choices[0];
    content = choice?.message?.content;
    return parseCopilotJson(content);
  }
}

const CHAT_SYSTEM = `You are CrackStack AI — a sharp, practical technical interview coach.
- Answer clearly so the user can reuse ideas in a live interview.
- Use markdown when useful: short headings, bullets, and fenced code blocks for snippets.
- Stay honest; if unsure, say what to clarify or how to reason about it.
- Be concise but complete; avoid filler.`;

export async function runChatCompletion(
  llm: LlmConfig,
  messages: ChatTurn[],
): Promise<string> {
  const fromEnv = parseInt(process.env.LLM_CHAT_MAX_TOKENS ?? '', 10);
  const max_tokens = Math.min(
    !Number.isNaN(fromEnv) && fromEnv >= 256 ? fromEnv : 3072,
    8192,
  );

  const completion = await llm.client.chat.completions.create({
    model: llm.model,
    temperature: 0.35,
    max_tokens,
    messages: [
      { role: 'system', content: CHAT_SYSTEM },
      ...messages.slice(-28).map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
    ],
  });

  const text = completion.choices[0]?.message?.content?.trim();
  if (!text) throw new Error('Empty chat response');
  return text;
}
