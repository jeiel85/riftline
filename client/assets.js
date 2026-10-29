// Blender 로 만든 GLB 애셋 로딩. 파일이 없으면 콘솔에 경고하고 단순 도형으로 대신한다.
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { HERO_IDS } from './shared/heroes.js';

export const assets = {
  map: null,
  heroes: {},
  weapons: {},
  props: {},
  missing: [],
};

const PROPS = ['mine', 'turret', 'canister', 'healthpack_small', 'healthpack_large'];

export async function loadAssets(onProgress = () => {}) {
  const loader = new GLTFLoader();
  const jobs = [
    ['map', 'map_kestrel.glb', (s) => { assets.map = s; }],
    ...HERO_IDS.map((id) => [`hero ${id}`, `hero_${id}.glb`, (s) => { assets.heroes[id] = s; }]),
    ...HERO_IDS.map((id) => [`weapon ${id}`, `weapon_${id}.glb`, (s) => { assets.weapons[id] = s; }]),
    ...PROPS.map((id) => [`prop ${id}`, `prop_${id}.glb`, (s) => { assets.props[id] = s; }]),
  ];
  let done = 0;
  await Promise.all(jobs.map(async ([label, file, store]) => {
    try {
      const gltf = await loader.loadAsync(`assets/${file}`);
      store(gltf.scene);
    } catch (err) {
      console.warn(`애셋 로드 실패: ${file} — 기본 도형으로 대체합니다.`, err);
      assets.missing.push(file);
    }
    done++;
    onProgress(done / jobs.length, label);
  }));
  return assets;
}
