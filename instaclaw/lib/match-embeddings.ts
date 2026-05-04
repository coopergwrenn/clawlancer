/**
 * Embedding helper for the intent matching engine.
 *
 * PRD: instaclaw/docs/prd/consensus-intent-matching-2026-05-04.md §2.2
 *
 * v1 backend: OpenAI text-embedding-3-large @ 1024 dims (Matryoshka).
 * v2 backend (when VOYAGE_API_KEY is provisioned): voyage-3-large @ 1024 dims.
 *
 * The embedder is backend-agnostic: callers use embed() / embedBatch() and
 * don't know which provider answered. The router below selects automatically
 * based on which API key is set, with OpenAI as the safe default.
 *
 * Output: 1024-dim Float32 array. Matches the matchpool_profiles schema's
 * vector(1024) columns (offering_embedding, seeking_embedding).
 */

const EMBEDDING_DIMS = 1024;

const OPENAI_MODEL = "text-embedding-3-large";
const VOYAGE_MODEL = "voyage-3-large";

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RETRIES = 3;
const RETRY_BACKOFFS_MS = [200, 1_000, 3_000];

export interface EmbedResult {
  vectors: number[][];        // shape: texts.length × 1024
  model: string;              // 'openai/text-embedding-3-large' or 'voyage/voyage-3-large'
  total_tokens?: number;
}

class EmbedError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "EmbedError";
  }
}

/** Pick the active backend based on env. Voyage if its key is set, else OpenAI. */
function pickBackend(): "voyage" | "openai" {
  if (process.env.VOYAGE_API_KEY?.trim()) return "voyage";
  if (process.env.OPENAI_API_KEY?.trim()) return "openai";
  throw new EmbedError(
    "No embedding API key configured. Set VOYAGE_API_KEY or OPENAI_API_KEY."
  );
}

async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      // 4xx errors (bad input) shouldn't be retried.
      if (err instanceof EmbedError && err.message.includes("status=4")) throw err;
      if (attempt < MAX_RETRIES - 1) {
        await new Promise((r) => setTimeout(r, RETRY_BACKOFFS_MS[attempt]));
      }
    }
  }
  throw new EmbedError(`${label}: failed after ${MAX_RETRIES} attempts`, lastErr);
}

async function embedViaOpenAI(texts: string[]): Promise<EmbedResult> {
  const apiKey = process.env.OPENAI_API_KEY!;
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        input: texts,
        dimensions: EMBEDDING_DIMS,         // Matryoshka — request 1024-d output
        encoding_format: "float",
      }),
      signal: ctrl.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new EmbedError(
        `OpenAI embedding failed: status=${res.status} body=${body.slice(0, 200)}`
      );
    }

    const json = (await res.json()) as {
      data: Array<{ embedding: number[]; index: number }>;
      usage?: { total_tokens?: number };
    };

    // OpenAI returns embeddings in input order; sort defensively by index.
    const sorted = [...json.data].sort((a, b) => a.index - b.index);
    const vectors = sorted.map((d) => d.embedding);

    if (vectors.length !== texts.length) {
      throw new EmbedError(
        `OpenAI returned ${vectors.length} embeddings for ${texts.length} inputs`
      );
    }
    if (vectors[0].length !== EMBEDDING_DIMS) {
      throw new EmbedError(
        `OpenAI returned ${vectors[0].length}-dim embedding; expected ${EMBEDDING_DIMS}`
      );
    }

    return {
      vectors,
      model: `openai/${OPENAI_MODEL}@${EMBEDDING_DIMS}`,
      total_tokens: json.usage?.total_tokens,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function embedViaVoyage(texts: string[]): Promise<EmbedResult> {
  const apiKey = process.env.VOYAGE_API_KEY!;
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: VOYAGE_MODEL,
        input: texts,
        output_dimension: EMBEDDING_DIMS,    // Matryoshka — request 1024-d output
        output_dtype: "float",                // we store float32 in pgvector
      }),
      signal: ctrl.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new EmbedError(
        `Voyage embedding failed: status=${res.status} body=${body.slice(0, 200)}`
      );
    }

    const json = (await res.json()) as {
      data: Array<{ embedding: number[]; index: number }>;
      usage?: { total_tokens?: number };
    };

    const sorted = [...json.data].sort((a, b) => a.index - b.index);
    const vectors = sorted.map((d) => d.embedding);

    if (vectors.length !== texts.length) {
      throw new EmbedError(
        `Voyage returned ${vectors.length} embeddings for ${texts.length} inputs`
      );
    }
    if (vectors[0].length !== EMBEDDING_DIMS) {
      throw new EmbedError(
        `Voyage returned ${vectors[0].length}-dim embedding; expected ${EMBEDDING_DIMS}`
      );
    }

    return {
      vectors,
      model: `voyage/${VOYAGE_MODEL}@${EMBEDDING_DIMS}`,
      total_tokens: json.usage?.total_tokens,
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Embed a batch of strings. Primary API.
 * Returns 1024-dim Float32 vectors in input order.
 *
 * Empty array returns an empty result.
 * Empty / whitespace-only strings throw — callers should filter beforehand.
 */
export async function embedBatch(texts: string[]): Promise<EmbedResult> {
  if (texts.length === 0) {
    return { vectors: [], model: pickBackend() };
  }
  for (const t of texts) {
    if (!t || !t.trim()) {
      throw new EmbedError("Cannot embed empty/whitespace-only text");
    }
  }

  const backend = pickBackend();
  return withRetry(
    () => (backend === "voyage" ? embedViaVoyage(texts) : embedViaOpenAI(texts)),
    `embed/${backend}`
  );
}

/**
 * Embed a single string. Convenience wrapper around embedBatch.
 */
export async function embed(text: string): Promise<{ vector: number[]; model: string }> {
  const result = await embedBatch([text]);
  return { vector: result.vectors[0], model: result.model };
}

/**
 * Embed offering_summary and seeking_summary in one batch call.
 * Used by the matchpool profile-update path.
 */
export async function embedDual(input: {
  offering: string;
  seeking: string;
}): Promise<{
  offering_embedding: number[];
  seeking_embedding: number[];
  model: string;
  total_tokens?: number;
}> {
  const result = await embedBatch([input.offering, input.seeking]);
  return {
    offering_embedding: result.vectors[0],
    seeking_embedding: result.vectors[1],
    model: result.model,
    total_tokens: result.total_tokens,
  };
}

/**
 * Format a 1024-dim vector for pgvector insertion.
 * pgvector accepts a string in the format '[v1,v2,...,v1024]'.
 */
export function vectorToPgString(v: number[]): string {
  if (v.length !== EMBEDDING_DIMS) {
    throw new EmbedError(
      `Expected ${EMBEDDING_DIMS}-dim vector for pgvector; got ${v.length}`
    );
  }
  return `[${v.join(",")}]`;
}

export { EMBEDDING_DIMS, EmbedError };
