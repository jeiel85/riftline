"""Riftline 홍보 렌더 — README 용 배너·히어로 카드·맵 이미지를 GLB 에서 렌더한다.

실행:
  blender -b --factory-startup --python-exit-code 1 --python assets/blender/render_promo.py -- \
      [--out docs/images] [--only banner,heroes,map] [--samples 128]

히어로 샷은 Cycles 투명 필름 + 섀도 캐처 바닥으로 렌더한 뒤 numpy 로 그라디언트 배경 위에 합성한다.
결과 PNG 는 알파 없는 8비트 RGB 로 직접 인코딩한다(용량·채널을 고정하기 위해).
좌표는 build_assets.py 와 같다: 히어로는 Blender +Y 를 바라보고 발바닥 중심이 원점.
"""
import argparse
import colorsys
import math
import os
import shutil
import struct
import sys
import tempfile
import time
import zlib

import bpy
import numpy as np
from bpy_extras.object_utils import world_to_camera_view
from mathutils import Vector

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
MODEL_DIR = os.path.join(ROOT, 'assets', 'models')

# shared/heroes.js 의 accent 색
ACCENTS = {
    'kodiak': '#e8892c',
    'vex': '#2fd6c8',
    'ember': '#ff9a2e',
    'rook': '#b7f04a',
    'sol': '#f2c53d',
}
TEAM_BLUE = '#3aa0ff'
TEAL = '#2fd6c8'
ORANGE = '#ff9a2e'
NAVY_TOP = '#0b1220'

TMP_DIR = tempfile.mkdtemp(prefix='riftline_promo_')


# ─────────────────────────────────────────────────────────────
# 공통 유틸
# ─────────────────────────────────────────────────────────────
def log(*a):
    print('[promo]', *a, flush=True)


def hex_rgb(h):
    h = h.lstrip('#')
    return np.array([int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)], np.float32)


def lin(color):
    c = hex_rgb(color) if isinstance(color, str) else np.asarray(color, np.float32)
    return tuple(float(v) for v in np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4))


def link(obj):
    bpy.context.scene.collection.objects.link(obj)
    return obj


def reset():
    """샷마다 씬을 비운다(가져온 GLB 의 머티리얼 이름이 .001 로 늘어나지 않게)."""
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    for coll in (bpy.data.meshes, bpy.data.materials, bpy.data.curves, bpy.data.cameras,
                 bpy.data.lights, bpy.data.images, bpy.data.worlds):
        for item in list(coll):
            coll.remove(item)


def aim(obj, target):
    obj.rotation_euler = (Vector(target) - obj.location).to_track_quat('-Z', 'Y').to_euler()


def import_glb(path, loc=(0, 0, 0), yaw=0.0):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    new = [o for o in bpy.data.objects if o not in before]
    for o in new:
        if o.parent is None:
            o.location = loc
            o.rotation_mode = 'XYZ'
            o.rotation_euler = (0, 0, yaw)
    bpy.context.view_layer.update()
    return new


def face_yaw(pos, target):
    """+Y 를 보는 모델이 pos 에서 target(XY) 을 바라보게 하는 Z 회전."""
    dx, dy = target[0] - pos[0], target[1] - pos[1]
    return math.atan2(-dx, dy)


def tint_team(objs, color, strength=1.6):
    """클라이언트처럼 `Team` 머티리얼의 color·emissive 를 팀 색으로 덮어쓴다."""
    for o in objs:
        for slot in getattr(o, 'material_slots', []):
            m = slot.material
            if m is None or m.name.split('.')[0] != 'Team' or m.node_tree is None:
                continue
            for n in m.node_tree.nodes:
                if n.type == 'BSDF_PRINCIPLED':
                    n.inputs['Base Color'].default_value = (*lin(color), 1)
                    n.inputs['Emission Color'].default_value = (*lin(color), 1)
                    n.inputs['Emission Strength'].default_value = strength


