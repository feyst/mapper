#!/usr/bin/env bash
set -euo pipefail

GREEN='\033[0;32m'
NC='\033[0m' # No Color

commitMessage=$(cat "$1")

major=$(jq -r '.version | split(".")[0]' package.json)
minor=$(jq -r '.version | split(".")[1]' package.json)
patch=$(jq -r '.version | split(".")[2]' package.json)

fromVersion="$major.$minor.$patch"

if grep -q '#major' <<<$commitMessage; then
  major=$(($major + 1))
  minor=0
  patch=0
elif grep -q '#minor' <<<$commitMessage; then
  minor=$(($minor + 1))
  patch=0
else
  patch=$(($patch + 1))
fi

version="$major.$minor.$patch"

echo -e "$GREEN""Updating version from '$fromVersion' to '$version'$NC"

packageJson=$(cat package.json)

echo "$packageJson" | jq -r --arg version "$version" '.version=$version' > package.json

git add package.json
echo -e "$(git status)"
git commit --amend --no-edit --no-verify