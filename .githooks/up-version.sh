#!/usr/bin/env bash
set -euo pipefail

GREEN='\033[0;32m'
NC='\033[0m' # No Color

fromVersion=$(jq -r '.version' package.json)
toVersion=$(jq -r '.version|split(".")|.[2]=(.[2]|tonumber)+1|join(".")' package.json)
npm version --no-git-tag-version -f "$toVersion"
git add package.json package-lock.json
echo -e "$GREEN""Updating version from '$fromVersion' to '$toVersion'$NC"
