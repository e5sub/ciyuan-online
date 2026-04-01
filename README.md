# 次元乱斗Online

## Stack

- Frontend: `index.html`
- Backend: `server.js`
- Database: `MySQL 8`
- Container: `Docker`
- Image registry: `GHCR`

## Local Docker Deploy

1. Copy `.env.example` to `.env`
2. Adjust `DB_PASSWORD` and other env values if needed
3. Run:

```bash
docker compose up -d --build
```

4. Open:

```text
http://localhost:4000
```

## Stop

```bash
docker compose down
```

To remove database data too:

```bash
docker compose down -v
```

## GHCR Image Build

This repo includes GitHub Actions workflow:

- `.github/workflows/docker-publish.yml`

It will build and push image to:

```text
ghcr.io/<github-owner>/dimension-brawl
```

Triggers:

- push to `main`
- push tag like `v1.0.0`
- manual trigger from GitHub Actions

## GitHub Requirements

Make sure:

1. Repository is pushed to GitHub
2. GitHub Actions is enabled
3. Packages permission is available for `GITHUB_TOKEN`

No extra secret is required for GHCR when pushing from the same repo with the default `GITHUB_TOKEN`.

## Pull And Run From GHCR

```bash
docker pull ghcr.io/<github-owner>/dimension-brawl:latest
docker run -d --name dimension-brawl-app ^
  -p 4000:4000 ^
  -e DB_HOST=<mysql-host> ^
  -e DB_PORT=3306 ^
  -e DB_NAME=dimension_brawl ^
  -e DB_USER=root ^
  -e DB_PASSWORD=123456 ^
  ghcr.io/<github-owner>/dimension-brawl:latest
```

## Notes

- `docker-compose.yml` starts both app and MySQL
- `schema.sql` is auto-imported on first MySQL initialization
- App image itself does not contain MySQL
- login sessions are permanent by default and expire at `2099-12-31 23:59:59 UTC`
