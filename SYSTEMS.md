# Bender Automated Systems

All recurring background jobs and their configs. Check here before adding duplicates.

## Daily News Radar
- **Cron:** `13 9 * * 1-5` (9:13 UTC, weekdays)
- **Script:** `~/.bender/news/fetch-news.sh`
- **Log:** `~/.bender/news/cron.log`
- **What:** Fetches top articles from HN, Lobsters, dev.to, GitHub Trending, TechCrunch, ArXiv
- **Output:** `~/.bender/news/YYYY-MM-DD.md` (latest symlinked to `latest.md`), 14-day retention

## Daily News Pick
- **Cron:** `0 17 * * 1-5` (17:00 UTC / 10am PT, weekdays)
- **Script:** `~/.bender/news/post-favorite.sh` → `~/.bender/news/pick-and-post.py`
- **Log:** `~/.bender/news/post-cron.log`
- **What:** Uses Anthropic API to pick best article from today's radar, posts to #offtopic with Bender commentary
- **Channel:** C01BGR6QBRP (#offtopic)

## Daily PR Reminder
- **Cron:** `0 14 * * 1-5` (14:00 UTC / 7am PT, weekdays)
- **Script:** `~/.bender/scripts/pr-reminder.sh`
- **Log:** `~/.bender/logs/pr-reminder.log` (script), `~/.bender/logs/pr-reminder-cron.log` (cron)
- **What:** Scans `~/.bender/sessions/` for active lunar-lib PRs, checks GitHub for last human activity, sends Slack DM reminders if a PR has been quiet for 2+ days
- **Routing logic:**
  - `implementing`/`starting` phase → DM Brandon asking if Bender should resume
  - `spec_review`/`impl_review` phase → DM pending reviewers, or Brandon if no reviewer assigned
  - `merging` phase → DM Brandon that PR is ready to merge
  - `blocked` phase → DM Brandon asking if still stuck
- **Staleness threshold:** 2 days of no human activity (comments, reviews, pushes)
- **Scope:** lunar-lib PRs only (filters on `repo` field in session JSON)
