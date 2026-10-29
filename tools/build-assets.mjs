// Blender(헤드리스)로 assets/blender/build_assets.py 를 실행해 assets/models/*.glb 를 다시 만든다.
// 사용: npm run build:assets [-- --previews] [-- --only heroes,weapons,map,props]
// Blender 경로: 환경 변수 BLENDER_PATH → OS 기본 설치 경로 → PATH 의 blender
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const script = path.join(root, 'assets', 'blender', 'build_assets.py');
const outDir = path.join(root, 'assets', 'models');
const previewDir = path.join(root, 'assets', 'previews');

function findBlender() {
  if (process.env.BLENDER_PATH) {
    if (!existsSync(process.env.BLENDER_PATH)) {
      throw new Error(`BLENDER_PATH 가 가리키는 파일이 없습니다: ${process.env.BLENDER_PATH}`);
    }
    return process.env.BLENDER_PATH;
  }
  const candidates = process.platform === 'win32'
    ? ['C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe']
    : process.platform === 'darwin'
      ? ['/Applications/Blender.app/Contents/MacOS/Blender']
      : ['/usr/bin/blender', '/usr/local/bin/blender', '/snap/bin/blender'];
  for (const c of candidates) if (existsSync(c)) return c;
  return 'blender'; // PATH 에 있기를 기대
}

const args = process.argv.slice(2);
const pyArgs = ['--out', outDir];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--previews') pyArgs.push('--previews', previewDir);
  else if (args[i] === '--only' && args[i + 1]) pyArgs.push('--only', args[++i]);
  else {
    console.error(`알 수 없는 인자: ${args[i]} (사용 가능: --previews, --only <목록>)`);
    process.exit(2);
  }
}

let blender;
try {
  blender = findBlender();
} catch (err) {
  console.error(err.message);
  process.exit(2);
}
console.log(`Blender: ${blender}`);
const res = spawnSync(
  blender,
  ['-b', '--factory-startup', '--python-exit-code', '1', '--python', script, '--', ...pyArgs],
  { stdio: 'inherit', cwd: root },
);
if (res.error) {
  console.error(`Blender 실행 실패: ${res.error.message}`);
  process.exit(1);
}
process.exit(res.status ?? 1);
