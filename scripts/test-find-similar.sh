#!/bin/bash

# Script to test different temperature and similarity settings for find-similar API
# This script will:
# 1. Log in to Drupal to get a CSRF token and cookie
# 2. Call the find-similar API with different temperature settings
# 3. Compare the results

# Source the .env file to get environment variables
set -a
source .env
set +a

# Set the node ID to test with
NODE_ID=${1:-746}
TEST_QUESTION=${2:-"What are the symptoms of diabetes?"}

echo "Testing find-similar API with different settings for node $NODE_ID"
echo "Test question: $TEST_QUESTION"
echo "Drupal URL: $DRUPAL_BASE_URL"

# Step 1: Log in to Drupal
echo "Logging in to Drupal..."
FULL_RESPONSE=$(curl -i -s -X POST \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"$DRUPAL_USERNAME\",\"pass\":\"$DRUPAL_PASSWORD\"}" \
  "${DRUPAL_BASE_URL}user/login?_format=json")

# Extract the Set-Cookie header
COOKIE=$(echo "$FULL_RESPONSE" | grep -i '^Set-Cookie:' | cut -d':' -f2- | tr -d '\r')

# Extract the JSON response body
LOGIN_RESPONSE=$(echo "$FULL_RESPONSE" | awk 'BEGIN{flag=0} /^\{/{flag=1} flag{print}')

# Extract CSRF token, cookie, and logout token using jq
if command -v jq &> /dev/null; then
  CSRF_TOKEN=$(echo $LOGIN_RESPONSE | jq -r '.csrf_token')
  LOGOUT_TOKEN=$(echo $LOGIN_RESPONSE | jq -r '.logout_token')
  
  # For cookie, we need to check if the response contains session_name and session_value
  if echo $LOGIN_RESPONSE | jq -e '.session_name' &> /dev/null; then
    SESSION_NAME=$(echo $LOGIN_RESPONSE | jq -r '.session_name')
    SESSION_VALUE=$(echo $LOGIN_RESPONSE | jq -r '.session_value')
    COOKIE="${SESSION_NAME}=${SESSION_VALUE};"
  fi
else
  # Fallback to grep/sed if jq is not available
  CSRF_TOKEN=$(echo $LOGIN_RESPONSE | grep -o '"csrf_token":"[^"]*' | sed 's/"csrf_token":"//')
  LOGOUT_TOKEN=$(echo $LOGIN_RESPONSE | grep -o '"logout_token":"[^"]*' | sed 's/"logout_token":"//')
  echo "Warning: jq not found, cookie extraction may not work correctly"
fi

# Extract just the cookie name and value for use in subsequent requests
COOKIE_FOR_REQUESTS=$(echo "$COOKIE" | sed 's/;.*//')

echo "Successfully logged in to Drupal"
echo "CSRF Token: $CSRF_TOKEN"
echo "Cookie: $COOKIE_FOR_REQUESTS"

# Function to call find-similar API with a specific temperature
test_temperature() {
  local temp=$1
  local top_results=$2
  
  echo -e "\n\n========================================="
  echo "Testing with temperature: $temp, top results: $top_results"
  echo "========================================="
  
  # Temporarily modify the temperature in azureHelpers.ts
  sed -i.bak "s/temperature: [0-9]*\.[0-9]*/temperature: $temp/" src/libraries/azureHelpers.ts
  
  # Temporarily modify the top results in index.ts
  sed -i.bak "s/top: [0-9]*/top: $top_results/" src/index.ts
  
  # Call the find-similar API
  RESPONSE=$(curl -s -X POST \
    -H "Content-Type: application/json" \
    -H "Cookie: $COOKIE_FOR_REQUESTS" \
    -d "{\"entity\":{\"nid\":[{\"value\":\"$NODE_ID\"}],\"field_enter_question\":[{\"value\":\"$TEST_QUESTION\"}]}}" \
    "http://localhost:3000/api/find-similar")
  
  echo "Response:"
  echo $RESPONSE | jq .
  
  # Restore the original files
  mv src/libraries/azureHelpers.ts.bak src/libraries/azureHelpers.ts
  mv src/index.ts.bak src/index.ts
}

# Test different temperature settings
echo "Starting tests with different temperature and top results settings..."

# Test with different temperature values
test_temperature 0.1 10
test_temperature 0.2 10
test_temperature 0.3 10
test_temperature 0.4 10 # Current default

# Test with different top results values (keeping temperature at 0.2 which is often a good balance)
test_temperature 0.2 5
test_temperature 0.2 8
test_temperature 0.2 12
test_temperature 0.2 15

# Step 3: Log out from Drupal
echo -e "\nLogging out from Drupal..."
LOGOUT_RESPONSE=$(curl -s -X GET \
  "${DRUPAL_BASE_URL}user/logout?_format=json&token=$LOGOUT_TOKEN")

echo "Tests completed"
