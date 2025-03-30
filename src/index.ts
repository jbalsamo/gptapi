/*
 * CentsBot API
 */
import { serve } from "@hono/node-server";
import { config } from "dotenv";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { appConfig } from "./config/config";
import { prompts } from "./constants/prompts";
import {
  submitQuestionDocuments,
  submitQuestionGeneralGPT,
} from "./libraries/azureHelpers";
import {
  loginDrupal,
  logoutDrupal,
  post2Drupal,
  postSimilar2Drupal,
} from "./libraries/drupalHelpers";
import { appLogger } from "./utils/logger";

// Load environment variables
config();

// Initialize constants
const port = 3000;

// Initialize Drupal connection
const drupalUrl = appConfig.drupal.baseUrl;
const azBaseUrl = appConfig.azure.baseUrl;
const azApiKey = appConfig.azure.apiKey;
const azSearchEndpoint = appConfig.azure.search.endpoint;
const azSearchKey = appConfig.azure.search.key;
const azIndexName = appConfig.azure.search.indexName;
const azPMIndexName = appConfig.azure.search.pmVectorIndexName;
const azDeploymentName = appConfig.azure.deployment.name;
const azAnswersIndexName = appConfig.azure.search.answersIndexName;

// Initialize Drupal credentials
const uname = appConfig.drupal.username;
const pword = appConfig.drupal.password;

interface DrupalNode {
  nid: string;
  field_enter_question?: {
    value: string;
  }[];
}

interface SimilarAnswer {
  question: string;
  answer: string;
}

interface AzureOpenAIResponse {
  answer?: string;
  citations?: Array<{
    url: string;
    filepath: string;
  }>;
}

interface AzureResponse {
  answer: string;
  citations?: Array<{
    url: string;
    filepath: string;
  }>;
}

interface QuestionResponse {
  dataDocs: AzureResponse;
  dataGPT: AzureResponse;
  dataPMA: AzureResponse;
  dataSummary: string | AzureResponse;
}

// Helper function to ensure Azure response has required fields
function ensureAzureResponse(response: AzureOpenAIResponse): AzureResponse {
  if (!response.answer) {
    return {
      answer: "No answer available",
      citations: response.citations,
    };
  }
  return {
    answer: response.answer,
    citations: response.citations,
  };
}

const app = new Hono();

// Add middleware
app.use(logger());

// Add error handler middleware
app.onError((err, c) => {
  appLogger.error("Server error:", err);
  return c.json(
    {
      status: "error",
      message:
        process.env.NODE_ENV === "production"
          ? "Internal server error"
          : err.message,
    },
    500
  );
});

// Add not found handler
app.notFound((c) => {
  appLogger.warn(`Route not found: ${c.req.url}`);
  return c.json(
    {
      status: "error",
      message: "Not found",
    },
    404
  );
});

// Add request logging middleware
app.use("*", async (c, next) => {
  const start = Date.now();
  await next();
  const ms = Date.now() - start;
  appLogger.info(`${c.req.method} ${c.req.url} - ${ms}ms`);
});

// Add request validation middleware
app.use("/api/*", async (c, next) => {
  if (!c.req.header("content-type")?.includes("application/json")) {
    appLogger.warn("Invalid content type:", c.req.header("content-type"));
    return c.json(
      {
        status: "error",
        message: "Content-Type must be application/json",
      },
      400
    );
  }
  await next();
});

// Log startup
appLogger.info(`Server initializing with configuration:
  - Drupal URL: ${drupalUrl}
  - Azure Search Endpoint: ${azSearchEndpoint}
  - Azure Index: ${azIndexName}
  - Azure PM Index: ${azPMIndexName}
  - Port: ${port}
`);

// Functions

/**
 * Searches for similar questions and answers in the knowledge base using Azure Cognitive Search.
 * Uses AI to find and extract the most relevant QA pairs based on semantic similarity.
 *
 * @param node - The node context for the search (type: DrupalNode)
 * @param question - The user's question to find similar matches for
 * @returns Promise<Array<SimilarAnswer>> Array of similar QA pairs, or a default "not found" message if no matches
 *
 * @requires Environment Variables:
 *   - azBaseUrl: Azure base URL
 *   - azApiKey: Azure API key
 *   - azSearchEndpoint: Azure Cognitive Search endpoint
 *   - azSearchKey: Azure Cognitive Search key
 *   - azAnswersIndexName: Name of the answers index
 *
 * @example
 * const similarQAs = await findSimilarAnswers(nodeContext, "What are the symptoms of diabetes?");
 * // Returns: [{nid: "123", category: "Health", question: "...", answer: "..."}]
 */
