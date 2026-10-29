# 애셋 규격 (Blender → glTF)

모든 3D 애셋은 `assets/blender/build_assets.py` 하나로 Blender(5.2, 헤드리스)에서 절차적으로 만들고
`assets/models/*.glb` 로 내보낸다. 외부 애셋은 쓰지 않는다. 다시 만들 때:

```bash
npm run build:assets
```

`tools/build-assets.mjs` 가 Blender 실행 파일을 찾는다(환경 변수 `BLENDER_PATH` 우선,
없으면 `C:\Program Files\Blender Foundation\Blender 5.2\blender.exe`).

## 좌표계

- 게임(three.js·glTF)은 Y-up, 미터 단위. 캐릭터와 무기의 "앞"은 **-Z**.
- Blender 좌표 `(X, Y, Z)` = 게임 좌표 `(x, -z, y)`. glTF 내보내기(`export_yup=True`)가 변환한다.
  즉 Blender에서 캐릭터는 **+Y를 바라보게** 만들고, 캐릭터의 오른손은 **+X** 쪽이다.

## 히어로 모델 `hero_<id>.glb` (kodiak, vex, ember, rook, sol)

- 발바닥 중심이 원점. 머리 꼭대기 높이 = `shared/heroes.js` 의 `height`, 폭은 대략 `radius*2` 안쪽.
- 노드(오브젝트) 이름과 계층은 정확히 아래와 같아야 한다. 각 노드의 원점(피벗)은 관절 위치.
  ```
  root                (원점, 발 높이)
  └─ hips             (골반 높이)
     ├─ legL          (왼쪽 고관절, -X 쪽)
     ├─ legR          (오른쪽 고관절, +X 쪽)
     └─ torso         (허리) — 클라이언트가 조준 피치로 회전시킨다
        ├─ head       (목)
        ├─ armL       (왼쪽 어깨)
        ├─ armR       (오른쪽 어깨)
        └─ weapon     (무기 손잡이) — torso의 자식, 총구가 앞(-Z)을 향함
           └─ muzzle  (빈 오브젝트, 총구 끝)
  ```
- 팔은 무기를 앞으로 겨누는 자세로 모델링한다(클라이언트는 다리 스윙, 상체 피치만 절차 애니메이션).
- 머티리얼 이름 규칙(클라이언트가 이름으로 찾는다):
  - `Team` — 팀 색 띠/라이트. 클라이언트가 color·emissive 를 팀 색으로 덮어쓴다.
  - `Primary`, `Accent`, `Dark`, `Visor`(발광) 등은 자유. 색은 `heroes.js` 의 `colors` 를 따른다.
- 히어로당 5k 삼각형 이하. 실루엣이 서로 확연히 달라야 한다(탱커는 크고 넓게, 저격수는 긴 총 등).

## 1인칭 무기 `weapon_<id>.glb`

- 루트 노드 `weapon`, 원점은 손잡이. 총구는 -Z(게임)/+Y(Blender) 방향. `muzzle` 빈 오브젝트 포함.
- 장갑 낀 손/팔뚝을 함께 넣어도 된다(히어로 색상).

## 맵 `map_kestrel.glb`

- `shared/map-data.json` 의 `boxes` 각각을 **정확히 같은 좌표**의 박스 메시로 만든다(베벨 ≤ 0.04m).
  충돌 판정은 JSON 박스로 하므로 보이는 것과 어긋나면 안 된다.
- `kind` 별 머티리얼: ground, wall, spawn, roof, platform, stairs, cover, crate, pillar, point, bridge, railing, building.
  텍스처는 Blender 안에서 numpy 로 절차 생성해 GLB 에 포함(최대 512px), UV 는 월드 기준 평면 투영.
- 장식은 충돌이 없으므로 플레이 공간을 막지 않게 벽면·외벽 바깥에만 둔다(벽면 돌출 ≤ 0.15m).
  스폰 건물에 팀 색 배너(청: x<0, 적: x>0), 외벽 바깥 원경 실루엣 등.
- 거점 플랫폼 윗면(y=0.5)에 반지름 5m 중립 원형 마킹.
- 노드 이름 규칙(검사 스크립트가 강제):
  - `map_<kind>` — kind 별 충돌 박스 비주얼(바운딩이 map-data 와 일치).
  - `decor_surf_*` — 벽·바닥에 붙은 얇은 장식(노드마다 한 축 두께 ≤ 0.16m). 바닥 페인트, 배너, 조명, 사인, 거점·회복 팩 마킹, 다리 밑 거더 등.
  - `decor_out_*` — 외벽 바깥 원경(건물·크레인). 아레나 내부와 겹치지 않는다. 그림자 캐스팅을 꺼도 된다.

## 소품

| 파일 | 노드 | 원점 | 내용 |
| --- | --- | --- | --- |
| `prop_mine.glb` | `mine` | 바닥 중심 | 벡스 쇼크 지뢰(지름 ~0.45m), 발광 머티리얼 `Glow`, 팀 고리 `Team` |
| `prop_turret.glb` | `turret` > `head` > `muzzle` | 바닥 중심 | 루크 센트리 드론(~0.95m). `head` 피벗이 머리 중심(y=0.72)이라 조준 회전용, 총구는 -Z |
| `prop_canister.glb` | `canister` | 중심 | 엠버 네이팜 캐니스터(길이 ~0.34m) |
| `prop_healthpack_small.glb` / `prop_healthpack_large.glb` | `healthpack` | 바닥 중심 | 회복 팩. 녹색 바탕 흰 십자(적십자 표장 아님) |

## 검사·미리보기

```bash
node tools/check-assets.mjs            # 노드 계층·머티리얼·높이(±5%)·색·맵 바운딩·삼각형 수 검사
npm run build:assets -- --previews     # assets/previews/*.png 도 다시 렌더
```

미리보기는 내보낸 GLB 를 다시 불러와 Eevee 로 렌더한다(히어로 정면·측면·3/4, 1인칭 무기, 소품, 맵 조감·평면·지상 시점).
히어로 높이는 장식(솔의 고리, 루크의 안테나) 때문에 heroes.js 값보다 최대 ~2% 크다.
