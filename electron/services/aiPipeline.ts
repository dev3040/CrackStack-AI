import OpenAI from 'openai';
import type {
  AiProvider,
  ChatTurn,
  CopilotAnswer,
  GenerateInput,
  ResumeData,
  ResumeQuestion,
  ResumeInterviewAnswer,
} from '../../shared/types';

export type {
  AiProvider,
  ChatTurn,
  CopilotAnswer,
  GenerateInput,
  GenerateMode,
  QuestionKind,
  ResumeData,
  ResumeEducation,
  ResumeExperience,
  ResumeInterviewAnswer,
  ResumeProject,
  ResumeQuestion,
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

  const resumeSection = input.resumeContext
    ? `\nCandidate resume context (tailor your answer to their background):\n"""\n${input.resumeContext}\n"""\n`
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
${resumeSection}

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

  const resumeSection = input.resumeContext
    ? `\nCandidate resume context:\n"""\n${input.resumeContext}\n"""\n`
    : '';

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
${resumeSection}
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
): Promise<{ code: string; tokens: number }> {
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
  return {
    code: stripMarkdownFences(raw ?? ''),
    tokens: completion.usage?.total_tokens ?? 0,
  };
}

function shouldUseTwoStepCoding(input: GenerateInput): boolean {
  if (input.mode === 'hint_only') return false;
  const haystack = `${input.latestUtterance}\n${input.conversationSummary}`.slice(
    -4000,
  );
  return looksLikeCodeRequest(haystack);
}

/**
 * Try the given async operation against each LlmConfig in order.
 * Falls through to the next provider only on rate-limit (429) or unavailable (503) errors.
 * Other errors (auth, bad request, parse) are thrown immediately.
 */
