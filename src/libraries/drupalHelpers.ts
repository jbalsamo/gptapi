import { appLogger as logger } from "../utils/logger";

interface DrupalLoginResponse {
  Cookie: string;
  csrf_token: string;
  current_user: {
    uid: number;
    roles: string[];
    name: string;
  };
  logout_token: string;
}

interface DrupalQuestion {
  nid: string;
  title: string;
  body: string;
  status: string;
  created: string;
  changed: string;
}

interface DrupalNodeUpdateResult {
  nid: string;
  answerGPT: string;
  questionStatus: string;
  answerDocs: string;
  answerPMA: string;
  answerSummary: string;
  citations: Array<{ url: string; filepath: string }>;
  Cookie: string;
}

/**
 * Deduplicates an array of objects based on a specified key.
 */
const deduplicateArray = <T>(array: T[], key: keyof T): T[] => {
  return array.filter(
    (item, index, self) => index === self.findIndex((t) => t[key] === item[key])
  );
};

/**
 * Logs in to Drupal using the provided URL.
 */
const loginDrupal = async (
  u: string,
  uname: string,
  pword: string
): Promise<DrupalLoginResponse> => {
  const logonUrl = u + "user/login?_format=json";

  const headersList = {
    "Accept": "*/*",
    "Content-Type": "application/json",
  };

  const bodyContent = JSON.stringify({
    "name": uname,
    "pass": pword,
  });

  const response = await fetch(logonUrl, {
    method: "POST",
    body: bodyContent,
    headers: headersList,
  });

  const cookie = response.headers.get("Set-Cookie");
  const data = await response.json();
  const ret = {
    "Cookie": cookie,
    ...data,
  };
  logger.info("Logged in to Drupal");
  return ret;
};

/**
 * Retrieves a list of submitted questions from the specified URL.
 */
const getQuestions = async (
  u: string,
  csrf: string,
  cookies: string
): Promise<Array<DrupalQuestion>> => {
  const url = u + "export_questions?_format=json";

  const headersList = {
    Accept: "application/json",
    "Content-Type": "application/json",
    "Cookie": cookies,
    "X-CSRF-Token": csrf,
  };

  const response = await fetch(url, {
    method: "GET",
    headers: headersList,
  });

  const questions = await response.json();
  logger.info("Retrieved questions from Drupal");
  return questions;
};

/**
 * Retrieves a list of updated questions from the specified URL.
 */
const getUpdates = async (
  u: string,
  csrf: string,
  cookies: string
): Promise<Array<DrupalQuestion>> => {
  const url = u + "export_updates?_format=json";

  const headersList = {
    Accept: "application/json",
    "Content-Type": "application/json",
    "Cookie": cookies,
    "X-CSRF-Token": csrf,
  };

  const response = await fetch(url, {
    method: "GET",
    headers: headersList,
  });

  const questions = await response.json();
  logger.info("Retrieved updates from Drupal");
  return questions;
};

/**
 * Retrieves a list of pending questions from the specified URL.
 */
const getPendingQuestions = async (
  u: string,
  csrf: string,
  cookies: string
): Promise<Array<DrupalQuestion>> => {
  const url = u + "export_review?_format=json";

  const headersList = {
    Accept: "application/json",
    "Content-Type": "application/json",
    "Cookie": cookies,
    "X-CSRF-Token": csrf,
  };

  const response = await fetch(url, {
    method: "GET",
    headers: headersList,
  });

  const questions = await response.json();
  logger.info("Retrieved pending questions from Drupal");
  return Array.isArray(questions) ? questions : [];
};

/**
 * Updates a Drupal node with the provided information.
 */