def emission_mat(name, color, strength=1.0, top=None):
    """조명과 무관한 발광 머티리얼. top 을 주면 글자 아래→위 세로 그라디언트."""
    m = bpy.data.materials.new(name)
    if m.node_tree is None:
        m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    em = nt.nodes.new('ShaderNodeEmission')
    em.inputs['Strength'].default_value = strength
    nt.links.new(em.outputs['Emission'], out.inputs['Surface'])
    if top is None:
        em.inputs['Color'].default_value = (*lin(color), 1)
        return m
    tc = nt.nodes.new('ShaderNodeTexCoord')
    sep = nt.nodes.new('ShaderNodeSeparateXYZ')
    ramp = nt.nodes.new('ShaderNodeValToRGB')
    ramp.color_ramp.elements[0].position = 0.15
    ramp.color_ramp.elements[0].color = (*lin(color), 1)
    ramp.color_ramp.elements[1].position = 0.9
    ramp.color_ramp.elements[1].color = (*lin(top), 1)
    nt.links.new(tc.outputs['Generated'], sep.inputs['Vector'])
    nt.links.new(sep.outputs['Y'], ramp.inputs['Fac'])
    nt.links.new(ramp.outputs['Color'], em.inputs['Color'])
    return m


def camera_only(obj):
    """카메라에만 보이고 씬에 그림자·반사·빛을 남기지 않는다(글자·장식용)."""
    obj.visible_shadow = False
    obj.visible_diffuse = False
    obj.visible_glossy = False
    obj.visible_transmission = False
    obj.visible_volume_scatter = False


# ─────────────────────────────────────────────────────────────
# 렌더 설정
# ─────────────────────────────────────────────────────────────
GPU_KIND = None


def pick_device():
    """OPTIX → CUDA → HIP → METAL → ONEAPI 순으로 GPU 를 찾고, 없으면 CPU."""
    global GPU_KIND
    prefs = bpy.context.preferences.addons['cycles'].preferences
    for kind in ('OPTIX', 'CUDA', 'HIP', 'METAL', 'ONEAPI'):
        try:
            prefs.compute_device_type = kind
        except TypeError:
            continue
        prefs.get_devices()
        if any(d.type == kind for d in prefs.devices):
            for d in prefs.devices:
                d.use = d.type == kind
            GPU_KIND = kind
            break
    log('device', GPU_KIND or 'CPU')


def setup_scene(res, samples, transparent):
    s = bpy.context.scene
    s.render.engine = 'CYCLES'
    s.cycles.device = 'GPU' if GPU_KIND else 'CPU'
    s.cycles.samples = samples
    s.cycles.use_adaptive_sampling = True
    s.cycles.adaptive_threshold = 0.02
    s.cycles.use_denoising = True
    s.cycles.denoiser = 'OPENIMAGEDENOISE'
    s.cycles.max_bounces = 6
    s.cycles.sample_clamp_indirect = 8.0
    s.render.resolution_x, s.render.resolution_y = res
    s.render.resolution_percentage = 100
    s.render.film_transparent = transparent
    s.render.image_settings.file_format = 'PNG'
    s.render.image_settings.color_mode = 'RGBA' if transparent else 'RGB'
    s.render.image_settings.color_depth = '8'
    s.view_settings.view_transform = 'AgX'
    try:
        s.view_settings.look = 'AgX - Punchy'
    except TypeError:
        pass
    s.render.dither_intensity = 0.0   # 디더링은 합성 뒤 한 번만
    world = bpy.data.worlds.new('World')
    s.world = world
    if world.node_tree is None:
        world.use_nodes = True
    return s


def set_world_color(color, strength):
    bg = next(n for n in bpy.context.scene.world.node_tree.nodes if n.type == 'BACKGROUND')
    bg.inputs['Color'].default_value = (*lin(color), 1)
    bg.inputs['Strength'].default_value = strength


def add_camera(loc, target, lens):
    cd = bpy.data.cameras.new('cam')
    cd.lens = lens
    cd.clip_start = 0.1
    cd.clip_end = 2000
    cam = link(bpy.data.objects.new('cam', cd))
    cam.location = loc
    aim(cam, target)
    bpy.context.scene.camera = cam
    return cam


def add_area(name, loc, target, color, power, size, shadow=True):
    ld = bpy.data.lights.new(name, 'AREA')
    ld.shape = 'DISK'
    ld.size = size
    ld.energy = power
    ld.color = lin(color)
    ld.use_shadow = shadow
    o = link(bpy.data.objects.new(name, ld))
    o.location = loc
    aim(o, target)
    return o


