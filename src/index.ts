/*
 * CentsBot API
 */
import { serve } from "@hono/node-server";
import { config } from "dotenv";
import { Hono } from "hono";
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

// Functions
const findSimilarAnswers = async (node: any, question: string) => {
  const systemPrompt = `
  You are an AI assistant that helps people extract the top 2 relevant question and answer pairs that are similar to the question I enter.

  ### Output Format:
  Return a JSON  with an array with the 3 top items, each containing the fields nid, category, question, answer.

  ### Example Output
  [
    {
       nid: nid_1,
       category: category_1,
       question: question_1,
       answer: answer_1
    },
    {
       nid: nid_2,
       category: category_2,
       question: question_2,
       answer: answer_2
    }
  ]
  `;
  const userPrompt = `
    Find 3 most relevant questions and answers similar to: '${question}'\nReturn it as a JSON Array with 3 json objects containing the 'question' and 'answer'. Do not use any markdown and just return the string. Only return questions and answers that are between the '---' and where there are 'question:' and 'answer:' pairs, with the appropriate attribute name.
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

  const parsedSimilarAnswers = JSON.parse(similarAnswers.answer);
  return parsedSimilarAnswers;
};

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

app.post("/api/find-similar", async (c) => {
  setMetric(c, "region", "us-east-1");
  startTime(c, "similar");
  const body = await c.req.json();
  let nid = body.entity.nid[0].value;
  let question = body.entity.field_enter_question[0].value;

  const similarAnswers = await findSimilarAnswers(nid, question);
  endTime(c, "similar");
  // console.log(similarAnswers[0].question);

  const similar2Post = {
    "field_similar_question_1": `
      "question": ${similarAnswers[0].question}\n
      "answer": ${similarAnswers[0].answer}
    `,
    "field_similar_question_2": `
      "question": ${similarAnswers[1].question}\n
      "answer": ${similarAnswers[1].answer}
    `,
    "field_similar_question_3": `
      "question": ${similarAnswers[2].question}\n
      "answer": ${similarAnswers[2].answer}
    `,
  };

  // console.log(similar2Post);

  const { Cookie, csrf_token, logout_token } = await loginDrupal(
    drupalUrl,
    uname,
    pword
  );

  let data = await postSimilar2Drupal(drupalUrl, csrf_token, nid, similar2Post);
  // let data = { message: "Similar" };

  return c.json({
    status: "success",
    nid: nid,
    data: data,
  });
});

app.post("/api/get-answers", async (c) => {
  const body = await c.req.json();
  setMetric(c, "region", "us-east-1");

  startTime(c, "gpt");
  let data = await answerQuestions(body.node, body.session_id, body.question);
  endTime(c, "gpt");
  console.log(data);
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
