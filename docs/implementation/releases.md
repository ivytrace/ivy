# Releases and CI

## Workflows (`.github/workflows/`)

| workflow | trigger | does |
|---|---|---|
| `ci.yml` | pull requests, pushes to branches other than `main`, and called by `release.yml` | `pnpm install --frozen-lockfile`, `pnpm -r typecheck`, `pnpm -r test` |
| `release.yml` | push to `main` in `ivytrace/ivy` only | CI, then builds `packages/api/Dockerfile` for `linux/amd64` + `linux/arm64` and pushes `ghcr.io/ivytrace/ivy-api:<sha>` and `:main`, then sends a `repository_dispatch` (`ivy-main-updated`, payload `{"sha": "<sha>"}`) to `ivytrace/ivy-hosted` |

- The image is the same one self-hosters can run (`image: ghcr.io/ivytrace/ivy-api:main` instead of `build:` in
  `deploy/docker-compose.yml`). It contains the API and the dashboard build.
- The image is pushed with the workflow's `GITHUB_TOKEN` (`packages: write`). No other secret is needed for it.
- Forks and pull requests can't publish or deploy: `release.yml` runs only on `push` to `main`, every job is
  guarded by `github.repository == 'ivytrace/ivy'`, and pull request workflows from forks don't receive secrets.
  `HOSTED_DISPATCH_TOKEN` is only referenced in the `dispatch-hosted` job of `release.yml`.
- If `HOSTED_DISPATCH_TOKEN` is missing, the dispatch step logs a warning and succeeds, so the image still
  publishes.
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

### `HOSTED_DISPATCH_TOKEN`

A fine-grained personal access token that can only trigger workflows in `ivytrace/ivy-hosted`:

1. GitHub → your avatar → **Settings** → **Developer settings** → **Personal access tokens** →
   **Fine-grained tokens** → **Generate new token**.
2. **Token name**: `ivy hosted dispatch`. **Resource owner**: `ivytrace`. **Expiration**: the longest the
   organization allows (set a reminder to rotate it).
3. **Repository access**: **Only select repositories** → `ivytrace/ivy-hosted`.
4. **Permissions** → **Repository permissions** → **Contents**: **Read and write** (`Metadata: Read` is added
   automatically). Nothing else.
5. **Generate token** and copy it. If the organization requires approval for fine-grained tokens, approve it
   under organization **Settings** → **Personal access tokens** → **Pending requests**.
6. In `ivytrace/ivy` → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**:
   name `HOSTED_DISPATCH_TOKEN`, value the token.

A GitHub App installation token with the same single permission on the same single repository works too, and
does not expire with a person's account.
