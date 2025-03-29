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
  "@search.score"?: number;
  "@search.rerankerScore"?: number;
  "@search.captions"?: Array<{ text: string }>;
}

interface ChatMessage {
  role: "system" | "user" | "assistant";
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

    const url = `${base}openai/deployments/${model}/chat/completions?api-version=2025-01-01-preview`;
    console.log(`Azure OpenAI URL: ${url}`);
    
    const response = await fetch(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "api-key": apiKey,
        },
        body: JSON.stringify(requestBody),
      }
    );

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

    const errorMessage =
      error instanceof Error ? error.message : "An unknown error occurred";

    return {
      success: false,
      error: errorMessage,
      details: error,
      answer:
        "I apologize, but I encountered an error while processing your question. Please try again later.",
    };
  }
};

/**
 * Submits question documents to Azure Cognitive Search and OpenAI for processing.
 * Uses environment variables for Azure configuration and implements robust error handling.
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
  searchType: "vector" | "keyword" | "semantic" = "semantic", // Default to semantic search
  searchConfig: Partial<SearchConfig> = {}
): Promise<AzureOpenAIResponse> => {
  try {
    console.log(`Searching for documents related to: "${question}"`);
    console.log(`Using index: ${indexName}, search type: ${searchType}`);

    // Set default search configuration with reasonable values
    const defaultSearchConfig: Partial<SearchConfig> = {
      top: 5, // Get top 5 results
      // Don't specify select fields to let Azure return whatever fields are available
      includeTotalCount: true,
    };

    // If semantic search, add semantic configuration
    if (searchType === "semantic") {
      defaultSearchConfig.semanticConfiguration = "default";
    }

    // Merge default config with provided config
    const mergedConfig = { ...defaultSearchConfig, ...searchConfig };

    // First, search for relevant documents
    const searchResults = await querySearchIndex({
      searchEndpoint,
      searchKey,
      indexName,
      queryText: question,
      searchType,
      ...mergedConfig,
    });

    // Check if search was successful
    if (!searchResults.success) {
      console.error(`Search failed with error: ${searchResults.error}`);
      throw new Error(
        `Failed to retrieve relevant documents: ${searchResults.error}`
      );
    }

    // Log search results count
    console.log(
      `Found ${searchResults.results?.length || 0} relevant documents`
    );

    // Format documents for context
    let context = "No relevant documents found.";

    if (searchResults.results && searchResults.results.length > 0) {
      // Format each document with its content and metadata
      context = searchResults.results
        .map((doc, index) => {
          const score =
            doc["@search.score"] || doc["@search.rerankerScore"] || "N/A";
          const source = doc.source || doc.title || "Unknown";
          return `[Document ${index + 1}] (Score: ${score})\n${
            doc.content
          }\nSource: ${source}`;
        })
        .join("\n\n");
    }

    console.log("Submitting question to Azure OpenAI with context");

    // Prepare the prompt with context and question
    const promptWithContext = `\n\nContext Information:\n${context}\n\nQuestion: ${question}\n\nPlease provide a comprehensive answer based on the context provided.`;

    // Submit to Azure OpenAI with context
    const response = await submitQuestionGeneralGPT(
      promptWithContext,
      system,
      base,
      apiKey,
      model
    );

    if (!response.success) {
      console.error(`OpenAI query failed: ${response.error}`);
    } else {
      console.log("Successfully received response from Azure OpenAI");
    }

    return {
      ...response,
      searchResults: searchResults.results,
    };
  } catch (error: unknown) {
    console.error("Error in submitQuestionDocuments:", error);

    const errorMessage =
      error instanceof Error ? error.message : "An unknown error occurred";

    return {
      success: false,
      error: errorMessage,
      details: error,
      answer:
        "I apologize, but I encountered an error while processing your question with the available documents. Please try again later.",
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
    
    console.log(`Searching for documents related to: "${queryText}"`);
    console.log(`Using index: ${indexName}, search type: ${searchType}`);
    
    // Validate semantic configuration for semantic search
    if (searchType === "semantic" && !semanticConfiguration) {
      throw new Error("semanticConfiguration is required for semantic search");
    }

    // Determine the base URL and API version based on search type
    const baseUrl = `${searchEndpoint}/indexes/${indexName}/docs`;
    let searchUrl = `${baseUrl}/search?api-version=2023-11-01`;

    // Use preview API version for vector search
    if (searchType === "vector") {
      searchUrl = `${baseUrl}/search?api-version=2023-07-01-Preview`;
    }

    // Prepare search parameters
    const searchRequest: Record<string, any> = {
      search: searchType === "vector" ? "*" : queryText,
      top,
      count: includeTotalCount,
    };
    
    // We're not specifying select fields to avoid errors with missing fields
    // Azure will return all available fields by default

    if (filter) searchRequest.filter = filter;
    if (orderBy) searchRequest.orderby = orderBy;

    // Add semantic configuration for semantic search
    if (searchType === "semantic") {
      searchRequest.queryType = "semantic";
      searchRequest.semanticConfiguration = semanticConfiguration;
      searchRequest.queryLanguage = "en-us";
      searchRequest.captions = "extractive";
      searchRequest.answers = "extractive";
    }

    // Add vector search configuration
    if (searchType === "vector") {
      const embedding = await generateEmbedding(queryText);
      searchRequest.vectors = [
        {
          value: embedding,
          fields: "contentVector",
          k: top,
        },
      ];
    }

    // Add keyword search configuration
    if (searchType === "keyword") {
      searchRequest.queryType = "simple";
      searchRequest.searchMode = "all";
    }

    // Remove undefined/null values
    Object.keys(searchRequest).forEach(
      (key) =>
        (searchRequest[key] === undefined || searchRequest[key] === null) &&
        delete searchRequest[key]
    );

    const response = await fetch(searchUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": searchKey,
      },
      body: JSON.stringify(searchRequest),
    });

    if (!response.ok) {
      const errorData = await response.text();
      console.warn("Azure response contains an error message:");
      throw new Error(`Search request failed: ${response.status} - ${errorData}`);
    }

    const data = await response.json();

    // Debug: Log the first result to see available fields
    if (data.value && data.value.length > 0) {
      console.log("\nDebug - First result fields:", Object.keys(data.value[0]));
      console.log("First result:", data.value[0]);
    }

    // Format results consistently for all search types
    const formattedResults = data.value.map((result: any) => {
      // Keep the original fields
      const formatted = {
        ...result,
        // Add our standard fields with proper fallbacks
        content: result.content || result.text || "",
        title: result.title || result.name || "",
        score: result["@search.score"] || 0,
      };

      // Remove any undefined values
      Object.keys(formatted).forEach(
        (key) => formatted[key] === undefined && delete formatted[key]
      );

      return formatted;
    }) as AzureDocument[];

    return {
      success: true,
      results: formattedResults,
      count: data["@odata.count"],
      coverage: data["@search.coverage"],
    };
  } catch (error: unknown) {
    console.error("Error in querySearchIndex:", error);

    const errorMessage =
      error instanceof Error ? error.message : "An unknown error occurred";

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