async function tryWithFallback<T>(
  configs: LlmConfig[],
  fn: (cfg: LlmConfig) => Promise<T>,
): Promise<T> {
  let lastErr: unknown = new Error('No AI providers configured');
  for (const cfg of configs) {
    try {
      return await fn(cfg);
    } catch (err) {
      lastErr = err;
      const status = (err as { status?: number }).status;
      // Only fall through to next provider for transient/capacity errors
      if (status !== 429 && status !== 503) throw err;
    }
  }
  throw lastErr;
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

/** Returns one LlmConfig for the first available provider (for display/status). */
export function resolveLlmConfig(): LlmConfig {
  const all = resolveAllLlmConfigs();
  return all[0];
}

/**
 * Returns all configured providers in priority order (Groq → OpenRouter → OpenAI).
 * Used by the fallback chain so a rate-limited provider is skipped automatically.
 */
export function resolveAllLlmConfigs(): LlmConfig[] {
  const configs: LlmConfig[] = [];

  const groq = process.env.GROQ_API_KEY?.trim();
  if (groq) {
    configs.push({
      client: new OpenAI({
        apiKey: groq,
        baseURL: 'https://api.groq.com/openai/v1',
      }),
      model: process.env.LLM_MODEL?.trim() || 'llama-3.1-8b-instant',
      provider: 'groq',
    });
  }

  const openrouter = process.env.OPENROUTER_API_KEY?.trim();
  if (openrouter) {
    configs.push({
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
    });
  }

  const openai = process.env.OPENAI_API_KEY?.trim();
  if (openai) {
    configs.push({
      client: new OpenAI({ apiKey: openai }),
      model: process.env.LLM_MODEL?.trim() || 'gpt-4o-mini',
      provider: 'openai',
    });
  }

  if (configs.length === 0) {
    throw new Error(
      'No AI API key. Add GROQ_API_KEY (free: https://console.groq.com), OPENROUTER_API_KEY, or OPENAI_API_KEY to .env',
    );
  }

  return configs;
}

const RETRY_USER = `Your previous answer was invalid or truncated.

Reply with ONE valid JSON object only:
- shortAnswer: max 2 plain-English sentences (no code).
- detailedExplanation: max 5 short sentences, no code blocks.
- codeSnippet: the COMPLETE solution — full source, every brace. Use \\n for newlines inside the JSON string.
- kind must be CODING or DSA if this is a coding task.`;

export async function generateStructuredAnswer(
  configs: LlmConfig[],
  input: GenerateInput,
): Promise<CopilotAnswer> {
  return tryWithFallback(configs, (llm) =>
    generateStructuredAnswerWithLlm(llm, input),
  );
}

async function generateStructuredAnswerWithLlm(
  llm: LlmConfig,
  input: GenerateInput,
): Promise<CopilotAnswer> {
  if (shouldUseTwoStepCoding(input)) {
    const metaMessages = [
      { role: 'system' as const, content: SYSTEM_PROMPT_CODING_META },
      { role: 'user' as const, content: userPayloadCodingMeta(input) },
    ];
    const metaMax = Math.min(maxTokensStructured(input), 3000);
    let tokensUsed = 0;

    let completion = await createCompletion(llm, metaMessages, metaMax, true);
    tokensUsed += completion.usage?.total_tokens ?? 0;

    let answer: CopilotAnswer;
    try {
      answer = parseCopilotJson(completion.choices[0]?.message?.content);
    } catch {
      completion = await createCompletion(
        llm,
        [...metaMessages, { role: 'user' as const, content: RETRY_USER }],
        metaMax + 1024,
        true,
      );
      tokensUsed += completion.usage?.total_tokens ?? 0;
      answer = parseCopilotJson(completion.choices[0]?.message?.content);
    }

    answer.codeSnippet = '';
    try {
      const { code, tokens } = await generateRawCodeOnly(llm, input, answer);
      tokensUsed += tokens;
      if (code.length >= 12) answer.codeSnippet = code;
    } catch {
      /* code step failed — fall through to single-shot */
    }

    if (!answer.codeSnippet) {
      return generateStructuredAnswerSingleShot(llm, input);
    }
    answer.tokensUsed = tokensUsed;
    answer.providerUsed = llm.provider;
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

  let tokensUsed = 0;
  let completion = await createCompletion(llm, baseMessages, max_tokens, true);
  tokensUsed += completion.usage?.total_tokens ?? 0;

  let choice = completion.choices[0];
  let content = choice?.message?.content;
  const fr = choice?.finish_reason;

  try {
    const answer = parseCopilotJson(content);
    answer.tokensUsed = tokensUsed;
    answer.providerUsed = llm.provider;
    return answer;
  } catch (firstErr) {
    const needsRetry =
      fr === 'length' ||
      firstErr instanceof SyntaxError ||
      (firstErr instanceof Error &&
        (firstErr.message.includes('JSON') ||
          firstErr.message.includes('Invalid answer')));

    if (!needsRetry) throw firstErr;

    const retryMessages = [
      ...baseMessages,
      { role: 'user' as const, content: RETRY_USER },
    ];

    completion = await createCompletion(
      llm,
      retryMessages,
      Math.min(max_tokens + 2048, 16_384),
      true,
    );
    tokensUsed += completion.usage?.total_tokens ?? 0;
    choice = completion.choices[0];
    content = choice?.message?.content;
    const answer = parseCopilotJson(content);
    answer.tokensUsed = tokensUsed;
    answer.providerUsed = llm.provider;
    return answer;
  }
}

// ---------------------------------------------------------------------------
// Resume: parse + generate interview questions + generate interview answers
// ---------------------------------------------------------------------------

const RESUME_PARSE_SYSTEM = `You are a resume parser. Extract structured info from the provided resume text and return ONLY a valid JSON object.`;

const RESUME_QUESTIONS_SYSTEM = `You are an expert technical interviewer. Based on the provided resume data, generate likely interview questions. Return ONLY a valid JSON object.`;

const INTERVIEW_ANSWER_SYSTEM = `You are speaking AS the job candidate in a live interview. Generate natural, first-person interview answers strictly based on the candidate's resume.

Rules:
- Speak in first person: "I worked on...", "In my role at...", "One project I built..."
- Reference SPECIFIC details from the resume: company names, project names, technologies, achievements, durations
- Sound natural and conversational — like a real, well-prepared candidate answering
- Keep answers focused: 2–4 short paragraphs at most
- If the question isn't directly covered, reason from related skills/experience in the resume
- Maintain professional interview tone — confident but not arrogant
- NEVER invent details not present in the resume
- Return ONLY a valid JSON object`;

export async function parseResume(
  configs: LlmConfig[],
  resumeText: string,
): Promise<ResumeData> {
  return tryWithFallback(configs, async (llm) => {
    const user = `Parse this resume and return a JSON object with these exact keys:
- name: candidate's full name (string or null)
- skills: flat array of all technical skills and technologies (string[])
- experience: concise summary of overall work experience (1–3 sentences, string)
- projects: array of project name strings (string[])
- summary: 2–3 sentence professional summary suitable as AI answer context (string)
- detailedExperience: array of objects, each with: company (string), role (string), duration (string), highlights (string[] — up to 4 key bullet points per role)
- detailedProjects: array of objects, each with: name (string), description (string — 1–2 sentences), tech (string[] — technologies used)
- education: array of objects, each with: institution (string), degree (string), year (string optional)

Resume:
"""
${resumeText.slice(0, 10000)}
"""

Return ONLY the JSON object, no markdown, no extra text.`;

    const completion = await llm.client.chat.completions.create({
      model: llm.model,
      temperature: 0.1,
      max_tokens: 2000,
      messages: [
        { role: 'system', content: RESUME_PARSE_SYSTEM },
        { role: 'user', content: user },
      ],
    });

    const raw = completion.choices[0]?.message?.content?.trim() ?? '';
    let text = raw;
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) text = fence[1].trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1) throw new Error('Resume parse: no JSON returned');
    const parsed = JSON.parse(text.slice(start, end + 1)) as ResumeData;
    if (!Array.isArray(parsed.skills)) parsed.skills = [];
    if (!Array.isArray(parsed.projects)) parsed.projects = [];
    if (!Array.isArray(parsed.detailedExperience)) parsed.detailedExperience = [];
    if (!Array.isArray(parsed.detailedProjects)) parsed.detailedProjects = [];
    if (!Array.isArray(parsed.education)) parsed.education = [];
    if (!parsed.experience) parsed.experience = '';
    if (!parsed.summary) parsed.summary = '';
    return parsed;
  });
}

