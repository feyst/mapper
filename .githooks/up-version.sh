#!/usr/bin/env bash
set -euo pipefail

GREEN='\033[0;32m'
NC='\033[0m' # No Color

fromVersion=$(jq -r '.version' package.json)
packageJson=$(cat package.json)
jq '.version=(.version|split(".")|.[2]=(.[2]|tonumber)+1|join("."))' <<<$packageJson > package.json
git add package.json
toVersion=$(jq -r '.version' package.json)
echo -e "$GREEN""Updating version from '$fromVersion' to '$toVersion'$NC"
