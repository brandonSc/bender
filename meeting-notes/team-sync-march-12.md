# Team Sync - March 12, 2026

Source: https://fathom.video/calls/597499822

## Attendees
- Brandon Schurman
- Vlad A. Ionescu
- Corey Larson
- Ignacio Del Valle Alles (Nacho)
- Mike Holly

## Key Updates

### Vlad - Sales / Capital One
- Two tracks with Capital One: OnePipeline (CI/CD team) and EPDP (governance/compliance)
- OnePipeline champion is leaving, but connected us to a director-level replacement
- EPDP first call went well: 4 directors on call, highly engaged, interested in shifting left with OPA in PRs
- EPDP also interested in AI agent dev loop verification (running Lunar checks when agent changes code)
- Discussing file-trigger type for collectors (react when specific file types change, useful for AI agent use case)
- Selected as finalist in AI DevTool pitch competition — 5 finalists, judges are execs from Okta etc.
- Meeting with People Inc (media publishing) tomorrow

### Brandon - Collectors / Bender
- Working on next 50 getting-started collectors for LunarLib growth roadmap
- Fired Devin AI — doesn't follow instructions, makes mistakes, not as good as Claude
- Built webhook-based autonomous agent (Bender) on EC2 to replace Devin
- Preparing demos for Capital One and People Inc

### Corey - Infrastructure / K8s
- Deployed and merged K8s cluster base (CoreDNS, AWS LB controller, cert management)
- Working on per-tenant configuration (~200 lines Terraform)
- Need to add podSpec to K8s operator — currently can't schedule snippet pods
- Need to fix ListBucket permissions (can list other tenants' snippet code — security issue, deferred)
- Wants separate test environment — will try local-dev branching

### Mike - Lunar Core
- Merged array-of-pen flag for lunar collect
- PR open for plugin mode (collector dev / policy dev point at a plugin directory directly)
- Needs non-bot reviewer for plugin mode PR
- Taking on cron collector implementation

### Nacho - Catalogers
- Rewrote all cataloger models (component-cron and component hooks weren't working correctly)
- New merging: property-level merge instead of unit-level overwrite; manifest ordering respected
- New UI: cataloger listing, per-component views, change history (only shows deltas)
- Large PR coming (50+ files) but mostly dashboard changes
- Need to verify lunar catalog and get-json honor LUNAR_COMPONENT_ID env var
- Question about rerun-catalogers flag — may need fine-grained flags by type

## Design Discussion: Collector Dependencies (after-json)

### Decision: JSON path-based dependencies
- Collectors can declare `after-json` hooks: trigger when a specific JSON path exists
- Collectors can declare `missing-json` hooks: trigger when a path is missing (generate data on demand)
- These are SEPARATE hook types (not combined)

### Execution model (Corey's proposal, adopted):
1. Run all regular collectors until everything is done
2. Evaluate after-json dependencies — run any that are now satisfied
3. Loop: check for new dependencies satisfied, run them
4. When no more after-json to resolve, run missing-json hooks
5. Check if missing-json created data that satisfies more after-json — loop again
6. When neither resolves anything new, done

### Rules:
- Same hook never re-triggers on same path (deduplicate)
- after-json and missing-json for same path are mutually exclusive
- No infinite loops — dedup prevents cycles

## Action Items
1. Add podSpec to K8s operator; deploy per-tenant GitHub Actions agents (Corey)
2. Review Mike's plugin mode PR (Brandon or Nacho)
3. Draft cron collector design — scheduling, delta merging, versioning (Mike)
4. Verify lunar catalog/get-json honor LUNAR_COMPONENT_ID (Nacho/Vlad)
5. Check rerun-catalogers flag; propose fine-grained flags by type (Nacho)
6. Create separate branch for K8s testing; use local-dev branching (Corey)
7. Remove manifest section from Home dashboard; keep link to Catalogers (Nacho)
8. Update dependency plan with JSON paths, phases, dedupe, after/missing (Brandon)
