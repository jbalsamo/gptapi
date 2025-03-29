#!/bin/bash

# Script to test Drupal API connectivity
# This script will:
# 1. Log in to Drupal to get a CSRF token and cookie
# 2. Read a node from Drupal
# 3. Log out from Drupal

# Source the .env file to get environment variables
set -a
source .env
set +a

# Set the node ID to read
NODE_ID=${1:-746}

echo "Testing Drupal API connectivity for node $NODE_ID"
echo "Drupal URL: $DRUPAL_BASE_URL"

# Step 1: Log in to Drupal
echo "Logging in to Drupal..."
FULL_RESPONSE=$(curl -i -s -X POST \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"$DRUPAL_USERNAME\",\"pass\":\"$DRUPAL_PASSWORD\"}" \
  "${DRUPAL_BASE_URL}user/login?_format=json")

echo "Full response with headers:"
echo "$FULL_RESPONSE"

# Extract the Set-Cookie header
COOKIE=$(echo "$FULL_RESPONSE" | grep -i '^Set-Cookie:' | cut -d':' -f2- | tr -d '\r')
echo "Cookie from response headers: $COOKIE"

# Extract the JSON response body
LOGIN_RESPONSE=$(echo "$FULL_RESPONSE" | awk 'BEGIN{flag=0} /^\{/{flag=1} flag{print}')

# Print the login response for debugging
echo "Login response: $LOGIN_RESPONSE"

# Extract CSRF token, cookie, and logout token using jq
if command -v jq &> /dev/null; then
  CSRF_TOKEN=$(echo $LOGIN_RESPONSE | jq -r '.csrf_token')
  LOGOUT_TOKEN=$(echo $LOGIN_RESPONSE | jq -r '.logout_token')
  
  # For cookie, we need to check if the response contains session_name and session_value
  if echo $LOGIN_RESPONSE | jq -e '.session_name' &> /dev/null; then
    SESSION_NAME=$(echo $LOGIN_RESPONSE | jq -r '.session_name')
    SESSION_VALUE=$(echo $LOGIN_RESPONSE | jq -r '.session_value')
    COOKIE="${SESSION_NAME}=${SESSION_VALUE};"
  else
    # If session_name is not in the response, we'll need to handle it differently
    echo "Warning: Could not find session_name in login response"
    # Use a default cookie name from the response if available
    COOKIE=""
  fi
else
  # Fallback to grep/sed if jq is not available
  CSRF_TOKEN=$(echo $LOGIN_RESPONSE | grep -o '"csrf_token":"[^"]*' | sed 's/"csrf_token":"//')
  LOGOUT_TOKEN=$(echo $LOGIN_RESPONSE | grep -o '"logout_token":"[^"]*' | sed 's/"logout_token":"//')
  COOKIE=""
  echo "Warning: jq not found, cookie extraction may not work correctly"
fi

# Only check for CSRF_TOKEN since we now have the cookie from the header
if [ -z "$CSRF_TOKEN" ]; then
  echo "Failed to log in to Drupal. Could not extract CSRF token."
  echo "Response: $LOGIN_RESPONSE"
  exit 1
fi

# Extract just the cookie name and value for use in subsequent requests
COOKIE_FOR_REQUESTS=$(echo "$COOKIE" | sed 's/;.*//')

echo "Successfully logged in to Drupal"
echo "CSRF Token: $CSRF_TOKEN"
echo "Cookie: $COOKIE"

# Step 2: Read the node
echo "Reading node $NODE_ID..."
NODE_RESPONSE=$(curl -s -X GET \
  -H "Accept: application/json" \
  -H "Cookie: $COOKIE_FOR_REQUESTS" \
  "${DRUPAL_BASE_URL}node/$NODE_ID?_format=json")

echo "Node response:"
echo $NODE_RESPONSE | jq .

# Step 3: Log out from Drupal
echo "Logging out from Drupal..."
LOGOUT_RESPONSE=$(curl -s -X GET \
  "${DRUPAL_BASE_URL}user/logout?_format=json&token=$LOGOUT_TOKEN")

echo "Logout response:"
echo $LOGOUT_RESPONSE

echo "Test completed"
