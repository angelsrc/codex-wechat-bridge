import fs from 'node:fs';
import path from 'node:path';

// Save the next number before publishing a code so old replies cannot target a new request after restart.
export function createCodeGenerator(file) {
  let next = 101;
  if (file) {
    try { next = JSON.parse(fs.readFileSync(file, 'utf8')).next; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (!Number.isSafeInteger(next) || next < 101) throw Error('请求编号记录无效');
  return () => {
    if (!Number.isSafeInteger(next + 1)) throw Error('请求编号已用尽');
    const code = String(next);
    if (file) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file + '.tmp', JSON.stringify({ next: next + 1 }), { mode: 0o600 });
      fs.renameSync(file + '.tmp', file);
    }
    next++;
    return code;
  };
}