const findSimilarAnswers = async (
  node: DrupalNode,
  question: string
): Promise<SimilarAnswer[]> => {
  // Environment variables are validated by config.ts
  const systemPrompt = prompts.findSimilarAnswers.systemPrompt;
  const userPrompt = prompts.findSimilarAnswers.userPrompt.replace(
    "{question}",
    question
  );

  // Log what we're doing
  appLogger.info(`Finding similar answers for question: "${question}"`);

  // Send only the actual question to Azure search, not the prompt template
  const response = await submitQuestionDocuments(
    question, // Use the raw question for search
    systemPrompt,
    azBaseUrl,
    azApiKey,
    azSearchEndpoint,
    azSearchKey,
    azAnswersIndexName,
    azDeploymentName,
    "keyword", // Use keyword search instead of semantic search
    {
      top: 8 // Get top 8 results for a better balance between coverage and relevance
      // Don't specify select fields to let Azure return whatever fields are available
    }
  );

  // Ensure we have a valid response
  const azureResponse = ensureAzureResponse(response);

  // Extract search scores from the response if available
  const searchScores: Record<string, number> = {};
  if (response.searchResults && Array.isArray(response.searchResults)) {
    response.searchResults.forEach((result: any, index: number) => {
      // Use the search score or reranker score if available
      const score = result["@search.score"] || result["@search.rerankerScore"] || result.score || 0;
      // Use the content as a key to match with parsed answers later
      if (result.content) {
        searchScores[result.content] = score;
      }
      // Also log the scores for debugging
      appLogger.info(`Search result ${index + 1} score: ${score}`);
    });
  }

  try {
    // Check if the answer looks like an error message
    if (
      typeof azureResponse.answer === "string" &&
      (azureResponse.answer.includes("Cannot read properties") ||
        azureResponse.answer.startsWith("Error:") ||
        azureResponse.answer.includes("error"))
    ) {
      appLogger.warn(
        "Azure response contains an error message:",
        azureResponse.answer
      );
      return [
        {
          question: "No closely related questions or answers found",
          answer: "Please check back for an answer to your question later.",
        },
      ];
    }

    // Try to parse the answer string into an array of SimilarAnswer
    let parsedAnswers;
    try {
      // Add more detailed logging to help debug the issue
      appLogger.info("Attempting to parse Azure response as JSON:");

      // If the response is too long for logging, truncate it
      if (azureResponse.answer.length > 500) {
        appLogger.info(azureResponse.answer.substring(0, 500) + "... (truncated)");
      } else {
        appLogger.info(azureResponse.answer);
      }

      // Function to sanitize and format the response for proper JSON parsing
      const sanitizeJsonResponse = (text: string): string => {
        // First, try to extract just the JSON array if there's extra text
        const jsonArrayMatch = text.match(/\[\s*\{.*\}\s*\]/s);
        if (jsonArrayMatch) {
          text = jsonArrayMatch[0];
        }

        // Handle common JSON formatting issues
        try {
          // Try parsing as is first
          JSON.parse(text);
          return text; // If it parses successfully, return as is
        } catch (e) {
          // If parsing fails, try to fix common issues

          // First, extract the question and answer pairs
          const questionAnswerPairs: Array<{question: string, answer: string}> = [];

          try {
            // Try to extract structured data even if JSON is malformed
            const matches = text.match(/\{\s*"question"\s*:\s*"([^"]*?)"\s*,\s*"answer"\s*:\s*"([^]*?)"\s*\}/g);

            if (matches && matches.length > 0) {
              // Process each match to properly escape HTML content
              for (const match of matches) {
                const questionMatch = match.match(/"question"\s*:\s*"([^"]*?)"/);
                const answerMatch = match.match(/"answer"\s*:\s*"([^]*?)"\s*\}/);

                if (questionMatch && answerMatch) {
                  const question = questionMatch[1];
                  let answer = answerMatch[1];

                  // Properly escape quotes and backslashes in the answer
                  answer = answer.replace(/\\/g, '\\\\');
                  answer = answer.replace(/"/g, '\\"');

                  // Preserve HTML tags and entities
                  answer = answer.replace(/\n/g, '\\n');

                  questionAnswerPairs.push({
                    question,
                    answer
                  });
                }
              }

              // If we successfully extracted pairs, create a proper JSON array
              if (questionAnswerPairs.length > 0) {
                return JSON.stringify(questionAnswerPairs);
              }
            }
          } catch (extractError) {
            appLogger.error("Error extracting structured data:", extractError);
          }

          // If we couldn't extract structured data, try a different approach
          try {
            // Escape all quotes within HTML tags
            text = text.replace(/(<[^>]*)(")(.*?)(")/g, (match, p1, p2, p3, p4) => {
              return p1 + '\\"' + p3 + '\\"';
            });

            // Preserve HTML entities
            text = text.replace(/&nbsp;/g, ' ');
            text = text.replace(/&amp;/g, '&');
            text = text.replace(/&lt;/g, '<');
            text = text.replace(/&gt;/g, '>');

            // Escape newlines and other special characters
            text = text.replace(/\n/g, '\\n');
            text = text.replace(/\r/g, '\\r');
            text = text.replace(/\t/g, '\\t');
          } catch (escapeError) {
            appLogger.error("Error escaping HTML content:", escapeError);
          }

          // If all else fails, create a valid fallback response
          try {
            JSON.parse(text);
            return text;
          } catch (e2) {
            // Return a valid fallback JSON if we still can't parse it
            return '[{"question":"No closely related questions or answers found","answer":"Please try rephrasing your question or ask something else."}]';
          }
        }
      };

      // Sanitize and parse the response
      const sanitizedResponse = sanitizeJsonResponse(azureResponse.answer);
      appLogger.info("Sanitized response for parsing:");
      if (sanitizedResponse.length > 500) {
        appLogger.info(sanitizedResponse.substring(0, 500) + "... (truncated)");
      } else {
        appLogger.info(sanitizedResponse);
      }

      // Parse the sanitized response
      parsedAnswers = JSON.parse(sanitizedResponse);
    } catch (parseError) {
      appLogger.error(
        "Failed to parse Azure response as JSON:",
        parseError
      );
      appLogger.error("Raw response content:", azureResponse.answer);
      return [
        {
          question: "No closely related questions or answers found",
          answer: "Please check back for an answer to your question later.",
        },
      ];
    }

    // Validate the parsed data is an array
    if (!Array.isArray(parsedAnswers)) {
      appLogger.warn("Azure response was not an array:", azureResponse.answer);
      return [
        {
          question: "No closely related questions or answers found",
          answer: "Please check back for an answer to your question later.",
        },
      ];
    }
    
    // If the LLM returned the default "no answers" message and we have search results,
    // let's use the search results directly
    if (parsedAnswers.length === 1 && 
        parsedAnswers[0].question === "No closely related questions or answers found" &&
        response.searchResults && 
        response.searchResults.length > 0) {
      
      appLogger.info(`LLM returned no answers but we have search results. Using search results directly.`);
      
      // Convert search results to answer format
      parsedAnswers = response.searchResults.map((result: any, index: number) => {
        // Extract question and answer from content
        const content = result.content || '';
        let question = result.title || `Search Result ${index + 1}`;
        let answer = content;
        
        // Calculate a relevance score based on search score
        // Azure search scores are typically between 1-10, normalize to 0-1
        const searchScore = result['@search.score'] || result['@search.rerankerScore'] || 0;
        const normalizedScore = Math.min(searchScore / 5, 0.95); // Cap at 0.95
        
        return {
          question,
          answer,
          relevanceScore: normalizedScore
        };
      });
      
      appLogger.info(`Created ${parsedAnswers.length} answers from search results`);
    }

    // Filter answers based on confidence score (if available)
    // Default confidence threshold is 45%
    const confidenceThreshold = 0.45; // 45% confidence threshold

    // Add search scores to the parsed answers if available
    parsedAnswers.forEach((answer: any) => {
      // If the answer has a relevanceScore from the LLM, use it
      if (answer.relevanceScore !== undefined) {
        // Convert the 0-1 relevanceScore to our 0-20 scale
        answer.score = answer.relevanceScore * 20;
        appLogger.info(`Using LLM relevance score: ${answer.relevanceScore} (converted to ${answer.score})`);
        return;
      }
      
      // Otherwise, set a default low score - this ensures all answers have a score
      // and will be filtered out if they don't match the threshold
      answer.score = 0.1; // Default low score (5% of max score)

      // Try to match the answer with a search result using content
      // This is a heuristic approach since we don't have direct IDs to match
      let foundMatch = false;

      // First try matching by question similarity
      if (answer.question) {
        // Get the question text without any HTML tags
        const cleanQuestion = answer.question.replace(/<[^>]*>/g, '');
        const cleanQueryLower = question.toLowerCase();
        const cleanQuestionLower = cleanQuestion.toLowerCase();

        // Check for exact match or very close match
        if (cleanQuestionLower === cleanQueryLower ||
            cleanQuestionLower.includes(cleanQueryLower) ||
            cleanQueryLower.includes(cleanQuestionLower)) {
          // If the question is an exact match or very close, give it the highest score
          answer.score = 19.0; // 95% of max score (20)
          appLogger.info(`Exact match for question: "${cleanQuestion}", score: ${answer.score}`);
          foundMatch = true;
        }
        // Check if the search query appears in the question
        else if (cleanQuestionLower.includes(cleanQueryLower.substring(0, 20)) ||
                 cleanQueryLower.includes(cleanQuestionLower.substring(0, 20))) {
          // If the question contains the search query, give it a higher score
          answer.score = 18.0; // 90% of max score (20)
          appLogger.info(`High score match for question: "${cleanQuestion}", score: ${answer.score}`);
          foundMatch = true;
        }
      }

      // If no match by question, try matching by content
      if (!foundMatch) {
        Object.keys(searchScores).forEach(content => {
          if (answer.answer && answer.answer.includes(content.substring(0, 50))) {
            // Found a potential match, assign the score
            answer.score = searchScores[content];
            appLogger.info(`Assigned score ${answer.score} to answer: ${answer.question.substring(0, 50)}...`);
            foundMatch = true;
          }
        });
      }

      // For answers about health/medicine topics, boost the score based on domain relevance
      if (!foundMatch) {
        // Always log domain analysis for debugging
        appLogger.info(`Starting domain relevance analysis for query: "${question}"...`);

        // Check if the question is actually about diabetes/health or if it's mixing unrelated domains
        // We'll use a simple heuristic here, but this could be enhanced with an AI evaluation

        // Extract main topics from the question
        const questionWords = question.toLowerCase().split(/\s+/);

        // Define our core domain keywords covering medicine, health, medical law, psychology, and social welfare
        const domainKeywords = [
          // Medicine and health
          'health', 'medical', 'medicine', 'doctor', 'hospital', 'clinic', 'treatment', 'symptoms',
          'disease', 'condition', 'diagnosis', 'patient', 'healthcare', 'therapy', 'prescription',
          'medication', 'drug', 'vaccine', 'surgery', 'recovery', 'prevention', 'wellness', 'diet',
          'nutrition', 'exercise', 'fitness', 'disability', 'chronic', 'acute', 'emergency',

          // Medical conditions and specialties
          'diabetes', 'cancer', 'heart', 'cardiac', 'neurological', 'respiratory', 'gastrointestinal',
          'dermatology', 'orthopedic', 'pediatric', 'geriatric', 'obstetrics', 'gynecology', 'urology',
          'ophthalmology', 'dentistry', 'psychiatry', 'radiology', 'oncology', 'immunology', 'endocrinology',

          // Medical law
          'medical law', 'healthcare law', 'malpractice', 'informed consent', 'hipaa', 'privacy',
          'patient rights', 'medical ethics', 'bioethics', 'legal', 'regulation', 'compliance',
          'liability', 'negligence', 'insurance', 'coverage', 'claim', 'policy', 'benefits',

          // Psychology
          'psychology', 'mental health', 'therapy', 'counseling', 'psychiatry', 'depression',
          'anxiety', 'stress', 'trauma', 'disorder', 'behavioral', 'cognitive', 'emotional',
          'psychological', 'psychotherapy', 'psychologist', 'psychiatrist', 'therapist',

          // Social welfare
          'social welfare', 'social services', 'social work', 'social worker', 'community',
          'support', 'assistance', 'aid', 'benefit', 'program', 'housing', 'shelter', 'food',
          'nutrition', 'poverty', 'unemployment', 'disability', 'elder care', 'child welfare',
          'family services', 'rehabilitation', 'advocacy', 'resources', 'outreach'
        ];

        // Count domain-related words
        let domainWordCount = 0;
        let totalSignificantWords = 0;

        // Skip common stop words
        const stopWords = ['a', 'an', 'the', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'in', 'on', 'at', 'to', 'for', 'with', 'by', 'about', 'like', 'through', 'over', 'before', 'after', 'between', 'under', 'above', 'of', 'during', 'what', 'when', 'where', 'why', 'how', 'all', 'any', 'both', 'each', 'few', 'more', 'most', 'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very', 'can', 'will', 'just', 'should', 'now'];

        for (const word of questionWords) {
          // Skip stop words and very short words
          if (word.length <= 2 || stopWords.includes(word)) {
            continue;
          }

          totalSignificantWords++;

          // Check if this word is related to our domain
          if (domainKeywords.some(keyword => word.includes(keyword) || keyword.includes(word))) {
            domainWordCount++;
          }
        }

        // Calculate domain relevance score (0-1)
        const domainRelevance = totalSignificantWords > 0 ? domainWordCount / totalSignificantWords : 0;
        appLogger.info(`Domain word count: ${domainWordCount}, Total significant words: ${totalSignificantWords}`);

        // Check for mixed domains by looking for specific domain indicators
        const otherDomainIndicators = [
          // Tech domains
          { term: 'computer', weight: 0.8 },
          { term: 'software', weight: 0.8 },
          { term: 'hardware', weight: 0.8 },
          { term: 'quantum', weight: 0.9 },
          { term: 'algorithm', weight: 0.7 },
          { term: 'programming', weight: 0.8 },
          { term: 'artificial intelligence', weight: 0.8 },
          { term: 'machine learning', weight: 0.8 },

          // Other sciences
          { term: 'physics', weight: 0.8 },
          { term: 'chemistry', weight: 0.7 },
          { term: 'astronomy', weight: 0.9 },
          { term: 'space', weight: 0.6 },

          // Other domains
          { term: 'politics', weight: 0.8 },
          { term: 'economics', weight: 0.7 },
          { term: 'history', weight: 0.7 },
          { term: 'literature', weight: 0.7 },
          { term: 'philosophy', weight: 0.8 },
          { term: 'religion', weight: 0.8 }
        ];

        // Check for indicators of other domains
        let otherDomainScore = 0;
        for (const indicator of otherDomainIndicators) {
          if (question.toLowerCase().includes(indicator.term)) {
            otherDomainScore += indicator.weight;
            appLogger.info(`Query contains other domain indicator: ${indicator.term} (weight: ${indicator.weight})`);
          }
        }

        // Normalize other domain score (cap at 1)
        otherDomainScore = Math.min(otherDomainScore, 1);

        // Calculate final relevance score (0-1)
        // High when domain relevance is high and other domain score is low
        const relevanceScore = domainRelevance * (1 - otherDomainScore);

        appLogger.info(`Question domain analysis: domainRelevance=${domainRelevance.toFixed(2)}, otherDomainScore=${otherDomainScore.toFixed(2)}, finalRelevance=${relevanceScore.toFixed(2)}`);

        // If question has low relevance to our domain, assign a lower score
        if (relevanceScore < 0.3) {
          answer.score = 5.0; // 25% of max score - below threshold
          appLogger.info(`Limited boost for answer due to low domain relevance (${relevanceScore.toFixed(2)}): ${answer.question.substring(0, 50)}...`);
          return;
        }

        // If the answer is relevant to the query and the query is in our domain, boost the score
        if (answer.question.toLowerCase().includes('diabetes') ||
            answer.answer.toLowerCase().includes('diabetes') ||
            answer.question.toLowerCase().includes('health') ||
            answer.answer.toLowerCase().includes('health') ||
            answer.question.toLowerCase().includes('medical') ||
            answer.answer.toLowerCase().includes('medical') ||
            // Include tick-borne diseases like Lyme disease
            answer.question.toLowerCase().includes('lyme') ||
            answer.answer.toLowerCase().includes('lyme') ||
            answer.question.toLowerCase().includes('tick') ||
            answer.answer.toLowerCase().includes('tick')) {

        // Check if the question contains keywords like "symptoms", "treatment", etc.
        const queryKeywords = ['symptoms', 'treatment', 'cause', 'manage', 'diet', 'medication', 'insulin', 'blood sugar', 'lyme', 'tick', 'disease', 'infection', 'bite'];
        const answerKeywords = ['symptoms', 'treatment', 'cause', 'manage', 'diet', 'medication', 'insulin', 'blood sugar', 'lyme', 'tick', 'disease', 'infection', 'bite'];

        let queryHasKeyword = false;
        let answerHasKeyword = false;

        // Check if the query contains any of the keywords
        for (const keyword of queryKeywords) {
          if (question.toLowerCase().includes(keyword)) {
            queryHasKeyword = true;
            break;
          }
        }

        // Check if the answer contains any of the keywords
        for (const keyword of answerKeywords) {
          if (answer.question.toLowerCase().includes(keyword) ||
              answer.answer.toLowerCase().includes(keyword)) {
            answerHasKeyword = true;
            break;
          }
        }

        // If both query and answer have matching keywords, give a higher score
        if (queryHasKeyword && answerHasKeyword) {
          answer.score = 16.0; // 80% of max score
          appLogger.info(`High boosted score for keyword-matched diabetes answer: ${answer.question.substring(0, 50)}...`);
        } else {
          // Otherwise, give a moderate boost
          answer.score = 10.0; // 50% of max score
          appLogger.info(`Boosted score for diabetes-related answer: ${answer.question.substring(0, 50)}...`);
        }
      }
    }
    });

    // Check if we have any answers with confidence scores
    const filteredAnswers = parsedAnswers.filter((answer: any) => {
      // If confidence is explicitly provided, use it
      if (answer.confidence !== undefined) {
        const result = answer.confidence >= confidenceThreshold;
        appLogger.info(`Answer "${answer.question}" has confidence ${answer.confidence}, threshold ${confidenceThreshold}, included: ${result}`);
        return result;
      }
      // If score is provided, use it (normalize to 0-1 range if needed)
      if (answer.score !== undefined) {
        // For Azure search scores, they're typically between 0-20, so normalize to 0-1
        const normalizedScore = answer.score <= 1 ? answer.score : answer.score / 20;
        const result = normalizedScore >= confidenceThreshold;
        appLogger.info(`Answer "${answer.question}" has score ${answer.score}, normalized ${normalizedScore}, threshold ${confidenceThreshold}, included: ${result}`);
        return result;
      }
      // If no confidence metrics are available, include by default
      appLogger.info(`Answer "${answer.question}" has no confidence score, included by default`);
      return true;
    });

    // If no answers meet the confidence threshold, return the "no closely related" message
    if (filteredAnswers.length === 0) {
      appLogger.info(`No answers met the confidence threshold of ${confidenceThreshold}. Returning default message.`);
      return [
        {
          question: "No closely related questions or answers found",
          answer: "Please check back for an answer to your question later.",
        },
      ];
    }

    // Map the filtered answers to the expected format and update any old messages
    return filteredAnswers.map((answer: any) => {
      let updatedAnswer = answer.answer || "Answer not available";

      // Replace the old message with the new one if it matches
      if (updatedAnswer === "Please try rephrasing your question or ask something else.") {
        updatedAnswer = "Please check back for an answer to your question later.";
      }

      return {
        question: answer.question || "Question not available",
        answer: updatedAnswer,
      };
    });
  } catch (error) {
    appLogger.error("Failed to parse Azure response:", error);
    return [
      {
        question: "No closely related questions or answers found",
        answer: "Please check back for an answer to your question later.",
      },
    ];
  }
};

