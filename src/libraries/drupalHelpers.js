import logger from "../utils/logger.js";

/**
 * Deduplicates an array of objects based on a specified key.
 *
 * @param {Array} array - The array of objects to be deduplicated.
 * @param {string} key - The key to be used for deduplication.
 * @return {Array} - The deduplicated array.
 */
const deduplicateArray = (array, key) => {
  return array.filter(
    (item, index, self) => index === self.findIndex((t) => t[key] === item[key])
  );
};

/**
 * Logs in to Drupal using the provided URL.
 *
 * @param {string} u - The base URL of the Drupal instance.
 * @return {Promise<object>} - A Promise that resolves to the response data from the login request.
 */
export const loginDrupal = async (u, uname, pword) => {
  let logonUrl = u + "user/login?_format=json";

  let headersList = {
    "Accept": "*/*",
    "Content-Type": "application/json",
  };

  let bodyContent = JSON.stringify({
    "name": uname,
    "pass": pword,
  });

  let response = await fetch(logonUrl, {
    method: "POST",
    body: bodyContent,
    headers: headersList,
  });

  const cookie = await response.headers.get("Set-Cookie");
  const data = await response.json();
  const ret = {
    "Cookie": cookie,
    ...data,
  };
  logger.info("Logged in to Drupal");
  return await ret;
};

/**
 * Retrieves a list of submitted questions from the specified URL.
 *
 * @param {string} u - The base URL for retrieving the questions.
 * @param {string} csrf - The CSRF token for authentication.
 * @return {Promise<Array>} A promise that resolves to an array of question objects.
 */
export const getQuestions = async (u, csrf, cookies) => {
  let url = u + "export_questions?_format=json";

  let headersList = {
    Accept: "application/json",
    "Content-Type": "application/json",
    "Cookie": cookies,
    "X-CSRF-Token": csrf,
  };

  let response = await fetch(url, {
    method: "GET",
    headers: headersList,
  });

  const questions = await response.json();
  logger.info("Retrieved questions from Drupal");
  return questions;
};

/**
 * Retrieves a list of updated questions from the specified URL.
 *
 * @param {string} u - The base URL for retrieving the questions.
 * @param {string} csrf - The CSRF token for authentication.
 * @return {Promise<Array>} A promise that resolves to an array of question objects.
 */
export const getUpdates = async (u, csrf, cookies) => {
  let url = u + "export_updates?_format=json";

  let headersList = {
    Accept: "application/json",
    "Content-Type": "application/json",
    "Cookie": cookies,
    "X-CSRF-Token": csrf,
  };

  let response = await fetch(url, {
    method: "GET",
    headers: headersList,
  });

  const questions = await response.json();
  logger.info("Retrieved updates from Drupal");
  return questions;
};

/**
 * Retrieves a list of pending questions from the specified URL.
 *
 * @param {string} u - The base URL for retrieving the questions.
 * @param {string} csrf - The CSRF token for authentication.
 * @param {string} cookies - The session cookies for authentication.
 * @return {Promise<Array>} A promise that resolves to an array of question objects.
 */
export const getPendingQuestions = async (u, csrf, cookies) => {
  let url = u + "export_review?_format=json";

  let headersList = {
    Accept: "application/json",
    "Content-Type": "application/json",
    "Cookie": cookies,
    "X-CSRF-Token": csrf,
  };

  let response = await fetch(url, {
    method: "GET",
    headers: headersList,
  });

  const questions = await response.json();
  logger.info("Retrieved pending questions from Drupal");
  return Array.isArray(questions) ? questions : [];
};

/**
 * Updates a Drupal node with the provided information.
 *
 * @param {string} u - The base URL of the Drupal site.
 * @param {string} csrf - The CSRF token for authentication.
 * @param {object} result - The result object containing the information to update the node.
 * @return {Promise} A promise that resolves to the response from the server.
 */
export const post2Drupal = async (u, csrf, result) => {
  let url = u + `node/${result.nid}?_format=json`;

  logger.info(`Updating Drupal node ${result.nid}`);
  logger.debug(`Question Status: ${result.questionStatus}`);

  let headersList = {
    "Accept": "*/*",
    "X-CSRF-Token": csrf,
    "Cookie": result.Cookie,
    "Content-Type": "application/json",
  };

  // Format sources properly for Drupal
  let formattedSources = [];
  if (result.citations && result.citations.length > 0) {
    formattedSources = result.citations.map((source) => ({
      uri: source.url || "",
      title: source.filepath || "",
    }));
    formattedSources = deduplicateArray(formattedSources, "title");
  }

  let bodyContent = {
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
    let response = await fetch(url, {
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
 * Logs out the user from Drupal.
 *
 * @param {string} u - The base URL of the Drupal site.
 * @param {string} lo_token - The logout token.
 * @return {Promise} A promise that resolves to the JSON response from the logout endpoint.
 */
export const logoutDrupal = async (u, lo_token) => {
  logger.info("Logging out of Drupal");
  let url = u + "user/logout?_format=json&token=" + lo_token;
  let response = await fetch(url);
  let userInfo = await response.text();
  return await userInfo;
};