def add_stage_floor(center, rx, ry, color, roughness=0.35):
    """반들한 무대 바닥. 타원 가장자리로 갈수록 투명해져 2D 배경에 녹아든다
    (그림자·림 조명 웅덩이·흐린 반사를 받는다)."""
    me = bpy.data.meshes.new('floor')
    h = 40
    me.from_pydata([(-h, -h, 0), (h, -h, 0), (h, h, 0), (-h, h, 0)], [], [(0, 1, 2, 3)])
    m = bpy.data.materials.new('StageFloor')
    if m.node_tree is None:
        m.use_nodes = True
    nt = m.node_tree
    bsdf = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
    out = next(n for n in nt.nodes if n.type == 'OUTPUT_MATERIAL')
    bsdf.inputs['Base Color'].default_value = (*lin(color), 1)
    bsdf.inputs['Roughness'].default_value = roughness
    tc = nt.nodes.new('ShaderNodeTexCoord')
    sc = nt.nodes.new('ShaderNodeVectorMath')
    sc.operation = 'MULTIPLY'
    sc.inputs[1].default_value = (1 / rx, 1 / ry, 0)
    ln = nt.nodes.new('ShaderNodeVectorMath')
    ln.operation = 'LENGTH'
    fade = nt.nodes.new('ShaderNodeMapRange')
    fade.interpolation_type = 'SMOOTHSTEP'
    fade.inputs['From Min'].default_value = 0.35
    fade.inputs['From Max'].default_value = 1.0
    fade.inputs['To Min'].default_value = 1.0
    fade.inputs['To Max'].default_value = 0.0
    tr = nt.nodes.new('ShaderNodeBsdfTransparent')
    mix = nt.nodes.new('ShaderNodeMixShader')
    nt.links.new(tc.outputs['Object'], sc.inputs[0])
    nt.links.new(sc.outputs['Vector'], ln.inputs[0])
    nt.links.new(ln.outputs['Value'], fade.inputs['Value'])
    nt.links.new(fade.outputs['Result'], mix.inputs['Fac'])
    nt.links.new(tr.outputs['BSDF'], mix.inputs[1])
    nt.links.new(bsdf.outputs['BSDF'], mix.inputs[2])
    nt.links.new(mix.outputs['Shader'], out.inputs['Surface'])
    me.materials.append(m)
    o = link(bpy.data.objects.new('floor', me))
    o.location = center
    return o


def frame_objects(cam, objs, box, iters=8):
    """objs 의 바운딩 박스가 화면 영역 box=(x0, y0, x1, y1)(0..1, 아래가 0)에 꼭 맞도록
    카메라를 시선 방향으로 밀고 당기며 lens shift 로 중심을 맞춘다(세로선이 기울지 않게)."""
    s = bpy.context.scene
    bpy.context.view_layer.update()
    pts = [o.matrix_world @ Vector(c) for o in objs if o.type == 'MESH' for c in o.bound_box]
    fwd = cam.matrix_world.to_quaternion() @ Vector((0, 0, -1))
    big = max(s.render.resolution_x, s.render.resolution_y)
    sx, sy = s.render.resolution_x / big, s.render.resolution_y / big
    for _ in range(iters):
        bpy.context.view_layer.update()
        uv = [world_to_camera_view(s, cam, p) for p in pts]
        x0, x1 = min(p.x for p in uv), max(p.x for p in uv)
        y0, y1 = min(p.y for p in uv), max(p.y for p in uv)
        fill = max((x1 - x0) / (box[2] - box[0]), (y1 - y0) / (box[3] - box[1]))
        target = sum(pts, Vector()) / len(pts)
        dist = (target - cam.location).dot(fwd)
        cam.location += fwd * dist * (1 - fill)
        cam.data.shift_x += ((x0 + x1) / 2 - (box[0] + box[2]) / 2) * sx
        cam.data.shift_y += ((y0 + y1) / 2 - (box[1] + box[3]) / 2) * sy
    bpy.context.view_layer.update()
    log(f'frame x {x0:.3f}..{x1:.3f} y {y0:.3f}..{y1:.3f} (fill {fill:.3f})')


