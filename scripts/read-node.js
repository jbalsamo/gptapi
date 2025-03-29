// Script to read a node from Drupal
import { config } from 'dotenv';
import { appConfig } from '../dist/config/config.js';
import { loginDrupal, logoutDrupal } from '../dist/libraries/drupalHelpers.js';

// Load environment variables
config();

async function readNode(nodeId) {
  try {
    console.log(`Reading node ${nodeId} from Drupal...`);
    
    // Initialize Drupal connection
    const drupalUrl = appConfig.drupal.baseUrl;
    const uname = appConfig.drupal.username;
    const pword = appConfig.drupal.password;
    
    console.log(`Drupal URL: ${drupalUrl}`);
    
    // Login to Drupal
    const { Cookie, csrf_token, logout_token } = await loginDrupal(drupalUrl, uname, pword);
    console.log('Logged in to Drupal');
    
    // Read the node
    const url = `${drupalUrl}node/${nodeId}?_format=json`;
    console.log(`Fetching from URL: ${url}`);
    
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Cookie': Cookie,
      },
    });
    
    if (!response.ok) {
      console.error(`Failed to read node: ${response.status} ${response.statusText}`);
      const errorText = await response.text();
      console.error(`Error response: ${errorText}`);
      throw new Error(`Failed to read node: ${response.status}`);
    }
    
    const data = await response.json();
    console.log('Node data:', JSON.stringify(data, null, 2));
    
    // Logout from Drupal
    await logoutDrupal(drupalUrl, logout_token);
    console.log('Logged out from Drupal');
    
    return data;
  } catch (error) {
    console.error('Error reading node:', error);
    throw error;
  }
}

// Read node 746
const nodeId = process.argv[2] || '746';
readNode(nodeId)
  .then(() => console.log('Done'))
  .catch((error) => console.error('Script failed:', error));