export async function generateInterviewAnswer(
  configs: LlmConfig[],
  question: string,
  resumeData: ResumeData,
): Promise<ResumeInterviewAnswer> {
  return tryWithFallback(configs, async (llm) => {
    const expSection = resumeData.detailedExperience?.length
      ? resumeData.detailedExperience
          .map(
            (e) =>
              `${e.role} at ${e.company} (${e.duration}):\n${e.highlights.map((h) => `  • ${h}`).join('\n')}`,
          )
          .join('\n\n')
      : resumeData.experience;

    const projSection = resumeData.detailedProjects?.length
      ? resumeData.detailedProjects
          .map(
            (p) =>
              `${p.name}: ${p.description} [Tech: ${p.tech.join(', ')}]`,
          )
          .join('\n')
      : resumeData.projects.join(', ');

    const eduSection = resumeData.education?.length
      ? resumeData.education
          .map((e) => `${e.degree} — ${e.institution}${e.year ? ` (${e.year})` : ''}`)
          .join('\n')
      : '';

    const context = `Candidate: ${resumeData.name ?? 'the candidate'}
Skills: ${resumeData.skills.join(', ')}

Experience:
${expSection}

Projects:
${projSection}
${eduSection ? `\nEducation:\n${eduSection}` : ''}

Professional Summary: ${resumeData.summary}`;

    const user = `Interview question: "${question}"

Candidate's resume context:
"""
${context}
"""

Generate a natural first-person interview answer as this specific candidate. Return a JSON object with:
- answer: the full conversational answer (string) — speak as the candidate, reference their actual projects/companies/skills
- keyPoints: array of 2–4 short strings highlighting the specific resume elements referenced in the answer

Return ONLY the JSON object.`;

    const completion = await llm.client.chat.completions.create({
      model: llm.model,
      temperature: 0.3,
      max_tokens: 1200,
      messages: [
        { role: 'system', content: INTERVIEW_ANSWER_SYSTEM },
        { role: 'user', content: user },
      ],
    });

    const raw = completion.choices[0]?.message?.content?.trim() ?? '';
    let text = raw;
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) text = fence[1].trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1) throw new Error('Interview answer: no JSON returned');
    const parsed = JSON.parse(text.slice(start, end + 1)) as ResumeInterviewAnswer;
    if (typeof parsed.answer !== 'string' || !parsed.answer.trim()) {
      throw new Error('Interview answer: empty answer returned');
    }
    if (!Array.isArray(parsed.keyPoints)) parsed.keyPoints = [];
    return parsed;
  });
}

