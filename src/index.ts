/*
 * CentsBot API
 */
import { serve } from "@hono/node-server";
import { config } from "dotenv";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { endTime, setMetric, startTime, timing } from "hono/timing";
import {
  submitQuestionDocuments,
  submitQuestionGeneralGPT,
} from "./libraries/azureHelpers.js";
import {
  loginDrupal,
  logoutDrupal,
  post2Drupal,
  postSimilar2Drupal,
} from "./libraries/drupalHelpers.js";

// Load environment variables
config({ path: "/etc/gptbot/.env" });

// Constants
const answerPrompt = `
  *     answer question as a medical professional.
  *     If the question is not medical, health, legally, or psychologically related then inform the user that you can only answer questions in one of those topics.
  *     The answer should be readable at an 7th grade reading level.
  *     Explain any jargon or domain specific language that may need clarification.
  *     Avoid using chemical names and classifications that people may not know or understand.
  *     Please ensure that the response avoids technical jargon or domain-specific language and provides explanations or simplifications where necessary.
  *     Do not include drug classes, instead using brand and generic common names.
  *     Detect the language of the question and answer in that language.
  *     Blank out curses, foul language, and derogatory of offensive language in the answer at all times.
  *     If question is not in a recognizable language, display the message 'You have used an unsupported language. Please choose a different language to see if its supported.', in each of these languages: English, Spanish, French, Mandarin, Japanese, Korean, and Hindi.
`;

const drupalUrl = process.env.DRUPAL_BASE_URL;
const azBaseUrl = process.env.AZ_BASE_URL;
const azApiKey = process.env.AZ_API_KEY;
const azSearchUrl = process.env.AZ_SEARCH_URL;
const azSearchKey = process.env.AZ_SEARCH_KEY;
const azIndexName = process.env.AZ_INDEX_NAME;
const azPMIndexName = process.env.AZ_PM_INDEX_NAME;
const azAnswersIndexName = "vet";

const uname = process.env.DRUPAL_USERNAME;
const pword = process.env.DRUPAL_PASSWORD;

const app = new Hono();

app.use(timing());
app.use(logger());

// Functions

/**
 * Searches for similar questions and answers in the knowledge base using Azure Cognitive Search.
 * Uses AI to find and extract the most relevant QA pairs based on semantic similarity.
 *
 * @param node - The node context for the search (type: any)
 * @param question - The user's question to find similar matches for
 * @returns Promise<Array<{
 *   nid?: string,
 *   category?: string,
 *   question: string,
 *   answer: string
 * }>> Array of similar QA pairs, or a default "not found" message if no matches
 *
 * @requires Environment Variables:
 *   - azBaseUrl: Azure base URL
 *   - azApiKey: Azure API key
 *   - azSearchUrl: Azure Cognitive Search URL
 *   - azSearchKey: Azure Cognitive Search key
 *   - azAnswersIndexName: Name of the answers index
 *
 * @example
 * const similarQAs = await findSimilarAnswers(nodeContext, "What are the symptoms of diabetes?");
 * // Returns: [{nid: "123", category: "Health", question: "...", answer: "..."}]
 */
const findSimilarAnswers = async (node: any, question: string) => {
  const systemPrompt = `
  You are an AI assistant that helps people extract the top relevant question and answer that is similar to the question I enter.

  ### Output Format:
  Return a JSON  with an array with the 3 top items, each containing the fields nid, category, question, answer.

  If no closely related questions or answers are found, return the following JSON array:
  [
    {
      question: "Sorry, we didn’t find any similar questions:",
      answer: "Please check back later for your question to be answered on our Health Answers page."
    }
  ]

  ### Example Output
  [
    {
       nid: nid_1,
       category: category_1,
       question: question_1,
       answer: answer_1
    }
  ]
  `;

  const userPrompt = `
    Find the top 3 most relevant questions and answers similar to: '${question}'\nReturn it as a JSON Array with 3 json objects containing the 'question' and 'answer'. Do not use any markdown and just return the string. Only return questions and answers that are between the '---' and where there are 'question:' and 'answer:' pairs, with the appropriate attribute name.
    If no closely related questions or answers are found, return the following JSON array:
    [
      {
        question: "No closely related questions or answers found:",
        answer: "Please check back later for your submission to be answered on our Health Answers page."
      }
    ]

    All results must agree in subject and context.
  `;

  let similarAnswers = await submitQuestionDocuments(
    userPrompt,
    systemPrompt,
    azBaseUrl,
    azApiKey,
    azSearchUrl,
    azSearchKey,
    azAnswersIndexName
  );

  //console.log("similarAnswers:", similarAnswers.answer);

  const parsedSimilarAnswers = JSON.parse(similarAnswers.answer);
  return parsedSimilarAnswers;
};

