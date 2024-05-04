/**
 * Azure OpenAI Helpers
 * @module
 * @license MIT
 * @author Joseph Balsamo <https://github.com/josephbalsamo
 */

/**
 * Submits a general question to the BMI_pilotGPT chat completions API.
 *
 * @param {string} question - The question to be submitted.
 * @param {string} system - The system message to be included in the chat.
 * @param {string} base - The base URL of the API.
 * @return {Promise} A Promise that resolves to the server response.
 */
export const submitQuestionGeneralGPT = async (
  question,
  system,
  base,
  apiKey
) => {
  let errorMessage = "";
  let url =
    base +
    "openai/deployments/BMI_pilotGPT/chat/completions?api-version=2023-05-15";
  let headers = {
    "Content-Type": "application/json",
    "api-key": apiKey
  };
  let body = {
    messages: [
      {
        role: "system",
        content: system
      },
      {
        role: "user",
        content: question
      }
    ]
  };
  try {
    let response = await fetch(url, {
      method: "POST",
      headers: headers,
      body: JSON.stringify(body)
    });
    let data = await response.json();
    errorMessage = data.error || data;
    let returnValue = {
      "answer": data.choices[0].message.content
    };
    return returnValue;
  } catch (err) {
    let returnValue = {
      "code": errorMessage.code,
      "answer": errorMessage.message
    };
    return returnValue;
  }
};

/**
 * Submits question documents to the specified API endpoint and returns the response.
 *
 * @param {string} question - The question to be submitted.
 * @param {string} system - The system information.
 * @param {string} base - The base URL.
 * @param {string} apiKey - The API key.
 * @param {string} searchEndpoint - The search endpoint.
 * @param {string} searchKey - The search key.
 * @param {string} indexName - The index name.
 * @return {object} The response containing citations and the answer.
 */
export const submitQuestionDocuments = async (
  question,
  system,
  base,
  apiKey,
  searchEndpoint,
  searchKey,
  indexName
) => {
  let errorMessage = "";
  let url =
    base +
    "openai/deployments/BMI_pilotGPT/extensions/chat/completions?api-version=2023-07-01-preview";
  let headers = {
    "Content-Type": "application/json",
    "api-key": apiKey
  };
  let body = {
    "dataSources": [
      {
        "type": "AzureCognitiveSearch",
        "parameters": {
          "endpoint": searchEndpoint,
          "key": searchKey,
          "indexName": indexName
        }
      }
    ],
    messages: [
      {
        role: "system",
        content: system
      },
      {
        role: "user",
        content: question
      }
    ]
  };
  try {
    let response = await fetch(url, {
      method: "POST",
      headers: headers,
      body: JSON.stringify(body)
    });
    let data = await response.json();
    errorMessage = data.error || data;
    let returnValue = {
      citations: JSON.parse(data.choices[0].messages[0].content).citations,
      answer: data.choices[0].messages[1].content
    };
    // returnValue.citations.forEach((element) => {
    //   console.log(element.title, "\n", element.url, "\n\n");
    // });
    return returnValue;
  } catch (err) {
    let returnValue = {
      "code": errorMessage.code,
      "answer": errorMessage.message
    };
    return returnValue;
  }
};
