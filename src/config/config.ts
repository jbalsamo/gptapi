import { config } from "dotenv";
import joi from "joi";

// Load environment variables
config(); // Load from .env in current directory
if (!process.env.AZ_SEARCH_ENDPOINT) {
  config({ path: "/etc/gptbot/.env" }); // Fallback to original location
}

// Environment variable validation schema
const envSchema = joi
  .object({
    DRUPAL_BASE_URL: joi.string().uri().required(),
    AZ_BASE_URL: joi.string().uri().required(),
    AZ_API_KEY: joi.string().required(),
    AZ_SEARCH_ENDPOINT: joi.string().uri().required(),
    AZ_SEARCH_KEY: joi.string().required(),
    AZ_INDEX_NAME: joi.string().required(),
    AZ_PM_VECTOR_INDEX_NAME: joi.string().required(),
    AZ_ANSWERS_INDEX_NAME: joi.string().required(),
    AZ_DEPLOYMENT_NAME: joi.string().required(),
    DRUPAL_USERNAME: joi.string().required(),
    DRUPAL_PASSWORD: joi.string().required(),
  })
  .unknown();

// Validate environment variables
const { error, value: envVars } = envSchema.validate(process.env);
if (error) {
  throw new Error(`Config validation error: ${error.message}`);
}

// Export validated config
export const appConfig = {
  drupal: {
    baseUrl: envVars.DRUPAL_BASE_URL,
    username: envVars.DRUPAL_USERNAME,
    password: envVars.DRUPAL_PASSWORD,
  },
  azure: {
    baseUrl: envVars.AZ_BASE_URL,
    apiKey: envVars.AZ_API_KEY,
    search: {
      endpoint: envVars.AZ_SEARCH_ENDPOINT,
      key: envVars.AZ_SEARCH_KEY,
      indexName: envVars.AZ_INDEX_NAME,
      pmVectorIndexName: envVars.AZ_PM_VECTOR_INDEX_NAME,
      answersIndexName: envVars.AZ_ANSWERS_INDEX_NAME,
    },
    deployment: {
      name: envVars.AZ_DEPLOYMENT_NAME,
    },
  },
};