/**
 * Processes and answers user questions using Azure AI services with context from relevant documents.
 * Implements a RAG (Retrieval Augmented Generation) pattern to provide accurate, contextual responses.
 *
 * @param node - The node context for processing the question (type: any)
 * @param session_id - Unique identifier for the current session
 * @param question - The user's question to be answered
 * @returns Promise<{
 *   answer: string,
 *   similar?: Array<{
 *     question: string,
 *     answer: string
 *   }>,
 *   documents?: Array<string>
 * }> Object containing the answer and optional similar QA pairs
 *
 * @requires Environment Variables:
 *   - azBaseUrl: Azure base URL for AI services
 *   - azApiKey: Azure API key
 *   - azSearchUrl: Azure Cognitive Search URL
 *   - azSearchKey: Azure Cognitive Search key
 *   - azIndexName: Name of the primary search index
 *
 * @throws {Error} When Azure AI services fail to process the question
 * @throws {Error} When document retrieval fails
 */
const answerQuestions = async (node: any, session_id: any, question: any) => {
  // get answers from Azure AI
  let summaryPrompt, dataSummary;
  let dataDocs = await submitQuestionDocuments(
    question,
    answerPrompt,
    azBaseUrl,
    azApiKey,
    azSearchUrl,
    azSearchKey,
    azIndexName
  );

  let dataPMA = await submitQuestionDocuments(
    question,
    answerPrompt,
    azBaseUrl,
    azApiKey,
    azSearchUrl,
    azSearchKey,
    azPMIndexName
  );

  let dataGPT = await submitQuestionGeneralGPT(
    question,
    answerPrompt,
    azBaseUrl,
    azApiKey
  );

  if (
    dataDocs.answer.match(
      "The requested information is not available in the retrieved data."
    ) == null ||
    dataDocs.answer.match(
      "retrieved documents do not provide a comprehensive answer"
    ) == null
  ) {
    summaryPrompt =
      "Combine the three answers to the question below into a concise, clear, and readable summary of the two answers: \n\n" +
      "Question: " +
      question +
      "\n\n" +
      "Answer 1: " +
      dataDocs.answer +
      "\n\n" +
      "Answer 2: " +
      dataGPT.answer +
      "\n\n" +
      "Answer 3: " +
      dataPMA.answer +
      "\n\n" +
      "The summary should be readable at an 7th grade reading level and explain any jargon or domain specific language that may need clarification.\n" +
      "Please ensure that the response avoids technical jargon or domain-specific language and provides explanations or simplifications where necessary.\n" +
      "If the summary contains any fringe research, homeopathic medicine, or medically untested information, it should be annotated as such in the summary.\n";

    dataSummary = await submitQuestionGeneralGPT(
      summaryPrompt,
      answerPrompt,
      azBaseUrl,
      azApiKey
    );
  } else {
    dataSummary = "No answer available.";
  }

  return {
    status: "success",
    node: node,
    session_id: session_id,
    question: question,
    dataDocs: dataDocs,
    dataPMA: dataPMA,
    dataGPT: dataGPT,
    dataSummary: dataSummary,
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
 *   - azSearchUrl: Azure Cognitive Search endpoint
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
    if (!azSearchUrl || !azSearchKey || !azIndexName) {
      throw new Error('Azure Cognitive Search configuration is missing');
    }

    const searchClient = `${azSearchUrl}/indexes/${azIndexName}/docs/search?api-version=2023-11-01`;

    // Generate vector embedding for the query
    const openaiEndpoint = process.env.AZURE_OPENAI_ENDPOINT;
    const openaiKey = process.env.AZURE_OPENAI_KEY;
    const embeddingDeployment = process.env.AZURE_EMBEDDING_DEPLOYMENT;

    if (useVectorSearch && (!openaiEndpoint || !openaiKey || !embeddingDeployment)) {
      throw new Error('Azure OpenAI configuration for embeddings is missing');
    }

    let vectorQuery;
    if (useVectorSearch) {
      // Generate embedding using Azure OpenAI
      const embeddingResponse = await fetch(
        `${openaiEndpoint}/openai/deployments/${embeddingDeployment}/embeddings?api-version=2023-05-15`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'api-key': openaiKey
          },
          body: JSON.stringify({
            input: query
          })
        }
      );

      if (!embeddingResponse.ok) {
        throw new Error('Failed to generate embedding');
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
      speller: "lexicon"
    };

    // Add vector search if enabled
    if (useVectorSearch && vectorQuery) {
      searchBody.vectors = [{
        value: vectorQuery,
        fields: ["embedding"],
        k: topK
      }];
      // Hybrid search configuration
      searchBody.vectorFields = ["embedding"];
      searchBody.select = "id,content,embedding,@search.score,@search.rerankerScore";
      searchBody.rerankerConfiguration = "default";
    }

    const response = await fetch(searchClient, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': azSearchKey
      },
      body: JSON.stringify(searchBody)
    });

    if (!response.ok) {
      throw new Error(`Search request failed: ${response.statusText}`);
    }

    const searchResults = await response.json();

    // Transform results to a more usable format
    const formattedResults = searchResults.value.map((result: any) => ({
      id: result.id,
      score: useVectorSearch ?
        (result['@search.rerankerScore'] || result['@search.score']) :
        result['@search.score'],
      content: result.content,
      caption: result['@search.captions']?.[0]?.text || '',
      highlights: result['@search.highlights']?.content || [],
      vectorScore: result['@search.vectorScore']
    }));

    return formattedResults;
  } catch (error) {
    console.error('Error querying Azure Cognitive Search:', error);
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

app.post("/api/find-similar", async (c) => {
  setMetric(c, "region", "us-east-1");
  startTime(c, "similar");
  const body = await c.req.json();
  let nid = body.entity.nid[0].value;
  let question = body.entity.field_enter_question[0].value;

  const similarAnswers = await findSimilarAnswers(nid, question);
  endTime(c, "similar");
  //console.log("Returns: ", similarAnswers[0].question);

  const { Cookie, csrf_token, logout_token } = await loginDrupal(
    drupalUrl,
    uname,
    pword
  );
  let similar2Post;

  if (
    !similarAnswers[0].question.includes(
      "No closely related questions or answers found"
    )
  ) {
    similar2Post = {
      "Cookie": Cookie,
      "field_similar_question_1": `
          ${similarAnswers[0].question}\n
          ${similarAnswers[0].answer}
        `,
      "field_similar_question_2": `
          ${similarAnswers[1].question}\n
          ${similarAnswers[1].answer}
        `,
      "field_similar_question_3": `
          ${similarAnswers[2].question}\n
          ${similarAnswers[2].answer}
        `,
    };
  } else {
    similar2Post = {
      "Cookie": Cookie,
      "field_no_similar_questions": `
          ${similarAnswers[0].question}\n
          ${similarAnswers[0].answer}
        `,
    };
  }

  console.log("Post sent to Drupal: ", similar2Post);

  const data = await postSimilar2Drupal(
    drupalUrl,
    csrf_token,
    nid,
    similar2Post
  );

  //console.log(data);
  const user = await logoutDrupal(drupalUrl, logout_token);

  return c.json({
    status: "success",
    nid: nid,
  });
});

app.post("/api/get-answers", async (c) => {
  const body = await c.req.json();
  setMetric(c, "region", "us-east-1");

  startTime(c, "gpt");
  let data = await answerQuestions(body.node, body.session_id, body.question);
  endTime(c, "gpt");
  //console.log(data);
  return c.json({
    node: body.node,
    session_id: body.session_id,
    question: body.question,
    answerDocs: data.dataDocs.answer,
    //citationDocs: data.dataDocs.citations,
    answerPMA: data.dataPMA.answer,
    answerGPT: data.dataGPT.answer,
    answerSummary: data.dataSummary.answer,
  });
});

const port = 3000;
console.log(`Server is running on port http://localhost:${port}`);

serve({
  fetch: app.fetch,
  port,
});