/**
 * Processes and answers user questions using Azure AI services with context from relevant documents.
 * Implements a RAG (Retrieval Augmented Generation) pattern to provide accurate, contextual responses.
 *
 * @param node - The node context for processing the question (type: DrupalNode)
 * @param session_id - Unique identifier for the current session
 * @param question - The user's question to be answered
 * @returns Promise<QuestionResponse> Object containing the answer and optional similar QA pairs
 *
 * @requires Environment Variables:
 *   - azBaseUrl: Azure base URL for AI services
 *   - azApiKey: Azure API key
 *   - azSearchEndpoint: Azure Cognitive Search endpoint
 *   - azSearchKey: Azure Cognitive Search key
 *   - azIndexName: Name of the primary search index
 *
 * @throws {Error} When Azure AI services fail to process the question
 * @throws {Error} When document retrieval fails
 */
const answerQuestions = async (
  node: DrupalNode,
  session_id: string,
  question: string
): Promise<QuestionResponse> => {
  const answerPrompt = prompts.answerQuestions.answerPrompt;

  // Create all promises for parallel execution
  const [docsResponse, gptResponse, pmaResponse] = await Promise.all([
    // Get answers from documents
    submitQuestionDocuments(
      question,
      answerPrompt,
      azBaseUrl,
      azApiKey,
      azSearchEndpoint,
      azSearchKey,
      azIndexName,
      azDeploymentName,
      "semantic",
      {}
    ),
    // Get GPT response
    submitQuestionGeneralGPT(
      question,
      answerPrompt,
      azBaseUrl,
      azApiKey,
      azDeploymentName
    ),
    // Get PMA response
    submitQuestionDocuments(
      question,
      answerPrompt,
      azBaseUrl,
      azApiKey,
      azSearchEndpoint,
      azSearchKey,
      azPMIndexName,
      azDeploymentName
    ),
  ]);

  // Ensure all responses are valid
  const dataDocs = ensureAzureResponse(docsResponse);
  const dataGPT = ensureAzureResponse(gptResponse);
  const dataPMA = ensureAzureResponse(pmaResponse);

  // Generate summary if all data is available
  let dataSummary: string | AzureResponse;
  if (dataDocs.answer && dataGPT.answer && dataPMA.answer) {
    const summaryPrompt = prompts.answerQuestions.summaryPrompt(
      question,
      dataDocs,
      dataGPT,
      dataPMA
    );

    const summaryResponse = await submitQuestionGeneralGPT(
      summaryPrompt,
      answerPrompt,
      azBaseUrl,
      azApiKey,
      azDeploymentName
    );
    dataSummary = ensureAzureResponse(summaryResponse);
  } else {
    dataSummary = {
      answer: "Unable to generate summary due to missing data",
      citations: [],
    };
  }

  return {
    dataDocs,
    dataGPT,
    dataPMA,
    dataSummary,
  };
};

