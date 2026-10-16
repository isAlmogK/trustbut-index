# trustbut-index

[![Sponsor](https://img.shields.io/badge/sponsor-%E2%99%A5-ea4aaa?logo=githubsponsors&logoColor=white)](https://github.com/sponsors/isAlmogK)

A pre-registered study of [trustbut](https://github.com/isAlmogK/trustbut) receipts on real pull requests written by AI coding agents, compared with human pull requests from the same projects. The method is frozen in [`PREREGISTRATION.md`](PREREGISTRATION.md), and the finished report is published to GitHub Pages from [`site/`](site/).

## How it works

```
collect  ->  run  ->  ingest  ->  aggregate  ->  label  ->  report
```

1. **collect** finds qualifying agent PRs and matched human PRs and writes `manifests/<name>.jsonl`.
2. **run** is an Actions matrix, one job per PR (250 per batch), running trustbut 0.6.0.
3. **ingest** validates the artifacts against the manifest and writes `results/<date>/`.
4. **aggregate** computes rates, coverage and intervals. For a pilot it also writes the by-hand checklist. Both run automatically after each batch's ingest.
5. **label** is blinded: Claude drafts the labels and a human confirms every one.
6. **report** builds `site/<date>/`.

## One-time setup

The maintainer does these. Nothing in this repo creates or handles the token.

1. Create a fine-grained personal access token with access to **public repositories only (read-only)** and no extra permissions: <https://github.com/settings/personal-access-tokens/new>
2. Store it as a repo secret (paste the token when prompted):
   `gh secret set INDEX_GH_TOKEN --repo isAlmogK/trustbut-index`
3. Enable Pages from Actions:
   `gh api -X POST repos/isAlmogK/trustbut-index/pages -f build_type=workflow`
4. For drafting labels locally: an Anthropic API key in `ANTHROPIC_API_KEY`, or `ant auth login`.

## Run the pilot

```
gh workflow run collect.yml --repo isAlmogK/trustbut-index -f pilot=true
```

Or open the Actions tab, pick "collect", and press "Run workflow". The workflow collects 20 PRs per agent as `manifests/pilot-<date>.jsonl`, commits it, and starts every run batch. When the batches finish, `results/pilot-<date>/pilot-check.md` and `results/pilot-<date>/aggregate.json` appear on `main`.

Then:

1. Open each PR in `pilot-check.md` and tick it if the PR page confirms that agent wrote it.
2. Fill the "Pilot check" column in `PREREGISTRATION.md` with confirmed/total per agent.
3. If coverage is low, fix the recipes or markers and run the pilot again.

Optional inputs: `-f until=YYYY-MM-DD` (last merge date, default today UTC), `-f days=N` (window length, default 90).

A failed collect run can be rerun. Every run saves its GitHub API cache, even when it fails or times out, so a rerun with the same `until` on the same UTC day resumes fully, because the repo list and the 365-day author window are computed by UTC day. A pilot collect takes about 1.5 hours and a full one about 3 to 3.5 hours. Rerun with the same `until`, because the stale and window checks use the current time, so a rerun on a different day can select a different manifest. Delete a partial `results/<name>/` only if you intend to start that collection over.

## Run the full study

Tag `prereg-v1` first, because the method is frozen at that tag:

```
git tag prereg-v1 && git push origin prereg-v1
gh workflow run collect.yml --repo isAlmogK/trustbut-index -f pilot=false -f exclude=manifests/pilot-<date>.jsonl
```

If the collect summary lists insufficient agents, rerun with `-f days=180`, as the pre-registration allows.

## Label and publish

These steps run locally. They spend API credit and need you. Pull `main` first so `results/<date>/` is present, and use the same `<date>` and `manifests/<date>.jsonl` throughout.

```
npx tsx src/cli.ts label sample --manifest manifests/<date>.jsonl --date <date>
GITHUB_TOKEN=$(gh auth token) npx tsx src/cli.ts label packets --manifest manifests/<date>.jsonl --date <date>
npx tsx src/cli.ts label draft submit --date <date>
npx tsx src/cli.ts label draft collect --date <date>
npm run review -- <date>
npx tsx src/cli.ts report --manifest manifests/<date>.jsonl --date <date>
```

Then commit and push `labels/` and `site/`. Pages deploys.

## Data layout

- `manifests/<name>.jsonl`: the selected PRs. `manifests/<name>.summary.json`: counts from collection (repos listed, search hits, PRs examined and selected per agent, human matches and shortfall).
- `results/<date>/`: per-PR run records and receipts, `aggregate.json`, and for a pilot `pilot-check.md`.
- `labels/<date>/`: the sample, packets, drafts and final labels.
- `site/<date>/`: the published report.

## Security model

- Per-PR jobs run untrusted code from the studied repos, with read-only access to this repo and no secrets.
- Only ingest writes results, and it never executes studied code.
- The token secret is read-only, and only the collect step uses it. That step runs this repo's own code.

## Development

```
npm ci
npm test
npm run typecheck
npx tsx src/cli.ts --help
```

## Opt-out

Maintainers can opt out by opening an issue; the repo is added to [`excluded-repos.txt`](excluded-repos.txt).

## Sponsor

The study runs on GitHub Actions and API credit, and I run it in my own time. If the results are useful to you, [sponsoring me on GitHub](https://github.com/sponsors/isAlmogK) helps keep it going.

## About me

I'm Almog Koren, a software engineer in Tallinn and the author of [trustbut](https://github.com/isAlmogK/trustbut). I founded and built [DogBase](https://www.dogbase.co), which won the main pitch competition at Latitude59 2026. I've been through Techstars twice, and I build AI agents and the systems around them. **I'm open to work:** full-time roles, fractional CTO work and AI agent projects. See [almog.io](https://almog.io).
