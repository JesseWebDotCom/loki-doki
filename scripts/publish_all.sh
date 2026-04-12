#!/bin/bash
set -e

COMMIT_MSG="$1"
if [ -z "$COMMIT_MSG" ]; then
    read -r -p "Enter commit message: " COMMIT_MSG || true
    if [ -z "$COMMIT_MSG" ]; then
        echo "Error: Commit message cannot be empty."
        exit 1
    fi
fi

sync_repo() {
    local repo_dir="$1"
    echo "🚀 Syncing $repo_dir..."
    if [ ! -d "$repo_dir" ]; then
        echo "⚠️  Directory not found: $repo_dir (skipping)"
        return
    fi
    cd "$repo_dir"

    if [ -n "$(git status --porcelain)" ]; then
        git add .
        git commit -m "$COMMIT_MSG"
    else
        echo "⏭️  No new local changes to commit."
    fi
    
    # Pull any changes from GitHub first to avoid out-of-sync rejections
    if ! git pull --rebase origin main; then
        echo "⚠️ Merge conflict detected! Aborting rebase and forcing local version..."
        git rebase --abort || true
        git push --force origin main
        echo "✅ Sync finished for $repo_dir (force pushed)."
        echo ""
        return
    fi

    # Push everything (including previously committed but unpushed changes)
    if ! git push origin main; then
        echo "⚠️ Push rejected. Forcing local version..."
        git push --force origin main
    fi
    echo "✅ Sync finished for $repo_dir."
    echo ""
}

if [ -z "$TARGET_REPO" ] || [ "$TARGET_REPO" == "main" ]; then
    sync_repo "$HOME/Projects/loki-doki"
fi

echo "✅ All done! Changes have been commited and pushed."