/**
 * Queries Azure Cognitive Search using both semantic and vector search capabilities for RAG (Retrieval Augmented Generation).
 * Supports hybrid search combining traditional keyword-based search with vector similarity search.
 *
 * @param query - The search query string to find relevant documents
 * @param topK - Number of results to return (default: 3)
 * @param useVectorSearch - Whether to enable vector search using embeddings (default: true)
 *
 * @returns Promise<Array<any>> Array of search results, each containing:
 *   - id: Document identifier
 *   - score: Combined search score (reranker or standard score)
 *   - content: Document content
 *   - caption: Extractive caption from the document
 *   - highlights: Highlighted matches in content
 *   - vectorScore: Vector similarity score when vector search is enabled
 *
 * @requires Environment Variables:
 *   - AZURE_OPENAI_ENDPOINT: Azure OpenAI API endpoint
 *   - AZURE_OPENAI_KEY: Azure OpenAI API key
 *   - AZURE_EMBEDDING_DEPLOYMENT: Name of the embedding model deployment
 *   - azSearchEndpoint: Azure Cognitive Search endpoint
 *   - azSearchKey: Azure Cognitive Search API key
 *   - azIndexName: Name of the search index
 *
 * @throws {Error} When required Azure configurations are missing
 * @throws {Error} When embedding generation fails
 * @throws {Error} When search request fails
 */
