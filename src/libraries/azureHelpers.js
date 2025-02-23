/**
 * Azure OpenAI Helpers
 * @module
 * @license MIT
 * @author Joseph Balsamo <https://github.com/josephbalsamo
 */

import { rateLimiters } from "./rateLimiter.js";

/**
 * Submits a question to Azure OpenAI's GPT model for general question answering.
 *
 * @param {string} question - The user's question to be answered by the model
 * @param {string} system - System message to set the context and behavior of the model
 * @param {string} base - Base URL for the Azure OpenAI service endpoint
 * @param {string} apiKey - API key for authentication with Azure OpenAI
 * @param {string} [model="bmi-centsbot-pilot"] - The Azure OpenAI model deployment name
 * @returns {Promise<Object>} Response object with the following structure:
 *   On success:
 *   - {boolean} success - true
 *   - {string} answer - The model's response to the question
 *
 *   On error:
 *   - {boolean} success - false
 *   - {string} error - Error message describing what went wrong
 *   - {Object} details - Detailed error information
 *   - {string} answer - User-friendly error message
 *
 * @throws Will be caught and returned as an error response object
 * @example
 * const result = await submitQuestionGeneralGPT(
 *   "What are the symptoms of flu?",
 *   "You are a helpful medical assistant.",
 *   "https://your-resource.openai.azure.com/",
 *   "your-api-key"
 * );
 */
export const submitQuestionGeneralGPT = async (
  question,
  system,
  base,
  apiKey,
  model = "bmi-centsbot-pilot"
) => {
  // Parameter validation
  if (!question || typeof question !== "string") {
    throw new Error("question parameter is required and must be a string");
  }
  if (!system || typeof system !== "string") {
    throw new Error("system parameter is required and must be a string");
  }
  if (!base || typeof base !== "string") {
    throw new Error("base parameter is required and must be a string");
  }
  if (!apiKey || typeof apiKey !== "string") {
    throw new Error("apiKey parameter is required and must be a string");
  }
  if (typeof model !== "string") {
    throw new Error("model parameter must be a string");
  }

  const API_VERSION = "2024-08-01-preview";
  let url = `${base}openai/deployments/${model}/chat/completions?api-version=${API_VERSION}`;
  let headers = {
    "Content-Type": "application/json",
    "api-key": apiKey,
  };
  let body = {
    messages: [
      {
        role: "system",
        content: system,
      },
      {
        role: "user",
        content: question,
      },
    ],
  };

  try {
    // Wait for rate limiter before making the request
    await rateLimiters.chatCompletions.waitForToken();

    const response = await fetch(url, {
      method: "POST",
      headers: headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `HTTP error! status: ${response.status}, message: ${errorText}`
      );
    }

    const data = await response.json();

    if (
      !data ||
      !data.choices ||
      !data.choices[0] ||
      !data.choices[0].message
    ) {
      throw new Error("Invalid response format from Azure OpenAI");
    }

    return {
      success: true,
      answer: data.choices[0].message.content,
    };
  } catch (err) {
    return {
      success: false,
      error: err.message || "An unexpected error occurred",
      details: err,
      answer: err.message || "An unexpected error occurred",
    };
  }
};

/**
 * Submits question documents to the specified API endpoint and returns the response.
 * This function combines Azure Cognitive Search with Azure OpenAI to generate answers
 * based on document context.
 *
 * @param {string} question - The question to be submitted.
 * @param {string} system - The system prompt or context for the AI model.
 * @param {string} base - The base URL for the Azure OpenAI API.
 * @param {string} apiKey - The Azure OpenAI API key.
 * @param {string} searchEndpoint - The Azure Cognitive Search endpoint URL.
 * @param {string} searchKey - The Azure Cognitive Search admin key.
 * @param {string} indexName - The name of the search index to query.
 * @param {string} [model="gpt-4o"] - The Azure OpenAI model deployment name (e.g., 'gpt-4o', 'gpt-35-turbo').
 * @param {string} [searchType="vector"] - The type of search to perform ('vector', 'keyword', or 'semantic').
 * @param {object} [searchConfig={}] - Configuration options for the search.
 * @param {number} [searchConfig.top] - Number of results to return (default: 5).
 * @param {string[]} [searchConfig.select] - Fields to return in the results (default: ["content", "title"]).
 * @param {string} [searchConfig.semanticConfiguration] - Name of semantic configuration to use (required for semantic search).
 * @param {object} [searchConfig.filter] - OData filter expression.
 * @param {string} [searchConfig.orderBy] - OData orderby expression.
 * @param {boolean} [searchConfig.includeTotalCount] - Whether to include total result count.
 * @returns {Promise<object>} A promise that resolves to:
 *   - On success: { citations: Array, answer: string, searchResults: Array }
 *   - On error: { code: string, answer: string, error: string }
 */
