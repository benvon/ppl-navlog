import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

// Reuse the newer workerd binary already installed with Wrangler so local
// runtime tests support the repository's deployment compatibility date.
const require = createRequire(import.meta.url);
const wranglerRoot = dirname(require.resolve('wrangler/package.json'));
process.env.MINIFLARE_WORKERD_PATH ??= join(wranglerRoot, '..', 'workerd', 'bin', 'workerd');