const queryRAGInstance = async (
  query: string,
  topK: number = 3,
  useVectorSearch: boolean = true
): Promise<Array<any>> => {
  try {
    if (!azSearchEndpoint || !azSearchKey || !azIndexName) {
      throw new Error("Azure Cognitive Search configuration is missing");
    }

    const searchClient = `${azSearchEndpoint}/indexes/${azIndexName}/docs/search?api-version=2023-11-01`;

    // Generate vector embedding for the query
    const openaiEndpoint = process.env.AZURE_OPENAI_ENDPOINT;
    const openaiKey = process.env.AZURE_OPENAI_KEY;
    const embeddingDeployment = process.env.AZURE_EMBEDDING_DEPLOYMENT;

    if (
      useVectorSearch &&
      (!openaiEndpoint || !openaiKey || !embeddingDeployment)
    ) {
      throw new Error("Azure OpenAI configuration for embeddings is missing");
    }

    let vectorQuery;
    if (useVectorSearch) {
      // Generate embedding using Azure OpenAI
      if (!openaiKey) {
        throw new Error("Azure OpenAI API key is not configured");
      }

      const embeddingResponse = await fetch(
        `${openaiEndpoint}/openai/deployments/${embeddingDeployment}/embeddings?api-version=2023-05-15`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "api-key": openaiKey,
          },
          body: JSON.stringify({
            input: query,
          }),
        }
      );

      if (!embeddingResponse.ok) {
        throw new Error("Failed to generate embedding");
      }

      const embeddingData = await embeddingResponse.json();
      vectorQuery = embeddingData.data[0].embedding;
    }

    const searchBody: any = {
      search: query,
      top: topK,
      select: "id,content,embedding",
      queryType: "semantic",
      semanticConfiguration: "default",
      captions: "extractive",
      answers: "extractive",
      queryLanguage: "en-us",
      speller: "lexicon",
    };

    // Add vector search if enabled
    if (useVectorSearch && vectorQuery) {
      searchBody.vectors = [
        {
          value: vectorQuery,
          fields: ["embedding"],
          k: topK,
        },
      ];
      // Hybrid search configuration
      searchBody.vectorFields = ["embedding"];
      searchBody.select =
        "id,content,embedding,@search.score,@search.rerankerScore";
      searchBody.rerankerConfiguration = "default";
    }

    const response = await fetch(searchClient, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": azSearchKey,
      },
      body: JSON.stringify(searchBody),
    });

    if (!response.ok) {
      throw new Error(`Search request failed: ${response.statusText}`);
    }

    const searchResults = await response.json();

    // Transform results to a more usable format
    const formattedResults = searchResults.value.map((result: any) => ({
      id: result.id,
      score: useVectorSearch
        ? result["@search.rerankerScore"] || result["@search.score"]
        : result["@search.score"],
      content: result.content,
      caption: result["@search.captions"]?.[0]?.text || "",
      highlights: result["@search.highlights"]?.content || [],
      vectorScore: result["@search.vectorScore"],
    }));

    return formattedResults;
  } catch (error) {
    console.error("Error querying Azure Cognitive Search:", error);
    throw error;
  }
};