export const submitQuestionDocuments = async (
  question,
  system,
  base,
  apiKey,
  searchEndpoint,
  searchKey,
  indexName,
  model = "gpt-4o",
  searchType = "vector",
  searchConfig = {}
) => {
  // Parameter validation
  if (!question || typeof question !== "string") {
    throw new Error("question parameter is required and must be a string");
  }
  if (!system || typeof system !== "string") {
    throw new Error("system parameter is required and must be a string");
  }
  if (!base || typeof base !== "string") {
    throw new Error("base parameter is required and must be a string");
  }
  if (!apiKey || typeof apiKey !== "string") {
    throw new Error("apiKey parameter is required and must be a string");
  }
  if (!searchEndpoint || typeof searchEndpoint !== "string") {
    throw new Error(
      "searchEndpoint parameter is required and must be a string"
    );
  }
  if (!searchKey || typeof searchKey !== "string") {
    throw new Error("searchKey parameter is required and must be a string");
  }
  if (!indexName || typeof indexName !== "string") {
    throw new Error("indexName parameter is required and must be a string");
  }
  if (!model || typeof model !== "string") {
    throw new Error("model parameter is required and must be a string");
  }

  try {
    // First, query the search index to get relevant documents
    const searchResults = await querySearchIndex({
      searchEndpoint,
      searchKey,
      indexName,
      queryText: question,
      searchType,
      top: searchConfig.top || 5,
      select: searchConfig.select || ["content", "title"],
      semanticConfiguration: searchConfig.semanticConfiguration || "",
      filter: searchConfig.filter || null,
      orderBy: searchConfig.orderBy || null,
      includeTotalCount: searchConfig.includeTotalCount || false,
    });

    if (!searchResults.success) {
      throw new Error(searchResults.error || "Search query failed");
    }

    // Format the search results for the AI model
    const contextDocuments = searchResults.results.map((doc) => ({
      content: doc.content,
      source: doc.source,
      title: doc.title,
      category: doc.category,
    }));

    // Prepare the request for the AI model
    // Format URL for GPT-4 and later versions
    const normalizedBase = base.endsWith("/") ? base : `${base}/`;
    const url = `${normalizedBase}openai/deployments/${model}/chat/completions?api-version=2023-12-01-preview`;

    console.log("\nDebug - Attempting to call URL:", url);

    let headers = {
      "Content-Type": "application/json",
      "api-key": apiKey,
    };
    let body = {
      messages: [
        {
          role: "system",
          content: `${system}\n\nPlease provide your response in two parts:
          1. First, output a plain JSON object (no markdown formatting) containing the citations array
          2. Then, after a double newline, provide your answer to the question

          Use the search results to inform your answer.`,
        },
        {
          role: "user",
          content: question,
        },
      ],
      temperature: 0.7,
      top_p: 0.95,
      frequency_penalty: 0,
      presence_penalty: 0,
      max_tokens: 800,
      stop: null,
    };

    console.log("\nDebug - Request Body:", JSON.stringify(body, null, 2));

    // Wait for rate limiter before making the request
    await rateLimiters.chatCompletions.waitForToken();

    const response = await fetch(url, {
      method: "POST",
      headers: headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `HTTP error! status: ${response.status}, details: ${errorText}`
      );
    }

    const data = await response.json();
    console.log("\nDebug - Full API Response:", JSON.stringify(data, null, 2));

    if (data.error) {
      throw new Error(data.error.message || "Unknown API error");
    }

    // Check for message in the response
    const message = data.choices?.[0]?.message;
    if (!message?.content) {
      throw new Error(
        "Unexpected API response format - no message content found"
      );
    }

    // Try to extract citations and answer from the message
    let citations = [];
    let answer = "";

    try {
      // The message content should start with a JSON object containing citations
      const contentLines = message.content.split("\n\n");
      if (contentLines.length >= 2) {
        // First part should be the JSON with citations
        const citationsJson = JSON.parse(contentLines[0]);
        citations = citationsJson.citations || [];

        // Rest is the answer
        answer = contentLines.slice(1).join("\n\n");
      } else {
        // If we can't split it, try to parse the whole thing as JSON first
        try {
          const parsed = JSON.parse(message.content);
          citations = parsed.citations || [];
        } catch {
          // If that fails, just use the whole content as the answer
          answer = message.content;
        }
      }
    } catch (err) {
      console.warn("Failed to parse message content:", err.message);
      // Use the whole message as the answer if parsing fails
      answer = message.content;
    }

    return {
      citations,
      answer: answer.trim(),
      searchResults: contextDocuments, // Include the search results in the response
    };
  } catch (err) {
    // If error occurs during processing, return an error response
    return {
      code: err.name || "ERROR",
      answer: err.message || "An unexpected error occurred",
      error: err.message,
    };
  }
};