def render_rgba(name):
    """현재 씬을 렌더해 (h, w, 4) float 배열(디스플레이 sRGB, 위쪽 행부터)로 돌려준다."""
    s = bpy.context.scene
    path = os.path.join(TMP_DIR, name + '.png')
    s.render.filepath = path
    t0 = time.time()
    bpy.ops.render.render(write_still=True)
    log(f'rendered {name} in {time.time() - t0:.1f}s')
    img = bpy.data.images.load(path)
    w, h = img.size
    ch = img.channels
    arr = np.empty(w * h * ch, np.float32)
    img.pixels.foreach_get(arr)   # 8비트 이미지는 색 변환 없이 /255 값
    bpy.data.images.remove(img)
    arr = arr.reshape(h, w, ch)[::-1]
    if ch == 3:
        arr = np.concatenate([arr, np.ones((h, w, 1), np.float32)], axis=2)
    return arr


# ─────────────────────────────────────────────────────────────
# 2D 합성(numpy, 디스플레이 sRGB 공간)
# ─────────────────────────────────────────────────────────────
def grid(h, w):
    y, x = np.mgrid[0:h, 0:w].astype(np.float32)
    return x / (w - 1), y / (h - 1)


def smooth(t):
    t = np.clip(t, 0, 1)
    return t * t * (3 - 2 * t)


def gradient(h, w, stops):
    """세로 그라디언트. stops = [(y, '#hex'), ...], y 는 0(위)..1(아래)."""
    _, yy = grid(h, w)
    out = np.zeros((h, w, 3), np.float32)
    ys = [p for p, _ in stops]
    cs = [hex_rgb(c) for _, c in stops]
    for i in range(3):
        out[..., i] = np.interp(yy, ys, [c[i] for c in cs])
    return out


def glow(img, cx, cy, rx, ry, color, amount, mode='add'):
    """타원형 부드러운 빛. cx·cy·rx·ry 는 너비·높이 기준 0..1."""
    h, w, _ = img.shape
    xx, yy = grid(h, w)
    d2 = ((xx - cx) / rx) ** 2 + ((yy - cy) / ry) ** 2
    k = (np.exp(-2.5 * d2) * amount)[..., None]
    c = hex_rgb(color)
    if mode == 'add':
        return img + k * c
    return img * (1 - k) + c * k


def vignette(img, amount=0.35):
    h, w, _ = img.shape
    xx, yy = grid(h, w)
    d = np.sqrt(((xx - 0.5) / 0.75) ** 2 + ((yy - 0.5) / 0.75) ** 2)
    return img * (1 - amount * smooth(d))[..., None]


def blur(img, r):
    """상자 블러 3회 ≈ 가우시안(누적합, 가장자리 복제)."""
    out = img
    for _ in range(3):
        for axis in (0, 1):
            pad = [(0, 0)] * out.ndim
            pad[axis] = (r + 1, r)
            p = np.pad(out, pad, mode='edge')
            c = np.cumsum(p, axis=axis)
            hi = np.take(c, np.arange(2 * r + 1, c.shape[axis]), axis=axis)
            lo = np.take(c, np.arange(0, c.shape[axis] - 2 * r - 1), axis=axis)
            out = (hi - lo) / (2 * r + 1)
    return out