// Routes
app.get("/", (c) => {
  return c.render(`
    <h1>CentsBot API</h1>
    <h2></h2>
    <p>This API is used for CentsBot question Submissions and Answers.</p>
  `);
});

app.get("/hello/:name", (c) => {
  return c.render(`
    <h1>Hello ${c.req.param("name")}</h1>
    Hope you have a good day!
  `);
});

// app.post("/api/testhook", (c) => {
//   const body = c.req.json();
//   //console.log(body);
//   return {
//     status: "success",
//   };
// });

// Test endpoint for finding similar answers without Drupal integration
app.post("/api/test-similar", async (c) => {
  try {
    const body = await c.req.json();

    if (!body.question) {
      appLogger.warn("Invalid request body for test endpoint:", body);
      return c.json(
        {
          status: "error",
          message: "Missing required field: question",
        },
        400
      );
    }

    const question = body.question;
    const nid = body.nid || "test123";

    appLogger.info(`Processing test question: ${question}`);

    const similarAnswers = await findSimilarAnswers(
      {
        nid,
        field_enter_question: [{ value: question }],
      },
      question
    );

    return c.json({
      status: "success",
      similarAnswers,
    });
  } catch (error) {
    appLogger.error("Error in test endpoint:", error);
    return c.json(
      {
        status: "error",
        message: "Failed to find similar answers",
        error: error instanceof Error ? error.message : String(error),
      },
      500
    );
  }
});

