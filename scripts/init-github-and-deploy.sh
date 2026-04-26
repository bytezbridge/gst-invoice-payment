#!/usr/bin/env bash
# One-shot script to push payment server to GitHub.
# Run from inside the payment/ folder.
#
# Prereqs:
#   - You have a GitHub account + an EMPTY private repo named gst-invoice-payment
#   - You're logged into git (git config --global user.email + user.name set)
#
# Usage:
#   chmod +x scripts/init-github-and-deploy.sh
#   ./scripts/init-github-and-deploy.sh YOUR_GITHUB_USERNAME

set -euo pipefail

if [ -z "${1:-}" ]; then
  echo "❌ Usage: $0 YOUR_GITHUB_USERNAME"
  exit 1
fi

GITHUB_USER="$1"
REPO_NAME="gst-invoice-payment"

echo "🔧 Initialising git repo..."
if [ ! -d .git ]; then
  git init
  git branch -m main
fi

echo "🔍 Verifying .gitignore excludes secrets..."
if ! grep -q "^.env$" .gitignore 2>/dev/null; then
  echo ".env" >> .gitignore
fi
if ! grep -q "^node_modules" .gitignore 2>/dev/null; then
  echo "node_modules/" >> .gitignore
fi

# Belt-and-suspenders: error out if .env is somehow staged
if git ls-files --error-unmatch .env 2>/dev/null; then
  echo "❌ FATAL: .env is tracked by git. Aborting to protect secrets."
  echo "   Run: git rm --cached .env"
  exit 1
fi

echo "📦 Staging files..."
git add .

echo "💾 Committing..."
git commit -m "Deploy GST Invoice payment server v1.0.0" || echo "Nothing to commit."

echo "🌐 Setting remote..."
git remote remove origin 2>/dev/null || true

# Try SSH first, fall back to HTTPS if SSH key not configured
if ssh -T -o BatchMode=yes -o StrictHostKeyChecking=accept-new git@github.com 2>&1 | grep -q "successfully authenticated"; then
  REMOTE_URL="git@github.com:${GITHUB_USER}/${REPO_NAME}.git"
  echo "✅ SSH auth working — using SSH remote"
else
  REMOTE_URL="https://github.com/${GITHUB_USER}/${REPO_NAME}.git"
  echo "ℹ️  SSH not configured — using HTTPS remote (you'll be prompted for GitHub credentials / PAT)"
fi
git remote add origin "$REMOTE_URL"

echo "🚀 Pushing..."
git push -u origin main

echo ""
echo "✅ Done. Next steps:"
echo "   1. Open https://railway.app/new"
echo "   2. Click 'Deploy from GitHub repo'"
echo "   3. Select '${GITHUB_USER}/${REPO_NAME}'"
echo "   4. Add env vars from your phone Notes app"
echo "   5. Wait ~90 seconds for the build"
echo "   6. Copy the public URL — that's your live API"
