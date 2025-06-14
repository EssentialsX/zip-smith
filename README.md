# zip-smith

A Cloudflare Worker that downloads files and packages them into ZIP files
with aggressive caching.

This powers our download page at https://essentialsx.net/downloads,
which allows users to select multiple addons and download them
as a single ZIP file.

## Development

### Prerequisites

- [Bun](https://bun.sh/) or Node.js
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/)

### Setup

1. Clone the repository
2. Install dependencies:
   ```bash
   bun install
   ```

3. Start development server:
   ```bash
   bun run dev
   ```

4. The worker is running on `http://localhost:8787`

## Deployment

Deploy to Cloudflare Workers:

```bash
bun run deploy
```
