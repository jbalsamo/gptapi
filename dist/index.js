/*
 * CentsBot API
 */
import { serve } from "@hono/node-server";
import { config } from "dotenv";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { appConfig } from "./config/config";
import { prompts } from "./constants/prompts";
import { submitQuestionDocuments, submitQuestionGeneralGPT, } from "./libraries/azureHelpers";
import { loginDrupal, logoutDrupal, postSimilar2Drupal, } from "./libraries/drupalHelpers";
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
// Helper function to ensure Azure response has required fields
function ensureAzureResponse(response) {
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
    return c.json({
        status: "error",
        message: process.env.NODE_ENV === "production"
            ? "Internal server error"
            : err.message,
    }, 500);
});
// Add not found handler
app.notFound((c) => {
    appLogger.warn(`Route not found: ${c.req.url}`);
    return c.json({
        status: "error",
        message: "Not found",
    }, 404);
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
        return c.json({
            status: "error",
            message: "Content-Type must be application/json",
        }, 400);
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
const findSimilarAnswers = async (node, question) => {
    // Environment variables are validated by config.ts
    const systemPrompt = prompts.findSimilarAnswers.systemPrompt;
    const userPrompt = prompts.findSimilarAnswers.userPrompt.replace("{question}", question);
    // Log what we're doing
    appLogger.info(`Finding similar answers for question: "${question}"`);
    // Send only the actual question to Azure search, not the prompt template
    const response = await submitQuestionDocuments(question, // Use the raw question for search
    systemPrompt, azBaseUrl, azApiKey, azSearchEndpoint, azSearchKey, azAnswersIndexName, azDeploymentName, "keyword", // Use keyword search instead of semantic search
    {
        top: 10 // Get top 10 results for better coverage
        // Don't specify select fields to let Azure return whatever fields are available
    });
    // Ensure we have a valid response
    const azureResponse = ensureAzureResponse(response);
    try {
        // Check if the answer looks like an error message
        if (typeof azureResponse.answer === "string" &&
            (azureResponse.answer.includes("Cannot read properties") ||
                azureResponse.answer.startsWith("Error:") ||
                azureResponse.answer.includes("error"))) {
            appLogger.warn("Azure response contains an error message:", azureResponse.answer);
            return [
                {
                    question: "No closely related questions or answers found",
                    answer: "Please try rephrasing your question or ask something else.",
                },
            ];
        }
        // Try to parse the answer string into an array of SimilarAnswer
        let parsedAnswers;
        try {
            parsedAnswers = JSON.parse(azureResponse.answer);
        }
        catch (parseError) {
            appLogger.error("Failed to parse Azure response as JSON:", azureResponse.answer);
            return [
                {
                    question: "No closely related questions or answers found",
                    answer: "Please try rephrasing your question or ask something else.",
                },
            ];
        }
        // Validate the parsed data is an array
        if (!Array.isArray(parsedAnswers)) {
            appLogger.warn("Azure response was not an array:", azureResponse.answer);
            return [
                {
                    question: "No closely related questions or answers found",
                    answer: "Please try rephrasing your question or ask something else.",
                },
            ];
        }
        // Ensure each answer has the required fields
        return parsedAnswers.map((answer) => ({
            question: answer.question || "Question not available",
            answer: answer.answer || "Answer not available",
        }));
    }
    catch (error) {
        appLogger.error("Failed to parse Azure response:", error);
        return [
            {
                question: "No closely related questions or answers found",
                answer: "Please try rephrasing your question or ask something else.",
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
const answerQuestions = async (node, session_id, question) => {
    const answerPrompt = prompts.answerQuestions.answerPrompt;
    // Create all promises for parallel execution
    const [docsResponse, gptResponse, pmaResponse] = await Promise.all([
        // Get answers from documents
        submitQuestionDocuments(question, answerPrompt, azBaseUrl, azApiKey, azSearchEndpoint, azSearchKey, azIndexName, azDeploymentName, "semantic", {}),
        // Get GPT response
        submitQuestionGeneralGPT(question, answerPrompt, azBaseUrl, azApiKey, azDeploymentName),
        // Get PMA response
        submitQuestionDocuments(question, answerPrompt, azBaseUrl, azApiKey, azSearchEndpoint, azSearchKey, azPMIndexName, azDeploymentName),
    ]);
    // Ensure all responses are valid
    const dataDocs = ensureAzureResponse(docsResponse);
    const dataGPT = ensureAzureResponse(gptResponse);
    const dataPMA = ensureAzureResponse(pmaResponse);
    // Generate summary if all data is available
    let dataSummary;
    if (dataDocs.answer && dataGPT.answer && dataPMA.answer) {
        const summaryPrompt = prompts.answerQuestions.summaryPrompt(question, dataDocs, dataGPT, dataPMA);
        const summaryResponse = await submitQuestionGeneralGPT(summaryPrompt, answerPrompt, azBaseUrl, azApiKey, azDeploymentName);
        dataSummary = ensureAzureResponse(summaryResponse);
    }
    else {
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
const queryRAGInstance = async (query, topK = 3, useVectorSearch = true) => {
    try {
        if (!azSearchEndpoint || !azSearchKey || !azIndexName) {
            throw new Error("Azure Cognitive Search configuration is missing");
        }
        const searchClient = `${azSearchEndpoint}/indexes/${azIndexName}/docs/search?api-version=2023-11-01`;
        // Generate vector embedding for the query
        const openaiEndpoint = process.env.AZURE_OPENAI_ENDPOINT;
        const openaiKey = process.env.AZURE_OPENAI_KEY;
        const embeddingDeployment = process.env.AZURE_EMBEDDING_DEPLOYMENT;
        if (useVectorSearch &&
            (!openaiEndpoint || !openaiKey || !embeddingDeployment)) {
            throw new Error("Azure OpenAI configuration for embeddings is missing");
        }
        let vectorQuery;
        if (useVectorSearch) {
            // Generate embedding using Azure OpenAI
            if (!openaiKey) {
                throw new Error("Azure OpenAI API key is not configured");
            }
            const embeddingResponse = await fetch(`${openaiEndpoint}/openai/deployments/${embeddingDeployment}/embeddings?api-version=2023-05-15`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "api-key": openaiKey,
                },
                body: JSON.stringify({
                    input: query,
                }),
            });
            if (!embeddingResponse.ok) {
                throw new Error("Failed to generate embedding");
            }
            const embeddingData = await embeddingResponse.json();
            vectorQuery = embeddingData.data[0].embedding;
        }
        const searchBody = {
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
        const formattedResults = searchResults.value.map((result) => ({
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
    }
    catch (error) {
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
            return c.json({
                status: "error",
                message: "Missing required field: question",
            }, 400);
        }
        const question = body.question;
        const nid = body.nid || "test123";
        appLogger.info(`Processing test question: ${question}`);
        const similarAnswers = await findSimilarAnswers({
            nid,
            field_enter_question: [{ value: question }],
        }, question);
        return c.json({
            status: "success",
            similarAnswers,
        });
    }
    catch (error) {
        appLogger.error("Error in test endpoint:", error);
        return c.json({
            status: "error",
            message: "Failed to find similar answers",
            error: error instanceof Error ? error.message : String(error),
        }, 500);
    }
});
// Test endpoint for directly calling OpenAI API
app.post("/api/test-openai", async (c) => {
    try {
        const body = await c.req.json();
        const question = body.question || "What is Azure OpenAI?";
        const systemPrompt = "You are a helpful assistant.";
        appLogger.info(`Testing OpenAI API with question: ${question}`);
        const response = await submitQuestionGeneralGPT(question, systemPrompt, azBaseUrl, azApiKey, "bmi-centsbot-pilot" // Use the original model
        );
        return c.json({
            status: "success",
            response,
        });
    }
    catch (error) {
        console.error("Error in test-openai endpoint:", error);
        return c.json({
            status: "error",
            message: "An error occurred while processing your request",
        }, 500);
    }
});
app.post("/api/find-similar", async (c) => {
    try {
        const body = await c.req.json();
        if (!body.entity?.nid?.[0]?.value ||
            !body.entity?.field_enter_question?.[0]?.value) {
            appLogger.warn("Invalid request body:", body);
            return c.json({
                status: "error",
                message: "Missing required fields: nid or question",
            }, 400);
        }
        const nid = body.entity.nid[0].value;
        const question = body.entity.field_enter_question[0].value;
        appLogger.info(`Processing question for nid ${nid}: ${question}`);
        const similarAnswers = await findSimilarAnswers({
            nid,
            field_enter_question: [{ value: question }],
        }, question);
        try {
            const { Cookie, csrf_token, logout_token } = await loginDrupal(drupalUrl, uname, pword);
            let similar2Post;
            if (!similarAnswers[0].question.includes("No closely related questions or answers found")) {
                similar2Post = [
                    {
                        question: similarAnswers[0].question,
                        answer: similarAnswers[0].answer,
                    },
                    {
                        question: similarAnswers[1].question,
                        answer: similarAnswers[1].answer,
                    },
                    {
                        question: similarAnswers[2].question,
                        answer: similarAnswers[2].answer,
                    },
                ];
            }
            else {
                similar2Post = [
                    {
                        question: similarAnswers[0].question,
                        answer: similarAnswers[0].answer,
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
        }
        catch (error) {
            appLogger.error("Error posting to Drupal:", error);
            return c.json({
                status: "error",
                message: "Failed to post to Drupal",
            }, 500);
        }
    }
    catch (error) {
        appLogger.error("Error finding similar answers:", error);
        return c.json({
            status: "error",
            message: "Failed to find similar answers",
        }, 500);
    }
});
app.post("/api/get-answers", async (c) => {
    try {
        const body = await c.req.json();
        if (!body.node || !body.session_id || !body.question) {
            appLogger.warn("Invalid request body:", body);
            return c.json({
                status: "error",
                message: "Missing required fields: node, session_id, or question",
            }, 400);
        }
        let data = await answerQuestions(body.node, body.session_id, body.question);
        return c.json({
            node: body.node,
            session_id: body.session_id,
            question: body.question,
            answerDocs: data.dataDocs.answer,
            answerPMA: data.dataPMA.answer,
            answerGPT: data.dataGPT.answer,
            answerSummary: typeof data.dataSummary === "string"
                ? data.dataSummary
                : data.dataSummary.answer,
        });
    }
    catch (error) {
        appLogger.error("Error getting answers:", error);
        return c.json({
            status: "error",
            message: "Failed to get answers",
        }, 500);
    }
});
console.log(`Server is running on port http://localhost:${port}`);
serve({
    fetch: app.fetch,
    port,
});
