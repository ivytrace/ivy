# Releases and CI

## Workflows (`.github/workflows/`)

| workflow | trigger | does |
|---|---|---|
| `ci.yml` | pull requests, pushes to branches other than `main`, and called by `release.yml` | `pnpm install --frozen-lockfile`, `pnpm -r typecheck`, `pnpm -r test` |
| `release.yml` | push to `main` in `ivytrace/ivy` only | CI, then builds `packages/api/Dockerfile` for `linux/amd64` + `linux/arm64` and pushes `ghcr.io/ivytrace/ivy-api:<sha>` and `:main`, then, optionally, triggers a downstream deploy (see below) |

- The image is the same one self-hosters can run (`image: ghcr.io/ivytrace/ivy-api:main` instead of `build:` in
  `deploy/docker-compose.yml`). It contains the API and the dashboard build.
- The image is pushed with the workflow's `GITHUB_TOKEN` (`packages: write`). No other secret is needed for it.
- Forks and pull requests can't publish or deploy: `release.yml` runs only on `push` to `main`, every job is
  guarded by `github.repository == 'ivytrace/ivy'`, and pull request workflows from forks don't receive secrets.
  `HOSTED_DISPATCH_TOKEN` is only referenced in the `dispatch-hosted` job of `release.yml`.
- Downstream deploy trigger: with the `HOSTED_DISPATCH_TOKEN` repository secret set, the `dispatch-hosted` job sends a
  `repository_dispatch` (`ivy-main-updated`, payload `{"sha": "<sha>"}`) so a deployment repository can roll out the
  new image. Without the secret the job logs a warning and succeeds, so the image still publishes. The token only
  needs permission to trigger workflows in the receiving repository (fine-grained, **Contents: Read and write** on
  that one repository).
- Each architecture builds on its own native runner (`ubuntu-24.04` and `ubuntu-24.04-arm`, free for public
  repos) and is pushed by digest; the `image` job then joins both digests into the multi-arch `:<sha>` and `:main`
  tags. This replaced a QEMU build whose emulated arm64 half took over 10 minutes. Each architecture keeps its own
  GitHub Actions build cache.

## One-time setup

### Make the image public

The first push creates the `ivy-api` container package as **private** (GitHub's default; there is no API to change
it). After the first successful `release.yml` run:

1. Open https://github.com/orgs/ivytrace/packages/container/package/ivy-api → **Package settings**.
2. Under **Danger Zone** → **Change visibility** → **Public**, and type the package name to confirm. If the option
   is disabled, allow public packages first: organization **Settings** → **Packages** → **Package creation**,
   tick **Public**.
3. On the same settings page, under **Manage Actions access**, check that `ivytrace/ivy` is listed with the
   **Write** role (it is added automatically when the workflow creates the package).

Check: `docker manifest inspect ghcr.io/ivytrace/ivy-api:main` works without `docker login`.
