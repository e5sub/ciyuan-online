# 次元乱斗Online

## 技术栈

- 前端：`index.html`
- 后端：`server.js`
- 数据库：`MySQL 8`
- 容器：`Docker`
- 镜像仓库：`GHCR`

## 本地 Docker 部署

1. 复制 `.env.example` 为 `.env`
2. 按需修改 `DB_PASSWORD` 等环境变量
3. 执行：

```bash
docker compose up -d --build
```

4. 打开：

```text
http://localhost:4000
```

## 停止服务

```bash
docker compose down
```

如果要连数据库数据一起删除：

```bash
docker compose down -v
```

## GHCR 镜像构建

仓库已包含 GitHub Actions 工作流：

- `.github/workflows/docker-publish.yml`

会自动构建并推送到：

```text
ghcr.io/<github-owner>/dimension-brawl
```

触发方式：

- 推送到 `main`
- 推送标签，例如 `v1.0.0`
- 在 GitHub Actions 页面手动触发

## GitHub 要求

请确认：

1. 仓库已经推送到 GitHub
2. 已启用 GitHub Actions
3. `GITHUB_TOKEN` 具备 packages 写入权限

如果是同仓库推送到 GHCR，通常不需要额外 Secret。

## 从 GHCR 拉取并运行

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

## 说明

- `docker-compose.yml` 会同时启动应用和 MySQL
- `schema.sql` 会在 MySQL 首次初始化时自动导入
- 应用镜像本身不包含 MySQL
- 登录会话默认长期有效，过期时间固定到 `2099-12-31 23:59:59 UTC`