// Test endpoint for directly calling OpenAI API
app.post("/api/test-openai", async (c) => {
  try {
    const body = await c.req.json();
    const question = body.question || "What is Azure OpenAI?";
    const systemPrompt = "You are a helpful assistant.";

    appLogger.info(`Testing OpenAI API with question: ${question}`);

    const response = await submitQuestionGeneralGPT(
      question,
      systemPrompt,
      azBaseUrl,
      azApiKey,
      "bmi-centsbot-pilot" // Use the original model
    );

    return c.json({
      status: "success",
      response,
    });
  } catch (error) {
    console.error("Error in test-openai endpoint:", error);
    return c.json(
      {
        status: "error",
        message: "An error occurred while processing your request",
      },
      500
    );
  }
});

app.post("/api/find-similar", async (c) => {
  try {
    const body = await c.req.json();

    if (
      !body.entity?.nid?.[0]?.value ||
      !body.entity?.field_enter_question?.[0]?.value
    ) {
      appLogger.warn("Invalid request body:", body);
      return c.json(
        {
          status: "error",
          message: "Missing required fields: nid or question",
        },
        400
      );
    }

    const nid = body.entity.nid[0].value;
    const question = body.entity.field_enter_question[0].value;

    appLogger.info(`Processing question for nid ${nid}: ${question}`);

    const similarAnswers = await findSimilarAnswers(
      {
        nid,
        field_enter_question: [{ value: question }],
      },
      question
    );

    try {
      const { Cookie, csrf_token, logout_token } = await loginDrupal(
        drupalUrl,
        uname,
        pword
      );
      let similar2Post;

      // Ensure we have valid similarAnswers before accessing them
      if (
        similarAnswers &&
        similarAnswers.length > 0 &&
        !similarAnswers[0].question.includes(
          "No closely related questions or answers found"
        )
      ) {
        // Create an array with available answers, up to 3
        similar2Post = [];

        // Always add the first answer if it exists
        if (similarAnswers[0]) {
          similar2Post.push({
            question: similarAnswers[0].question,
            answer: similarAnswers[0].answer,
          });
        }

        // Add second answer if it exists
        if (similarAnswers[1]) {
          similar2Post.push({
            question: similarAnswers[1].question,
            answer: similarAnswers[1].answer,
          });
        }

        // Add third answer if it exists
        if (similarAnswers[2]) {
          similar2Post.push({
            question: similarAnswers[2].question,
            answer: similarAnswers[2].answer,
          });
        }
      } else {
        // Default to a single "no results" answer
        similar2Post = [
          {
            question: similarAnswers && similarAnswers.length > 0 ?
              similarAnswers[0].question :
              "No closely related questions or answers found",
            answer: similarAnswers && similarAnswers.length > 0 ?
              similarAnswers[0].answer :
              "Please check back for an answer to your question later.",
          },
        ];
      }

      console.log("Post sent to Drupal: ", similar2Post);

      const data = await postSimilar2Drupal(drupalUrl, csrf_token, {
        nid,
        similarAnswers: similar2Post,
        Cookie,
      });

      const user = await logoutDrupal(drupalUrl, logout_token);

      return c.json({
        status: "success",
        nid: nid,
      });
    } catch (error) {
      appLogger.error("Error posting to Drupal:", error);
      return c.json(
        {
          status: "error",
          message: "Failed to post to Drupal",
        },
        500
      );
    }
  } catch (error) {
    appLogger.error("Error finding similar answers:", error);
    return c.json(
      {
        status: "error",
        message: "Failed to find similar answers",
      },
      500
    );
  }
});

app.post("/api/get-answers", async (c) => {
  try {
    const body = await c.req.json();

    if (!body.node || !body.session_id || !body.question) {
      appLogger.warn("Invalid request body:", body);
      return c.json(
        {
          status: "error",
          message: "Missing required fields: node, session_id, or question",
        },
        400
      );
    }

    let data = await answerQuestions(body.node, body.session_id, body.question);
    return c.json({
      node: body.node,
      session_id: body.session_id,
      question: body.question,
      answerDocs: data.dataDocs.answer,
      answerPMA: data.dataPMA.answer,
      answerGPT: data.dataGPT.answer,
      answerSummary:
        typeof data.dataSummary === "string"
          ? data.dataSummary
          : data.dataSummary.answer,
    });
  } catch (error) {
    appLogger.error("Error getting answers:", error);
    return c.json(
      {
        status: "error",
        message: "Failed to get answers",
      },
      500
    );
  }
});

console.log(`Server is running on port http://localhost:${port}`);

serve({
  fetch: app.fetch,
  port,
});
