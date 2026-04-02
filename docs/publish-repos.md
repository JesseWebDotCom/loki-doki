# Repo Publish Commands

These commands are prepared for publication, but should not be run until explicitly approved.

## Core Repo: `loki-doki`

```bash
git remote add origin https://github.com/JesseWebDotCom/loki-doki.git
git fetch origin
git push --force origin main:main
```

This force-push replaces the existing remote code and history with the current local `main`.

## Characters Repo: `loki-doki-characters`

```bash
cd /Users/jessetorres/Projects/loki-doki-characters
git init
git branch -M main
git remote add origin https://github.com/JesseWebDotCom/loki-doki-characters.git
git add .
git commit -m "Initial character catalog"
git push -u origin main
```

## Skills Repo: `loki-doki-skills`

```bash
cd /Users/jessetorres/Projects/loki-doki-skills
git init
git branch -M main
git remote add origin https://github.com/JesseWebDotCom/loki-doki-skills.git
git add .
git commit -m "Initial skill catalog"
git push -u origin main
```
