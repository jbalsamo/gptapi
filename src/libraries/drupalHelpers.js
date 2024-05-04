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
    "Content-Type": "application/json"
  };

  let bodyContent = JSON.stringify({
    "name": uname,
    "pass": pword
  });

  let response = await fetch(logonUrl, {
    method: "POST",
    body: bodyContent,
    headers: headersList
  });

  const cookie = await response.headers.get("Set-Cookie");
  const data = await response.json();
  const ret = {
    "Cookie": cookie,
    ...data
  };
  return await ret;
};

/**
 * Retrieves a list of questions from the specified URL.
 *
 * @param {string} u - The base URL for retrieving the questions.
 * @param {string} csrf - The CSRF token for authentication.
 * @return {Promise<Array>} A promise that resolves to an array of question objects.
 */
export const getQuestions = async (u, csrf) => {
  let url = u + "export_questions?_format=json";

  let headersList = {
    Accept: "*/*",
    "Content-Type": "application/json",
    "X-CSRF-Token": csrf
  };

  let response = await fetch(url, {
    method: "GET",
    headers: headersList
  });

  const questions = await response.json();
  return questions;
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

  let headersList = {
    "Accept": "*/*",
    "X-CSRF-Token": csrf,
    "Cookie": result.Cookie,
    "Content-Type": "application/json"
  };
  let sources = "[";
  if (typeof result.citations !== "undefined" && result.citations.length > 0) {
    result.citations.forEach((source, i) => {
      // console.log(source.title, "\n", source.url);
      sources += `{ "uri": "${source.url}" , "title": "${source.filepath}" }`;
      i !== result.citations.length - 1 ? (sources += ", ") : (sources += "");
    });
    sources += "]";
    console.log(
      "🚀 ~ file: drupalHelpers.js:90 ~ post2Drupal ~ sources:",
      JSON.parse(sources)
    );
  } else {
    sources = "[]";
  }

  let dedupSources = deduplicateArray(JSON.parse(sources), "title");
  console.log(
    "🚀 ~ file: drupalHelpers.js:99 ~ post2Drupal ~ dedupSources:",
    dedupSources
  );

  let body = JSON.stringify({
    "field_answer": [
      {
        "value": result.answerGPT
      }
    ],
    "field_answer_from_documents": [
      {
        "value": result.answerDocs
      }
    ],
    "field_answer_from_pubmed": [
      {
        "value": result.answerPMA
      }
    ],
    "field_answer_summary": [
      {
        "value": result.answerSummary
      }
    ],
    "field_sources": dedupSources,
    "field_state": [
      {
        "value": "Under Review"
      }
    ],
    "type": [
      {
        "target_id": "question_page"
      }
    ]
  });

  let response = await fetch(url, {
    method: "PATCH",
    headers: headersList,
    body: body
  });

  let data = await response.json();
  // console.log(data);

  return await data;
};

/**
 * Logs out the user from Drupal.
 *
 * @param {string} u - The base URL of the Drupal site.
 * @param {string} lo_token - The logout token.
 * @return {Promise} A promise that resolves to the JSON response from the logout endpoint.
 */
export const logoutDrupal = async (u, lo_token) => {
  let url = u + "logout?_format=json&token=" + lo_token;
  let response = await fetch(url);
  let userInfo = await response.json();
  return await userInfo;
};
