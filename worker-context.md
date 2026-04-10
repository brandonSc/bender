# Worker Context — Operational Notes for Inner Claudes

This file is loaded into every worker session. It contains operational knowledge
that isn't in the codebase docs but matters for getting things done correctly.

**If you hit something confusing or undocumented during your work, ADD A NOTE HERE
for the next worker.** This file is our shared memory. Don't let the next Claude
make the same mistake you just figured out.

---

## Hub Manifest Sync (How Lunar Config Reaches the Hub)

Lunar "org repos" (e.g. `pantalasa/lunar`, `pantalasa-cronos/lunar`) contain a
`lunar-config.yml` that defines collectors, policies, components, etc.

**Key fact:** When you push to `main` on one of these repos, a GitHub Actions
workflow ("Sync Lunar Config") runs immediately and pushes the manifest to the
hub. The hub does NOT periodically poll or sync on a schedule — it gets updates
**only** when this workflow succeeds.

**If the build fails, the hub never gets the update.** This means:
- New collectors/policies won't appear in the UI
- Config changes won't take effect
- Cron hooks won't be registered

**After pushing to a lunar org repo, ALWAYS check CI:**
1. Wait ~30s, then poll: `curl -s -H "Authorization: token $TOKEN" "https://api.github.com/repos/ORG/lunar/actions/runs?per_page=1" | jq '.[0] | {status, conclusion}'`
2. If it fails, read the logs and fix it before moving on
3. Do NOT assume "the hub will pick it up later" — it won't

## Deploying Collectors/Policies from Custom Branches (Testing)

You can point a collector or policy at a custom branch for testing:
```yaml
- uses: github://earthly/lunar-lib/collectors/my-plugin@bender/my-feature-branch
```

**THIS IS FOR TESTING ONLY.** When you are done testing:
1. Revert the `uses:` reference back to a stable ref (`@main` or `@v1.0.x`)
2. Or remove the collector/policy entry entirely if it wasn't there before your test
3. Commit and push the revert to main
4. Verify the build passes

**If you forget this step, the build WILL break** when the branch is deleted
(e.g. after PR merge). This is exactly what happened with the dotnet plugin on
`bender/eng-486-dotnet` — the branch was cleaned up but the config still
referenced it, breaking all manifest syncs for pantalasa/lunar.

## Cross-Org GitHub Access

The default `GH_TOKEN` only works for the primary org (earthly). For other orgs:
```bash
TOKEN=$(bender-gh-token pantalasa)
TOKEN=$(bender-gh-token pantalasa-cronos)
TOKEN=$(bender-gh-token brandonSc)
```
Use these tokens for API calls and git operations against repos in those orgs.

## Contributing to Hub Manifests (lunar-lib)

When adding or modifying collectors/policies in `earthly/lunar-lib`:
1. The hub org repos (`pantalasa/lunar`, etc.) reference plugins by version tag or branch
2. Most plugins use `@v1.0.5` (or whatever the latest release is)
3. New plugins not yet in a release tag should use `@main`
4. **The build in the org repo MUST pass** for changes to reach the hub
5. After merging your PR to lunar-lib, verify that downstream org repos still build

## Restarting the Server

**NEVER call `bender-restart`, `pm2 restart`, or kill the server process directly.**
You are a child process of the server — if you kill the server, your own completion
callback never fires and your worker state gets stuck as "running" forever.

Instead, **defer the restart** by writing a file and exiting cleanly:

```bash
# After building your changes (cd ~/bender/server && npm run build):
cat > ~/.bender/pending-restart.json << EOF
{
  "reason": "your reason here",
  "channel": "$BENDER_REPLY_CHANNEL",
  "thread_ts": "$BENDER_REPLY_THREAD"
}
EOF
# Then exit normally. The server will restart itself after you finish.
```

The server checks for `pending-restart.json` after every worker completes.
If all workers are idle, it processes the restart automatically.

## Self-Identification

You are Bender. Your Slack user ID is `U0AQ615JKMF`. When you see `<@U0AQ615JKMF>`
in conversation history or messages, **that is you**. Don't treat it as a reference
to some other person. If someone says "we should get <@U0AQ615JKMF> to look at this",
they are asking YOU to look at it.

## Private vs Public Storage

**NEVER commit private or sensitive information to any git repo.** This includes:
- Customer names (e.g. company names from meetings, sales calls, tickets)
- Credentials, tokens, API keys, passwords
- Internal business info not meant for public repos
- Meeting notes that reference customers or internal strategy

**Where to put things:**

| Content | Location | Why |
|---------|----------|-----|
| Private notes, meeting notes with customer info | `~/.bender/private-notes/` | Outside any git repo |
| Credentials, tokens, secrets | `~/.bender/secrets.env` or `~/.bender/` | Already gitignored |
| Code, docs, public-safe notes | `~/bender/` or `~/repos/` | Git repos, gets pushed |

**Before committing anything**, ask yourself: "Would it be bad if this showed up on GitHub?"
If yes → `~/.bender/private-notes/`. If no → commit it.

