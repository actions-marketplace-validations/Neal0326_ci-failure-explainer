export type ConfidenceLevel = "low" | "medium" | "high";

export interface FailureExplanation {
  shortSummary: string;
  likelyRootCause: string;
  specificFixSteps: string[];
  confidenceLevel: ConfidenceLevel;
}

export interface ExplainFailureOptions {
  apiKey: string;
  model: string;
  prompt: string;
}

interface OpenAIChatResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
    };
  }>;
  error?: {
    message?: string;
    type?: string;
  };
}

export async function explainFailureWithOpenAI(
  options: ExplainFailureOptions,
): Promise<FailureExplanation> {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${options.apiKey}`,
    },
    body: JSON.stringify({
      model: options.model,
      temperature: 0.2,
      response_format: {
        type: "json_object",
      },
      max_tokens: 300,
      messages: [
        {
          role: "system",
          content:
            "Analyze the CI failure logs below. Focus on the first failing step. Ignore secondary warnings. Explain the root cause briefly. Return strict JSON with keys shortSummary, likelyRootCause, specificFixSteps, confidenceLevel. specificFixSteps must be an array of concise, concrete steps. confidenceLevel must be one of low, medium, or high.",
        },
        {
          role: "user",
          content: options.prompt,
        },
      ],
    }),
    signal: AbortSignal.timeout(60_000),
  });

  const rawPayload = await response.text();
  const payload = parseChatResponse(rawPayload);

  if (!response.ok) {
    throw new Error(
      `OpenAI API request failed: ${response.status} ${response.statusText}${
        payload.error?.message ? ` - ${payload.error.message}` : ""
      }`,
    );
  }

  const rawContent = payload.choices?.[0]?.message?.content;
  if (!rawContent) {
    throw new Error("OpenAI response did not contain any message content.");
  }

  return normalizeExplanation(parseExplanation(rawContent));
}

function parseExplanation(content: string): FailureExplanation {
  try {
    return JSON.parse(content) as FailureExplanation;
  } catch {
    const firstBrace = content.indexOf("{");
    const lastBrace = content.lastIndexOf("}");

    if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
      throw new Error("OpenAI response was not valid JSON.");
    }

    return JSON.parse(content.slice(firstBrace, lastBrace + 1)) as FailureExplanation;
  }
}

function parseChatResponse(content: string): OpenAIChatResponse {
  try {
    return JSON.parse(content) as OpenAIChatResponse;
  } catch {
    throw new Error("OpenAI API response was not valid JSON.");
  }
}

function normalizeExplanation(explanation: Partial<FailureExplanation>): FailureExplanation {
  const shortSummary =
    typeof explanation.shortSummary === "string" ? explanation.shortSummary.trim() : "";
  const likelyRootCause =
    typeof explanation.likelyRootCause === "string"
      ? explanation.likelyRootCause.trim()
      : "";
  const specificFixSteps = Array.isArray(explanation.specificFixSteps)
    ? explanation.specificFixSteps
        .filter((step): step is string => typeof step === "string")
        .map((step) => step.trim())
        .filter((step) => step.length > 0)
    : [];

  if (!shortSummary || !likelyRootCause || specificFixSteps.length === 0) {
    throw new Error("OpenAI response JSON is missing required fields.");
  }

  return {
    shortSummary,
    likelyRootCause,
    specificFixSteps,
    confidenceLevel: normalizeConfidenceLevel(explanation.confidenceLevel),
  };
}

export function normalizeConfidenceLevel(value: unknown): ConfidenceLevel {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";

  if (normalized === "high" || normalized === "medium" || normalized === "low") {
    return normalized;
  }

  return "low";
}