/**
 * Generates vector embeddings for text using Azure OpenAI
 * @param {string} text - The text to generate embeddings for
 * @returns {Promise<number[]>} The vector embedding
 */
async function generateEmbedding(text) {
  // Use text-embedding-ada-002 model for embeddings
  const url =
    "https://azopenai-pilot.openai.azure.com/openai/deployments/text-embedding-ada-002/embeddings?api-version=2023-05-15";
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-key": process.env.AZ_API_KEY,
    },
    body: JSON.stringify({
      input: text,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Failed to generate embedding: ${response.status} - ${errorText}`
    );
  }

  const data = await response.json();
  return data.data[0].embedding;
}

/**
 * Queries data from an Azure Cognitive Search index using either vector or regular search.
 *
 * @typedef {Object} SearchParameters
 * @property {string} searchEndpoint - The Azure Cognitive Search service endpoint URL
 * @property {string} searchKey - The Azure Cognitive Search admin key
 * @property {string} indexName - The name of the search index to query
 * @property {string} queryText - The text query to search for
 * @property {('vector'|'keyword'|'semantic')} [searchType='vector'] - Type of search to perform
 * @property {number} [top=5] - Number of results to return
 * @property {string[]} [select] - Fields to return in the results
 * @property {string} [semanticConfiguration] - Name of the semantic configuration to use (for semantic search)
 * @property {Object} [filter] - OData filter expression
 * @property {string} [orderBy] - OData orderby expression
 * @property {boolean} [includeTotalCount=false] - Whether to include the total count of matches
 *
 * @typedef {Object} SearchResult
 * @property {boolean} success - Whether the search was successful
 * @property {Array<Object>} results - Array of search results
 * @property {number} [count] - Total number of matches (if requested)
 * @property {Object} [coverage] - Search coverage information
 * @property {string} [error] - Error message if search failed
 * @property {Object} [details] - Detailed error information if search failed
 *
 * @param {SearchParameters} params - The parameters for the search query
 * @returns {Promise<SearchResult>} A Promise that resolves to the search results
 * @throws {Error} If required parameters are missing or invalid
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
  filter = null,
  orderBy = null,
  includeTotalCount = false,
}) => {
  // Parameter validation
  if (!searchEndpoint || typeof searchEndpoint !== "string") {
    throw new Error(
      "searchEndpoint parameter is required and must be a string"
    );
  }
  if (!searchKey || typeof searchKey !== "string") {
    throw new Error("searchKey parameter is required and must be a string");
  }
  if (!indexName || typeof indexName !== "string") {
    throw new Error("indexName parameter is required and must be a string");
  }
  if (!queryText || typeof queryText !== "string") {
    throw new Error("queryText parameter is required and must be a string");
  }
  if (!["vector", "keyword", "semantic"].includes(searchType)) {
    throw new Error("searchType must be one of: vector, keyword, semantic");
  }

  // Validate semantic configuration for semantic search
  if (searchType === "semantic" && !semanticConfiguration) {
    throw new Error("semanticConfiguration is required for semantic search");
  }

  try {
    const baseUrl = `${searchEndpoint}/indexes/${indexName}/docs`;
    let searchUrl = `${baseUrl}/search?api-version=2023-11-01`;

    // Use preview API version for vector search
    if (searchType === "vector") {
      searchUrl = `${baseUrl}/search?api-version=2023-07-01-preview`;
    }

    const searchRequest = {
      search: searchType === "vector" ? "*" : queryText,
      select: select.join(","),
      top,
      filter,
      orderby: orderBy,
      count: includeTotalCount,
    };

    // Add semantic configuration for semantic search
    if (searchType === "semantic") {
      searchRequest.queryType = "semantic";
      searchRequest.semanticConfiguration = semanticConfiguration;
    }

    // Add vector search configuration
    if (searchType === "vector") {
      searchRequest.vectors = [
        {
          value: await generateEmbedding(queryText),
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
      throw new Error(
        `Search request failed: ${response.status} - ${errorData}`
      );
    }

    const data = await response.json();

    // Debug: Log the first result to see available fields
    if (data.value && data.value.length > 0) {
      console.log("\nDebug - First result fields:", Object.keys(data.value[0]));
      console.log("First result:", data.value[0]);
    }

    // Format results consistently for all search types
    const formattedResults = data.value.map((result) => {
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
    });

    return {
      success: true,
      results: formattedResults,
      count: data["@odata.count"],
      coverage: data["@search.coverage"],
    };
  } catch (error) {
    return {
      success: false,
      error: error.message || "An unexpected error occurred during the search",
      details: error,
      results: [],
    };
  }
};
