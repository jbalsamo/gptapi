/**
 * Azure OpenAI Helpers
 * @module
 * @license MIT
 * @author Joseph Balsamo <https://github.com/josephbalsamo
 */

import { rateLimiters } from "./rateLimiter";

interface AzureError extends Error {
  message: string;
  name: string;
  status?: number;
  code?: string;
}

interface AzureDocument {
  content: string;
  title: string;
  source?: string;
  category?: string;
  '@search.score'?: number;
  '@search.rerankerScore'?: number;
  '@search.captions'?: Array<{ text: string }>;
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface ChatCompletionRequest {
  messages: ChatMessage[];
  temperature?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  max_tokens?: number;
  stop?: string | string[] | null;
}

interface AzureOpenAIResponse {
  success: boolean;
  answer?: string;
  error?: string;
  details?: unknown;
  searchResults?: AzureDocument[];
}

interface SearchConfig {
  top?: number;
  select?: string[];
  semanticConfiguration?: string;
  filter?: string;
  orderBy?: string;
  includeTotalCount?: boolean;
}

interface SearchResult {
  success: boolean;
  results: AzureDocument[];
  count?: number;
  coverage?: unknown;
  error?: string;
  details?: unknown;
}

/**
 * Submits a question to Azure OpenAI's GPT model for general question answering.
 */
export const submitQuestionGeneralGPT = async (
  question: string,
  system: string,
  base: string,
  apiKey: string,
  model: string = "bmi-centsbot-pilot"
): Promise<AzureOpenAIResponse> => {
  // Parameter validation
  if (!question || typeof question !== "string") {
    throw new Error("question parameter is required and must be a string");
  }
  if (!system || typeof system !== "string") {
    throw new Error("system parameter is required and must be a string");
  }

  try {
    await rateLimiters.chatCompletions.waitForToken();

    const requestBody: ChatCompletionRequest = {
      messages: [
        { role: "system", content: system },
        { role: "user", content: question },
      ],
      temperature: 0.7,
      top_p: 0.95,
      frequency_penalty: 0,
      presence_penalty: 0,
      max_tokens: 800,
      stop: null,
    };

    const response = await fetch(`${base}/openai/deployments/${model}/chat/completions?api-version=2023-07-01-preview`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": apiKey,
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    return {
      success: true,
      answer: data.choices[0].message.content.trim(),
    };
  } catch (error: unknown) {
    console.error("Error in submitQuestionGeneralGPT:", error);
    
    const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
    
    return {
      success: false,
      error: errorMessage,
      details: error,
      answer: "I apologize, but I encountered an error while processing your question. Please try again later.",
    };
  }
};

/**
 * Submits question documents to Azure Cognitive Search and OpenAI for processing.
 */
export const submitQuestionDocuments = async (
  question: string,
  system: string,
  base: string,
  apiKey: string,
  searchEndpoint: string,
  searchKey: string,
  indexName: string,
  model: string = "gpt-4o",
  searchType: "vector" | "keyword" | "semantic" = "vector",
  searchConfig: Partial<SearchConfig> = {}
): Promise<AzureOpenAIResponse> => {
  try {
    // First, search for relevant documents
    const searchResults = await querySearchIndex({
      searchEndpoint,
      searchKey,
      indexName,
      queryText: question,
      searchType,
      ...searchConfig,
    });

    if (!searchResults.success) {
      throw new Error("Failed to retrieve relevant documents");
    }

    // Format documents for context
    const context = searchResults.results && searchResults.results.length > 0
      ? searchResults.results
          .map(doc => `${doc.content}\nSource: ${doc.title || "Unknown"}`)
          .join("\n\n")
      : "No relevant documents found.";

    // Submit to Azure OpenAI with context
    const response = await submitQuestionGeneralGPT(
      `Context:\n${context}\n\nQuestion: ${question}`,
      system,
      base,
      apiKey,
      model
    );

    return {
      ...response,
      searchResults: searchResults.results,
    };
  } catch (error: unknown) {
    console.error("Error in submitQuestionDocuments:", error);
    
    const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
    
    return {
      success: false,
      error: errorMessage,
      details: error,
      answer: "I apologize, but I encountered an error while processing your question with the available documents. Please try again later.",
    };
  }
};

/**
 * Queries data from an Azure Cognitive Search index.
 */
export const querySearchIndex = async ({
  searchEndpoint,
  searchKey,
  indexName,
  queryText,
  searchType = "vector",
  top = 5,
  select = ["content", "title"],
  semanticConfiguration = "",
  filter = undefined,
  orderBy = undefined,
  includeTotalCount = false,
}: {
  searchEndpoint: string;
  searchKey: string;
  indexName: string;
  queryText: string;
  searchType?: "vector" | "keyword" | "semantic";
  top?: number;
  select?: string[];
  semanticConfiguration?: string;
  filter?: string;
  orderBy?: string;
  includeTotalCount?: boolean;
}): Promise<SearchResult> => {
  try {
    await rateLimiters.search.waitForToken();

    const headers = {
      "Content-Type": "application/json",
      "api-key": searchKey,
    };

    const searchParams: Record<string, unknown> = {
      count: includeTotalCount,
      select: select.join(","),
      top,
    };

    if (filter) searchParams.$filter = filter;
    if (orderBy) searchParams.$orderby = orderBy;

    if (searchType === "semantic" && semanticConfiguration) {
      searchParams.queryType = "semantic";
      searchParams.semanticConfiguration = semanticConfiguration;
      searchParams.queryLanguage = "en-us";
      searchParams.captions = "extractive";
      searchParams.answers = "extractive";
      searchParams.search = queryText;
    } else if (searchType === "vector") {
      const embedding = await generateEmbedding(queryText);
      searchParams.vectors = [{
        value: embedding,
        fields: "contentVector",
        k: top,
      }];
    } else {
      searchParams.search = queryText;
    }

    const response = await fetch(
      `${searchEndpoint}/indexes/${indexName}/docs/search?api-version=2023-07-01-Preview`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(searchParams),
      }
    );

    if (!response.ok) {
      throw new Error(`Search request failed: ${response.status}`);
    }

    const data = await response.json();
    
    // Type assertion for the response data
    const documents = (data.value || []) as AzureDocument[];
    
    return {
      success: true,
      results: documents,
      count: data["@odata.count"],
      coverage: data["@search.coverage"],
    };
  } catch (error: unknown) {
    console.error("Error in querySearchIndex:", error);
    
    const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
    
    return {
      success: false,
      results: [],
      error: errorMessage,
      details: error,
    };
  }
};

/**
 * Generates vector embeddings for text using Azure OpenAI
 */
export const generateEmbedding = async (text: string): Promise<number[]> => {
  // Use text-embedding-ada-002 model for embeddings
  const url =
    "https://azopenai-pilot.openai.azure.com/openai/deployments/text-embedding-ada-002/embeddings?api-version=2023-05-15";

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-key": process.env.AZ_API_KEY || "",
    },
    body: JSON.stringify({
      input: text,
    }),
  });

  if (!response.ok) {
    throw new Error(`Embedding request failed: ${response.status}`);
  }

  const data = await response.json();
  return data.data[0].embedding;
};