export async function generateResumeQuestions(
  configs: LlmConfig[],
  resumeData: ResumeData,
): Promise<ResumeQuestion[]> {
  return tryWithFallback(configs, async (llm) => {
    const context = `Name: ${resumeData.name ?? 'Candidate'}
Skills: ${resumeData.skills.join(', ')}
Experience: ${resumeData.experience}
Projects: ${resumeData.projects.join(', ')}
Summary: ${resumeData.summary}`;

    const user = `Based on this candidate's resume, generate 8–10 likely interview questions that an interviewer would ask. Mix technical, behavioral, HR, and project-based questions relevant to their background.

Resume summary:
"""
${context}
"""

Return ONLY a JSON object with key "questions" which is an array of objects, each with:
- question: string
- category: "HR" | "TECHNICAL" | "PROJECT" | "BEHAVIORAL"

No markdown, no extra text.`;

    const completion = await llm.client.chat.completions.create({
      model: llm.model,
      temperature: 0.4,
      max_tokens: 1200,
      messages: [
        { role: 'system', content: RESUME_QUESTIONS_SYSTEM },
        { role: 'user', content: user },
      ],
    });

    const raw = completion.choices[0]?.message?.content?.trim() ?? '';
    let text = raw;
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) text = fence[1].trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1) throw new Error('Resume questions: no JSON returned');
    const parsed = JSON.parse(text.slice(start, end + 1)) as { questions: ResumeQuestion[] };
    if (!Array.isArray(parsed.questions)) return [];
    return parsed.questions;
  });
}

// ---------------------------------------------------------------------------
// Screen analysis — vision-capable providers only (not Groq)
// ---------------------------------------------------------------------------

const SCREEN_ANALYZE_SYSTEM = `You are CrackStack AI analyzing a screenshot from a technical interview or coding session.

Instructions:
1. Read ALL visible text — chat messages, code editors, documents, problem statements, online judge pages
2. Identify the main question or coding task the interviewer / platform is presenting
3. Produce a complete, interview-ready answer exactly as you would from a spoken question
4. For coding problems put the full working solution in codeSnippet
5. For conceptual / system-design questions give a thorough structured explanation
6. If multiple questions appear, address all of them
7. shortAnswer must be plain English — no code, no curly braces

Return ONLY valid JSON matching the schema shown in the user message.`;

/** Vision-capable configs: OpenRouter + OpenAI (Groq has no vision support). */
export function resolveVisionConfigs(): LlmConfig[] {
  const configs: LlmConfig[] = [];

  const openrouter = process.env.OPENROUTER_API_KEY?.trim();
  if (openrouter) {
    configs.push({
      client: new OpenAI({
        apiKey: openrouter,
        baseURL: 'https://openrouter.ai/api/v1',
        defaultHeaders: {
          'HTTP-Referer':
            process.env.OPENROUTER_HTTP_REFERER?.trim() || 'http://localhost',
          'X-Title': 'CrackStack AI',
        },
      }),
      model: process.env.VISION_MODEL?.trim() || 'google/gemini-flash-1.5-8b',
      provider: 'openrouter',
    });
  }

  const openai = process.env.OPENAI_API_KEY?.trim();
  if (openai) {
    configs.push({
      client: new OpenAI({ apiKey: openai }),
      model: process.env.VISION_MODEL?.trim() || 'gpt-4o-mini',
      provider: 'openai',
    });
  }

  return configs;
}

export async function analyzeScreenshot(
  visionConfigs: LlmConfig[],
  screenshotDataUrl: string,
  conversationContext?: string,
): Promise<CopilotAnswer> {
  if (visionConfigs.length === 0) {
    throw new Error(
      'No vision-capable provider configured. Add OPENAI_API_KEY or OPENROUTER_API_KEY to .env',
    );
  }

  return tryWithFallback(visionConfigs, async (llm) => {
    const contextSection = conversationContext?.trim()
      ? `\nRecent conversation context:\n"""\n${conversationContext.slice(-2000)}\n"""\n`
      : '';

    const completion = await llm.client.chat.completions.create({
      model: llm.model,
      temperature: 0.2,
      max_tokens: 4096,
      messages: [
        { role: 'system', content: SCREEN_ANALYZE_SYSTEM },
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: screenshotDataUrl, detail: 'high' },
            },
            {
              type: 'text',
              text: `${contextSection}
Analyze this screenshot and answer the question(s) visible on screen.

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
}`,
            },
          ],
        },
      ],
    });

    const answer = parseCopilotJson(completion.choices[0]?.message?.content);
    answer.tokensUsed = completion.usage?.total_tokens ?? 0;
    answer.providerUsed = llm.provider;
    return answer;
  });
}

const CHAT_SYSTEM = `You are CrackStack AI — a sharp, practical technical interview coach.
- Answer clearly so the user can reuse ideas in a live interview.
- Use markdown when useful: short headings, bullets, and fenced code blocks for snippets.
- Stay honest; if unsure, say what to clarify or how to reason about it.
- Be concise but complete; avoid filler.`;

export async function runChatCompletion(
  configs: LlmConfig[],
  messages: ChatTurn[],
): Promise<string> {
  return tryWithFallback(configs, (llm) =>
    runChatCompletionWithLlm(llm, messages),
  );
}

async function runChatCompletionWithLlm(
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