def bloom(rgb, fg, radius, amount):
    """발광부(채도 높고 밝은 픽셀)만 번지게 한다. 흰 장갑이 번지지 않도록 채도로 거른다."""
    mx = rgb.max(axis=2)
    sat = (mx - rgb.min(axis=2)) / np.maximum(mx, 1e-4)
    w = smooth((mx - 0.7) / 0.3) * smooth((sat - 0.35) / 0.4) * fg[..., 3]
    src = rgb * w[..., None]
    small = src[::2, ::2]
    b = blur(small, max(1, radius // 2))
    b = np.repeat(np.repeat(b, 2, axis=0), 2, axis=1)[:rgb.shape[0], :rgb.shape[1]]
    return rgb + b * amount


def over(fg, bg):
    a = fg[..., 3:4]
    return fg[..., :3] * a + bg * (1 - a)


BAYER4 = np.array([[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]], np.float32) / 16 - 0.47


def to_u8(rgb):
    h, w, _ = rgb.shape
    d = np.tile(BAYER4, (h // 4 + 1, w // 4 + 1))[:h, :w, None]
    return np.clip(rgb * 255 + d, 0, 255).astype(np.uint8)


def write_png(path, rgb8):
    """알파 없는 8비트 RGB PNG. 행마다 PNG 필터 5종 중 절댓값 합이 가장 작은 것을 고른다."""
    h, w, _ = rgb8.shape
    x = rgb8.reshape(h, w * 3).astype(np.int16)
    a = np.zeros_like(x)
    a[:, 3:] = x[:, :-3]
    b = np.zeros_like(x)
    b[1:] = x[:-1]
    c = np.zeros_like(x)
    c[1:, 3:] = x[:-1, :-3]
    p = a + b - c
    pa, pb, pc = np.abs(p - a), np.abs(p - b), np.abs(p - c)
    paeth = np.where((pa <= pb) & (pa <= pc), a, np.where(pb <= pc, b, c))
    cands = np.stack([x, x - a, x - b, x - (a + b) // 2, x - paeth]) % 256
    cost = np.where(cands > 127, 256 - cands, cands).sum(axis=2)
    best = cost.argmin(axis=0)
    rows = np.empty((h, w * 3 + 1), np.uint8)
    rows[:, 0] = best
    rows[:, 1:] = cands[best, np.arange(h)]

    def chunk(tag, body):
        return struct.pack('>I', len(body)) + tag + body + struct.pack('>I', zlib.crc32(tag + body) & 0xffffffff)

    data = (b'\x89PNG\r\n\x1a\n'
            + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0))
            + chunk(b'sRGB', b'\x00')
            + chunk(b'IDAT', zlib.compress(rows.tobytes(), 9))
            + chunk(b'IEND', b''))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'wb') as f:
        f.write(data)
    log('wrote', os.path.relpath(path, ROOT), f'{len(data) / 1024:.0f} KB')


def screen_y(cam, p):
    """월드 점 p 의 화면 세로 위치(0=위, 1=아래)."""
    return 1 - world_to_camera_view(bpy.context.scene, cam, Vector(p)).y


# ─────────────────────────────────────────────────────────────
# 조명
# ─────────────────────────────────────────────────────────────
def hero_lights(center, spread, rim_l, rim_r, key_power=900, rim_power=1400):
    """키(앞 오른쪽 위)·필(앞 왼쪽)·좌우 림(뒤 옆 위, 색)·탑(접지 그림자). 카메라는 -Y 쪽에 있다.
    림은 그림자를 끄고 옆면·윗면 가장자리만 물들인다."""
    cx, cy, cz = center
    t = (cx, cy, cz)
    add_area('key', (cx + 4.2 + spread * 0.3, cy - 3.0, cz + 3.4), t, '#fff1e0', key_power, 2.2)
    add_area('fill', (cx - 5.0 - spread * 0.3, cy - 3.5, cz + 0.4), t, '#8fa8e0', key_power * 0.16, 4.0, shadow=False)
    for name, sgn, col in (('rimL', -1, rim_l), ('rimR', 1, rim_r)):
        add_area(name, (cx + sgn * (3.4 + spread * 0.55), cy + 2.4, cz + 2.6),
                 (cx + sgn * spread * 0.25, cy, cz + 0.3), col, rim_power, 1.2, shadow=False)
    add_area('top', (cx, cy + 0.4, cz + 5.0), (cx, cy, 0), '#dfe8ff', key_power * 0.25, 3.0 + spread)


# ─────────────────────────────────────────────────────────────
# 1) 배너 1280×640
# ─────────────────────────────────────────────────────────────
LINEUP = [  # (id, x, y) — 카메라는 -Y 쪽, 화면 오른쪽 = +X
    ('rook', -3.35, 0.95),
    ('vex', -1.72, 0.2),
    ('kodiak', 0.0, -0.45),
    ('ember', 1.72, 0.2),
    ('sol', 3.35, 0.95),
]


def add_text(cam, body, u, v, height, mat, spacing=1.0, bold=0.0, depth=6.0):
    """카메라에 붙인 화면 고정 글자. u·v 는 글자 중심의 화면 위치(0..1, 아래가 0),
    height 는 대문자 높이의 화면 세로 비율."""
    s = bpy.context.scene
    cd = cam.data
    big = max(s.render.resolution_x, s.render.resolution_y)
    half_big = depth * cd.sensor_width / 2 / cd.lens            # 큰 축의 절반 폭(깊이 depth 에서)
    hw = half_big * s.render.resolution_x / big
    hh = half_big * s.render.resolution_y / big
    cu = bpy.data.curves.new('txt_' + body[:8], 'FONT')
    cu.body = body
    cu.align_x = 'CENTER'
    cu.align_y = 'CENTER'
    cu.space_character = spacing
    cu.offset = bold
    cu.size = height * 2 * hh / 0.72        # 내장 글꼴 대문자 높이 ≈ 0.72em
    cu.offset *= cu.size
    o = link(bpy.data.objects.new('txt_' + body[:8], cu))
    o.data.materials.append(mat)
    o.parent = cam
    o.location = ((u - 0.5) * 2 * hw + cd.shift_x * 2 * half_big,
                  (v - 0.5) * 2 * hh + cd.shift_y * 2 * half_big, -depth)
    camera_only(o)
    return o


def add_side_bars(cam, text_obj, gap, length, thick, mat):
    """글자 양옆의 얇은 막대(부제 장식). gap·length 는 글자 높이 배수, thick 은 막대 두께 배수."""
    bpy.context.view_layer.update()
    tl = text_obj.location
    hw_text = text_obj.dimensions.x / 2
    cap = text_obj.data.size * 0.72
    bw, bh = length * cap / 2, thick * cap / 2
    for sgn in (-1, 1):
        cx = tl.x + sgn * (hw_text + gap * cap + bw)
        me = bpy.data.meshes.new('bar')
        me.from_pydata([(-bw, -bh, 0), (bw, -bh, 0), (bw, bh, 0), (-bw, bh, 0)], [], [(0, 1, 2, 3)])
        me.materials.append(mat)
        o = link(bpy.data.objects.new('bar', me))
        o.parent = cam
        o.location = (cx, tl.y, tl.z)
        camera_only(o)


def shot_banner(out_dir, samples):
    reset()
    W, H = 1280, 640
    setup_scene((W, H), samples, transparent=True)
    set_world_color('#1a2740', 0.35)
    heroes = []
    for hid, x, y in LINEUP:
        # 바깥쪽일수록 안쪽으로 더 돌려 옆면이 보이게 → 좌우 림 색이 옆면에 걸린다.
        yaw = face_yaw((x, y), (-x * 1.1, -10.0))
        objs = import_glb(os.path.join(MODEL_DIR, f'hero_{hid}.glb'), (x, y, 0), yaw)
        tint_team(objs, TEAM_BLUE)
        heroes += objs
    add_stage_floor((0, 0.3, 0), 7.5, 4.0, '#1a2a45')
    hero_lights((0, 0.2, 1.1), 3.0, TEAL, ORANGE, key_power=1100, rim_power=5000)
    # 낮은 카메라에서 살짝 올려다본다. 히어로는 화면 아래 2/3, 제목은 위쪽.
    cam = add_camera((0, -11.0, 0.95), (0, 0, 1.3), 40)
    frame_objects(cam, heroes, (0.07, 0.06, 0.93, 0.66))

    gold = emission_mat('TitleGold', '#ff8a1a', 1.8, top='#ffbf3a')
    sub = emission_mat('Subtitle', '#d6e6ff', 1.7)
    bar = emission_mat('Bar', TEAL, 1.3)
    add_text(cam, 'RIFTLINE', 0.5, 0.845, 0.135, gold, spacing=1.32, bold=0.035)
    st = add_text(cam, 'BROWSER TEAM HERO SHOOTER', 0.5, 0.725, 0.030, sub, spacing=1.55, bold=0.01)
    add_side_bars(cam, st, 0.9, 3.2, 0.12, bar)

    fg = render_rgba('banner')
    feet = screen_y(cam, (0, 0.2, 0))
    bg = gradient(H, W, [(0, NAVY_TOP), (0.5, '#13203a'), (feet, '#1b2c4a'), (1, '#0e1729')])
    bg = glow(bg, 0.5, feet - 0.2, 0.42, 0.42, '#1e3a63', 0.55)
    bg = glow(bg, 0.12, 0.55, 0.28, 0.5, TEAL, 0.10)
    bg = glow(bg, 0.88, 0.55, 0.28, 0.5, ORANGE, 0.09)
    bg = vignette(bg, 0.45)
    rgb = over(fg, bg)
    rgb = bloom(rgb, fg, 10, 0.55)
    write_png(os.path.join(out_dir, 'banner.png'), to_u8(rgb))


# ─────────────────────────────────────────────────────────────
# 2) 히어로 카드 480×600
# ─────────────────────────────────────────────────────────────
def to_hex(c):
    return '#' + ''.join(f'{int(round(min(max(v, 0), 1) * 255)):02x}' for v in c)


def shade(color, sat, val, hue_shift=0.0):
    """같은 색상(hue)으로 밝기만 바꾼 색. 네이비와 섞으면 주황이 갈색으로 탁해져서 이렇게 만든다."""
    h, s, _ = colorsys.rgb_to_hsv(*hex_rgb(color))
    return to_hex(colorsys.hsv_to_rgb((h + hue_shift) % 1, s * sat, val))


def shot_portrait(hid, out_dir, samples):
    reset()
    W, H = 480, 600
    accent = ACCENTS[hid]
    warm = hex_rgb(accent)[0] > hex_rgb(accent)[2]
    rim_other = TEAL if warm else ORANGE
    setup_scene((W, H), samples, transparent=True)
    set_world_color(shade(accent, 0.5, 0.2), 0.4)
    objs = import_glb(os.path.join(MODEL_DIR, f'hero_{hid}.glb'), (0, 0, 0), math.radians(180 + 32))
    tint_team(objs, accent)
    add_stage_floor((0, 0, 0), 2.6, 2.2, shade(accent, 0.55, 0.16))
    hero_lights((0, 0, 1.0), 0.0, accent, rim_other, key_power=650, rim_power=2600)
    cam = add_camera((0, -6.5, 0.7), (0, 0, 1.0), 50)
    frame_objects(cam, objs, (0.12, 0.08, 0.88, 0.9))

    fg = render_rgba('hero_' + hid)
    # 위는 선명한 accent, 아래로 같은 색상의 아주 어두운 톤 → 라이트·다크 테마 어디서나 카드로 읽힌다.
    drift = -0.03 if warm else 0.03
    bg = gradient(H, W, [(0, shade(accent, 0.95, 0.62)), (0.45, shade(accent, 1.0, 0.3, drift * 0.5)),
                         (1, shade(accent, 0.85, 0.06, drift))])
    bg = glow(bg, 0.5, 0.36, 0.5, 0.38, shade(accent, 0.8, 0.9), 0.18)
    bg = vignette(bg, 0.3)
    rgb = over(fg, bg)
    rgb = bloom(rgb, fg, 8, 0.5)
    write_png(os.path.join(out_dir, f'hero_{hid}.png'), to_u8(rgb))


# ─────────────────────────────────────────────────────────────
# 3) 맵 1280×720
# ─────────────────────────────────────────────────────────────
def sky_world(zenith, horizon, ground, strength):
    """방향 Z 로 섞는 부드러운 하늘(지평선 밝고 천정 짙게)."""
    w = bpy.context.scene.world
    nt = w.node_tree
    nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputWorld')
    bg = nt.nodes.new('ShaderNodeBackground')
    bg.inputs['Strength'].default_value = strength
    tc = nt.nodes.new('ShaderNodeTexCoord')
    sep = nt.nodes.new('ShaderNodeSeparateXYZ')
    ramp = nt.nodes.new('ShaderNodeValToRGB')
    els = ramp.color_ramp.elements
    els[0].position, els[0].color = 0.44, (*lin(ground), 1)
    els[1].position, els[1].color = 1.0, (*lin(zenith), 1)
    e = els.new(0.5)
    e.color = (*lin(horizon), 1)
    mr = nt.nodes.new('ShaderNodeMapRange')   # z(-1..1) → 0..1
    mr.inputs['From Min'].default_value = -1
    mr.inputs['From Max'].default_value = 1
    nt.links.new(tc.outputs['Generated'], sep.inputs['Vector'])
    nt.links.new(sep.outputs['Z'], mr.inputs['Value'])
    nt.links.new(mr.outputs['Result'], ramp.inputs['Fac'])
    nt.links.new(ramp.outputs['Color'], bg.inputs['Color'])
    nt.links.new(bg.outputs['Background'], out.inputs['Surface'])


def add_ground_plane(size, z, color, haze, near, far):
    """아레나 바깥 바닥. 멀어질수록 지평선 안개색(haze, 발광)으로 바뀌어 하늘과 이어진다."""
    me = bpy.data.meshes.new('outer_ground')
    h = size / 2
    me.from_pydata([(-h, -h, z), (h, -h, z), (h, h, z), (-h, h, z)], [], [(0, 1, 2, 3)])
    m = bpy.data.materials.new('OuterGround')
    if m.node_tree is None:
        m.use_nodes = True
    nt = m.node_tree
    bsdf = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
    out = next(n for n in nt.nodes if n.type == 'OUTPUT_MATERIAL')
    bsdf.inputs['Base Color'].default_value = (*lin(color), 1)
    bsdf.inputs['Roughness'].default_value = 0.85
    tc = nt.nodes.new('ShaderNodeTexCoord')
    ln = nt.nodes.new('ShaderNodeVectorMath')
    ln.operation = 'LENGTH'
    mr = nt.nodes.new('ShaderNodeMapRange')
    mr.interpolation_type = 'SMOOTHSTEP'
    mr.inputs['From Min'].default_value = near
    mr.inputs['From Max'].default_value = far
    em = nt.nodes.new('ShaderNodeEmission')
    em.inputs['Color'].default_value = (*lin(haze), 1)
    mix = nt.nodes.new('ShaderNodeMixShader')
    nt.links.new(tc.outputs['Object'], ln.inputs[0])
    nt.links.new(ln.outputs['Value'], mr.inputs['Value'])
    nt.links.new(mr.outputs['Result'], mix.inputs['Fac'])
    nt.links.new(bsdf.outputs['BSDF'], mix.inputs[1])
    nt.links.new(em.outputs['Emission'], mix.inputs[2])
    nt.links.new(mix.outputs['Shader'], out.inputs['Surface'])
    me.materials.append(m)
    return link(bpy.data.objects.new('outer_ground', me))


def add_sun(azimuth_deg, elevation_deg, energy, color):
    """azimuth: 태양이 있는 방향(Blender XY, +X 에서 반시계), elevation: 지평선 위 각도."""
    az, el = math.radians(azimuth_deg), math.radians(elevation_deg)
    to_sun = Vector((math.cos(el) * math.cos(az), math.cos(el) * math.sin(az), math.sin(el)))
    sd = bpy.data.lights.new('sun', 'SUN')
    sd.energy = energy
    sd.angle = math.radians(1.5)
    sd.color = lin(color)
    sun = link(bpy.data.objects.new('sun', sd))
    sun.rotation_euler = (-to_sun).to_track_quat('-Z', 'Y').to_euler()
    return sun


def shot_map(out_dir, samples):
    reset()
    W, H = 1280, 720
    s = setup_scene((W, H), samples, transparent=False)
    s.view_settings.exposure = 0.3   # 아레나 바닥 텍스처가 어두워 조금 밝힌다
    haze = '#e9dccb'
    sky_world('#4a80c8', haze, '#a59c92', 1.0)
    objs = import_glb(os.path.join(MODEL_DIR, 'map_kestrel.glb'))
    cam_loc = Vector((-6, 50, 56))
    # 카메라 쪽(남쪽) 원경 건물·크레인은 아레나를 가리기만 하므로 이 샷에서는 숨긴다.
    for o in objs:
        if o.name.startswith('decor_out_') and o.type == 'MESH':
            c = sum((o.matrix_world @ Vector(v) for v in o.bound_box), Vector()) / 8
            if c.y > 28:
                o.hide_render = True
    add_ground_plane(1600, -0.03, '#6f747c', haze, 140, 700)
    add_sun(58, 46, 5.5, '#ffdcae')
    cam = add_camera(cam_loc, (0, -4, -2), 24)
    frame_objects(cam, [o for o in objs if o.name.startswith('map_')], (0.025, 0.03, 0.975, 0.86))
    fg = render_rgba('map')
    write_png(os.path.join(out_dir, 'map.png'), to_u8(vignette(fg[..., :3], 0.22)))


# ─────────────────────────────────────────────────────────────
def main():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=os.path.join(ROOT, 'docs', 'images'))
    ap.add_argument('--only', default='banner,heroes,map')
    ap.add_argument('--samples', type=int, default=128)
    args = ap.parse_args(argv)
    out = os.path.abspath(args.out)
    only = set(args.only.split(','))
    t0 = time.time()
    pick_device()
    try:
        if 'banner' in only:
            shot_banner(out, args.samples)
        if 'heroes' in only:
            for hid in ACCENTS:
                shot_portrait(hid, out, args.samples)
        if 'map' in only:
            shot_map(out, args.samples)
    finally:
        shutil.rmtree(TMP_DIR, ignore_errors=True)
    log(f'done in {time.time() - t0:.1f}s')


main()
