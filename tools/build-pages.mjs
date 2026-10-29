// GitHub Pages 같은 정적 호스팅용 빌드: 서버 MOUNTS 와 같은 URL 배치로 dist/ 를 만든다.
// 게임 서버가 없으므로 페이지는 오프라인 봇전(브라우저 안 시뮬레이션)으로 동작한다.
// 실행: npm run build:pages  →  dist/ 를 아무 정적 서버로 열면 된다(하위 경로 배포 가능).
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SIM_MODULES } from '../server/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist');
const threeRoot = path.join(root, 'node_modules', 'three');

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

cpSync(path.join(root, 'client'), out, { recursive: true });
cpSync(path.join(root, 'shared'), path.join(out, 'shared'), { recursive: true });
mkdirSync(path.join(out, 'server'));
for (const f of SIM_MODULES) cpSync(path.join(root, 'server', f), path.join(out, 'server', f));
mkdirSync(path.join(out, 'assets'));
for (const f of readdirSync(path.join(root, 'assets', 'models'))) {
  if (f.endsWith('.glb')) cpSync(path.join(root, 'assets', 'models', f), path.join(out, 'assets', f));
}

// three.js 는 실제로 불러오는 모듈만 복사한다(클라이언트의 three/addons/* 에서 상대 import 를 따라간다).
const IMPORT_RE = /(?:import|export)\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;
const entries = new Set([path.join(threeRoot, 'build', 'three.module.js')]);
for (const f of readdirSync(path.join(root, 'client'))) {
  if (!f.endsWith('.js')) continue;
  for (const m of readFileSync(path.join(root, 'client', f), 'utf8').matchAll(IMPORT_RE)) {
    const spec = m[1] || m[2];
    if (spec.startsWith('three/addons/')) entries.add(path.join(threeRoot, 'examples', 'jsm', spec.slice('three/addons/'.length)));
  }
}
const seen = new Set();
const queue = [...entries];
while (queue.length) {
  const file = queue.pop();
  if (seen.has(file)) continue;
  if (!existsSync(file)) throw new Error(`three 모듈을 찾을 수 없습니다: ${path.relative(root, file)}`);
  seen.add(file);
  for (const m of readFileSync(file, 'utf8').matchAll(IMPORT_RE)) {
    const spec = m[1] || m[2];
    if (spec.startsWith('.')) queue.push(path.resolve(path.dirname(file), spec));
    else if (spec.startsWith('three/addons/')) queue.push(path.join(threeRoot, 'examples', 'jsm', spec.slice('three/addons/'.length)));
    else if (spec !== 'three') throw new Error(`처리하지 않은 import '${spec}' in ${path.relative(root, file)}`);
  }
}
for (const file of seen) {
  const dest = path.join(out, 'vendor', 'three', path.relative(threeRoot, file));
  mkdirSync(path.dirname(dest), { recursive: true });
  cpSync(file, dest);
}
cpSync(path.join(threeRoot, 'LICENSE'), path.join(out, 'vendor', 'three', 'LICENSE'));

writeFileSync(path.join(out, '.nojekyll'), '');

let bytes = 0;
let files = 0;
const walk = (d) => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else {
      files++;
      bytes += readFileSync(p).length;
    }
  }
};
walk(out);
console.log(`dist/ 생성: 파일 ${files}개, ${(bytes / 1024 / 1024).toFixed(1)}MB (three 모듈 ${seen.size}개)`);
