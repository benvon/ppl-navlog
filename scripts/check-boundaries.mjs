import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const domainRoot = 'src/domain';
const forbiddenImport = /from\s+['"](?:@application\/|@services\/|@ui\/|(?:\.\.\/)+(?:application|services|ui)\/|.*\/worker\/)/;

async function listTypeScriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? listTypeScriptFiles(path) : entry.isFile() && path.endsWith('.ts') ? [path] : [];
  }));
  return files.flat();
}

try {
  const files = await listTypeScriptFiles(domainRoot);
  const failures = [];
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    if (forbiddenImport.test(source)) {
      failures.push(relative('.', file));
    }
  }
  if (failures.length > 0) {
    throw new Error(`Domain boundary violations: ${failures.join(', ')}`);
  }
  console.log(`Architecture boundary check passed for ${files.length} domain file(s).`);
} catch (error) {
  if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
    console.log('Architecture boundary check passed; src/domain has not been created yet.');
  } else {
    throw error;
  }
}