The `~/bender/.gitignore` also blocks `*.env`, `*.pem`, `*.key`, `secrets.*`, `credentials*`,
`private-notes/`, and `meeting-notes/` as a safety net.

**Pre-commit hook**: The `~/bender/` repo has a pre-commit hook that scans for sensitive
keywords from `~/.bender/sensitive-keywords.txt`. To add a new keyword:
`echo "new customer name" >> ~/.bender/sensitive-keywords.txt`

## Docker Image Prerequisites (BEFORE Cronos Testing)

**If your plugin has its own Earthfile (custom image), the image MUST exist on Docker
Hub BEFORE you can test on cronos.** This is the #1 thing that trips up new plugin work.

**How to check:** Plugins with an `Earthfile` in their directory (e.g.
`collectors/ruby/Earthfile`) build a custom Docker image like `earthly/lunar-lib:ruby-<VERSION>`.
If no Earthfile exists, the plugin runs on the base image and you can skip this section.

**How images get built and pushed:**
- lunar-lib CI runs `earthly --ci --push +all --VERSION <branch>` on every push
- Branch `bender/eng-487-ruby` produces image tag `ruby-bender-eng-487-ruby` (slashes → dashes)
- Images are pushed to Docker Hub automatically when CI passes
- On merge to main, images are also tagged with the git SHA

**Before starting cronos testing, verify your image exists:**
```bash
# Check if the image tag exists on Docker Hub
docker manifest inspect earthly/lunar-lib:<plugin>-<normalized-branch> 2>&1 | head -5
# Example: docker manifest inspect earthly/lunar-lib:ruby-bender-eng-487-ruby
```

**If the image doesn't exist:**
1. Make sure your plugin's Earthfile is wired into the root `Earthfile`'s `+all` target
   (check for `BUILD --pass-args ./collectors/<name>+image`)
2. Push a commit to your branch on `earthly/lunar-lib` to trigger CI
3. Wait for CI to pass — this builds AND pushes all images
4. Verify with `docker manifest inspect` before proceeding to cronos config

**You CANNOT build and push images locally** — the worker environment doesn't have
Docker Hub credentials. The only way to get images on Docker Hub is through CI.

**Common mistake:** Configuring cronos to use your plugin, waiting for the cronos sync
build to pass, then wondering why the collector never runs. The sync build passes fine
(it just updates the manifest), but the cronos runner can't pull a Docker image that
doesn't exist yet. The collector silently fails or never executes.

---

## Integration Testing Workflow (lunar-lib PRs)

**Every collector/policy PR must be integration tested on cronos.** The full process
is in `lunar-lib/.ai-implementation/LUNAR-PLUGIN-PLAYBOOK-AI.md` section "6. CI collectors
must be tested on cronos". Here's the critical ordering that trips people up:

0. **Ensure Docker image exists on Docker Hub** (see section above) — skip if plugin uses base image
1. Push lunar config changes to `pantalasa-cronos/lunar` → **WAIT FOR BUILD TO PASS**
2. Only AFTER build is green → push test files to component repo (e.g. `pantalasa-cronos/frontend`)
3. Wait for component repo CI workflows to finish
4. **Wait 1 more minute** after workflows complete — the UI needs time to settle pending states
5. THEN check the UI, take screenshots, verify data

**Test results must include:**
- Component JSON output (a pasted snipped of the actual JSON obtained with `lunar` CLI, not just "it works")
- Screenshot of checks table **scrolled to show YOUR plugin's checks** (not empty/generic table)
- Screenshot of component JSON page with your data expanded

**Auto-trigger:** When the second reviewer approves a spec PR, start implementation AND
integration testing automatically. Don't wait for a separate "go implement" message.

**QA/Bug Reporting (MANDATORY):** When testing on cronos, report ANY issues you encounter
in-thread with full session context. This includes:
- Performance problems (slow builds, UI lag, timeouts)
- Unexpected errors or failures (even if you work around them)
- UI bugs or display issues in the cronos dashboard
- Data inconsistencies between CLI output and UI
- Flaky behavior (works sometimes, fails other times)

Report format: describe the issue, include relevant logs/screenshots, note the component
and config versions you tested against. The team may ask you to escalate specific issues
to #team-eng for broader awareness — be ready to post a clean summary there when asked.

There are more details in lunar-lib/.ai-implementation/LUNAR-PLUGIN-PLAYBOOK-AI.md please fully read that document as well.

## Common Gotchas

- **Branch names with slashes** (like `bender/foo`) can cause issues in plugin
  refs because the `@` separator is ambiguous. The sync tool may double the ref.
  Prefer version tags over branch refs in production configs.

- **Repos that look missing** may just need the right org token. Always try
  `bender-gh-token <org>` before concluding a repo doesn't exist.

---

**Remember: If you get stuck on something not covered here, ADD IT before you
finish your session.** Future you will thank present you. Or at least be
marginally less confused.