const post2Drupal = async (
  u: string,
  csrf: string,
  result: DrupalNodeUpdateResult
): Promise<any> => {
  const url = u + `node/${result.nid}?_format=json`;

  logger.info(`Updating Drupal node ${result.nid}`);
  logger.debug(`Question Status: ${result.questionStatus}`);

  const headersList = {
    "Accept": "*/*",
    "X-CSRF-Token": csrf,
    "Cookie": result.Cookie,
    "Content-Type": "application/json",
  };

  // Format sources properly for Drupal
  interface FormattedSource {
    uri: string;
    title: string;
  }

  let formattedSources: FormattedSource[] = [];
  if (result.citations && result.citations.length > 0) {
    formattedSources = result.citations.map((source) => ({
      uri: source.url || "",
      title: source.filepath || "",
    }));
    formattedSources = deduplicateArray(formattedSources, "title");
  }

  const bodyContent = {
    "field_answer": [
      {
        "value": result.answerGPT,
      },
    ],
    "field_state": [
      {
        "value": result.questionStatus,
      },
    ],
    "field_answer_from_documents": [
      {
        "value": result.answerDocs,
      },
    ],
    "field_answer_from_pubmed": [
      {
        "value": result.answerPMA,
      },
    ],
    "field_answer_summary": [
      {
        "value": result.answerSummary,
      },
    ],
    "field_sources": formattedSources,
    "type": [
      {
        "target_id": "question_page",
      },
    ],
  };

  logger.debug("Request body:", JSON.stringify(bodyContent, null, 2));

  try {
    const response = await fetch(url, {
      method: "PATCH",
      headers: headersList,
      body: JSON.stringify(bodyContent),
    });

    if (!response.ok) {
      logger.error("Error response from Drupal:");
      logger.error("Status:", response.status);
      logger.error("Status Text:", response.statusText);
      const errorBody = await response.text();
      logger.error("Error Body:", errorBody);
      throw new Error(
        `Drupal update failed: ${response.status} ${response.statusText}`
      );
    }

    const data = await response.json();
    logger.info("Drupal response:", JSON.stringify(data, null, 2));
    return data;
  } catch (error) {
    logger.error("Failed to update Drupal:", error);
    throw error;
  }
};

/**
 * Posts similar questions and answers to Drupal.
 */
const postSimilar2Drupal = async (
  u: string,
  csrf: string,
  result: {
    nid: string;
    similarAnswers: Array<{
      question: string;
      answer: string;
    }>;
    Cookie: string;
  }
): Promise<any> => {
  logger.debug(`Posting similar answers for node ${result.nid}`);

  const headersList = {
    "Accept": "*/*",
    "X-CSRF-Token": csrf,
    "Cookie": result.Cookie,
    "Content-Type": "application/json",
  };

  // Map similar answers to their respective fields in Drupal
  const bodyContent: Record<string, any> = {
    "type": [{ "target_id": "question_page" }]
  };

  // Add similar questions to their respective fields if available
  if (result.similarAnswers && result.similarAnswers.length > 0) {
    // Map up to 3 similar questions to their respective fields
    const fieldNames = ['field_similar_question_1', 'field_similar_question_2', 'field_similar_question_3'];
    
    result.similarAnswers.slice(0, 3).forEach((similar, index) => {
      if (index < fieldNames.length && similar.question && similar.answer) {
        // Format the content as Question: <question>\nAnswer: <answer>
        const formattedContent = `Question: ${similar.question}\nAnswer: ${similar.answer}`;
        
        bodyContent[fieldNames[index]] = [
          {
            "value": formattedContent,
            "format": "full_html"
          }
        ];
      }
    });
    
    // We don't need to set field_answer separately anymore
    // as each similar question field now includes both question and answer
  }

  try {
    // Log the full request details
    logger.debug(`Sending request to Drupal: ${u}node/${result.nid}?_format=json`);
    logger.debug(`Headers: ${JSON.stringify(headersList)}`);
    logger.debug(`Body: ${JSON.stringify(bodyContent)}`);

    const response = await fetch(`${u}node/${result.nid}?_format=json`, {
      method: "PATCH",
      headers: headersList,
      body: JSON.stringify(bodyContent),
    });

    // Log the full response
    const responseText = await response.text();
    logger.debug(`Response status: ${response.status}`);
    logger.debug(`Response headers: ${JSON.stringify(Object.fromEntries(response.headers.entries()))}`);
    logger.debug(`Response body: ${responseText}`);

    if (!response.ok) {
      throw new Error(`Failed to update similar answers: ${response.status} - ${responseText}`);
    }

    // Parse the response text as JSON if possible
    let data;
    try {
      data = JSON.parse(responseText);
    } catch (e: unknown) {
      const error = e as Error;
      logger.warn(`Could not parse response as JSON: ${error.message}`);
      data = { raw: responseText };
    }
    
    return data;
  } catch (error) {
    logger.error("Error in postSimilar2Drupal:", error);
    throw error;
  }
};

/**
 * Logs out the user from Drupal.
 */
const logoutDrupal = async (u: string, lo_token: string): Promise<any> => {
  logger.info("Logging out of Drupal");
  const url = u + "user/logout?_format=json&token=" + lo_token;
  const response = await fetch(url);
  const userInfo = await response.text();
  return await userInfo;
};

export {
  getPendingQuestions,
  getQuestions,
  getUpdates,
  loginDrupal,
  logoutDrupal,
  post2Drupal,
  postSimilar2Drupal,
};
