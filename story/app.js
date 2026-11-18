(() => {
'use strict';
const T = THREE, D = window.KZDATA, PI = Math.PI;
const V = (x = 0, y = 0, z = 0) => new T.Vector3(x, y, z);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const ease = t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const clock = () => performance.now() / 1000;
const Y = V(0, 1, 0);
let tNow = clock();

// ------------------------------------------------------------------ renderer
const canvas = document.getElementById('c');
const renderer = new T.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
const DPR = Math.min(window.devicePixelRatio || 1, 2);
renderer.setPixelRatio(DPR);
renderer.setSize(innerWidth, innerHeight);
const camera = new T.PerspectiveCamera(38, innerWidth / innerHeight, 0.005, 600);
function mkScene(fog) { const s = new T.Scene(); s.background = new T.Color(0x03060c); if (fog) s.fog = new T.FogExp2(0x03060c, fog); return s; }
const W = { globe: mkScene(0), map: mkScene(0.026), chart: mkScene(0.03) };
const composer = new T.EffectComposer(renderer);
composer.setPixelRatio(DPR);
composer.setSize(innerWidth, innerHeight);
const renderPass = new T.RenderPass(W.globe, camera);
composer.addPass(renderPass);
const bloom = new T.UnrealBloomPass(new T.Vector2(innerWidth, innerHeight), 0.85, 0.55, 0.72);
composer.addPass(bloom);
let active = 'globe';

// ------------------------------------------------------------------ helpers
function glowTex() {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d'), r = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(.18, 'rgba(255,255,255,.85)');
  r.addColorStop(.45, 'rgba(255,255,255,.22)'); r.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = r; g.fillRect(0, 0, 128, 128);
  return new T.CanvasTexture(c);
}
const GLOW = glowTex();
function sprite(color, size, op = 1) {
  const s = new T.Sprite(new T.SpriteMaterial({ map: GLOW, color, transparent: true, opacity: op, blending: T.AdditiveBlending, depthWrite: false }));
  s.scale.setScalar(size); return s;
}
function addStars(scene, n, r, size, op) {
  const p = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const u = Math.random() * 2 - 1, a = Math.random() * 2 * PI, rr = r * (1 + Math.random() * .6), s = Math.sqrt(1 - u * u);
    p[i * 3] = rr * s * Math.cos(a); p[i * 3 + 1] = rr * u; p[i * 3 + 2] = rr * s * Math.sin(a);
  }
  const g = new T.BufferGeometry(); g.setAttribute('position', new T.BufferAttribute(p, 3));
  scene.add(new T.Points(g, new T.PointsMaterial({ color: 0xb8cce8, size, sizeAttenuation: false, transparent: true, opacity: op, fog: false, depthWrite: false })));
}
for (const s of [W.globe, W.map]) { addStars(s, 3500, 150, 1.3, .7); addStars(s, 500, 150, 2.4, .9); }

function slerpV(a, b, t) {
  const d = clamp(a.dot(b), -1, 1), w = Math.acos(d);
  if (w < 1e-4) return a.clone().lerp(b, t);
  const s = Math.sin(w);
  return a.clone().multiplyScalar(Math.sin((1 - t) * w) / s).add(b.clone().multiplyScalar(Math.sin(t * w) / s));
}
function ll2v(lon, lat, r = 1) {
  const phi = (90 - lat) * PI / 180, th = (lon + 180) * PI / 180;
  return V(-r * Math.sin(phi) * Math.cos(th), r * Math.cos(phi), r * Math.sin(phi) * Math.sin(th));
}
const K = D.K, HR = D.R;
const mp = (lon, lat, y = 0) => V((lon - 68) * K, y, -(lat - 48));

// flowing tube material
const FLOW = [];
function flowMat(color, o = {}) {
  const m = new T.ShaderMaterial({
    uniforms: { uC: { value: new T.Color(color) }, uT: { value: 0 }, uP: { value: 0 }, uO: { value: 1 }, uDash: { value: o.dash || 6 }, uSp: { value: o.speed || .5 }, uI: { value: o.int || 1.3 }, uBase: { value: o.base == null ? .35 : o.base } },
    vertexShader: 'varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
    fragmentShader: 'uniform vec3 uC;uniform float uT,uP,uO,uDash,uSp,uI,uBase;varying vec2 vUv;void main(){float x=vUv.x;if(x>uP)discard;float f=uBase+(1.-uBase)*pow(fract(x*uDash-uT*uSp),3.);float head=smoothstep(uP-.035,uP,x)*(1.-step(.999,uP));gl_FragColor=vec4(uC*(f+head*2.5)*uI*uO,1.);}',
    transparent: true, blending: T.AdditiveBlending, depthWrite: false
  });
  FLOW.push(m); return m;
}
function tube(points, radius, mat, segs) {
  const curve = new T.CatmullRomCurve3(points, false, 'centripetal');
  const mesh = new T.Mesh(new T.TubeGeometry(curve, segs || Math.max(64, points.length * 3), radius, 8, false), mat);
  mesh.userData.curve = curve; return mesh;
}

// ------------------------------------------------------------------ registry (fade + grow + per-frame update)
const REG = [];
function reg(tags, obj, o = {}) {
  const mats = [];
  obj.traverse(x => {
    if (!x.material) return;
    (Array.isArray(x.material) ? x.material : [x.material]).forEach(m => {
      if (m.uniforms && m.uniforms.uO) mats.push({ m, b: 1, u: true });
      else { m.transparent = true; mats.push({ m, b: m.opacity, u: false }); }
    });
  });
  const it = Object.assign({ tags: [].concat(tags), obj, mats, cur: 0, tgt: 0, t0: 0 }, o);
  obj.visible = false; REG.push(it); return it;
}
function growTube(tags, mesh, delay, dur, extra = {}) {
  const it = reg(tags, mesh, extra);
  const u = mesh.material.uniforms.uP;
  const prev = it.update;
  it.update = (t, dt) => { u.value = ease(clamp((t - delay) / dur, 0, 1)); if (prev) prev(t, dt); };
  return it;
}
function updateReg(dt) {
  for (const it of REG) {
    const k = it.tgt > it.cur ? 2.4 : 3.6;
    it.cur += (it.tgt - it.cur) * Math.min(1, dt * k);
    if (Math.abs(it.cur - it.tgt) < .003) it.cur = it.tgt;
    it.obj.visible = it.cur > .003;
    if (!it.obj.visible) continue;
    for (const { m, b, u } of it.mats) { if (u) m.uniforms.uO.value = b * it.cur; else m.opacity = b * it.cur; }
    if (it.update) it.update(tNow - it.t0, dt);
  }
}
function flowSprites(curve, n, color, size, speed, op = 1) {
  const g = new T.Group(), ss = [];
  for (let i = 0; i < n; i++) { const s = sprite(color, size, op); g.add(s); ss.push(s); }
  g.userData.upd = (t, from = 0) => ss.forEach((s, i) => {
    const u = ((t * speed) + i / n) % 1; s.position.copy(curve.getPointAt(u));
    s.visible = t > from;
  });
  return g;
}

// ------------------------------------------------------------------ GLOBE
const globe = new T.Group(); W.globe.add(globe);
globe.add(new T.Mesh(new T.SphereGeometry(.995, 96, 64), new T.MeshBasicMaterial({ color: 0x050f1d })));
{
  const vs = 'varying vec3 vN;varying vec3 vV;void main(){vec4 mv=modelViewMatrix*vec4(position,1.);vN=normalize(normalMatrix*normal);vV=normalize(-mv.xyz);gl_Position=projectionMatrix*mv;}';
  globe.add(new T.Mesh(new T.SphereGeometry(1.003, 96, 64), new T.ShaderMaterial({
    vertexShader: vs, fragmentShader: 'varying vec3 vN;varying vec3 vV;void main(){float f=pow(1.-max(dot(vN,vV),0.),3.2);gl_FragColor=vec4(vec3(.18,.72,1.)*f*1.1,1.);}',
    transparent: true, blending: T.AdditiveBlending, depthWrite: false })));
  const halo = new T.Mesh(new T.SphereGeometry(1, 96, 64), new T.ShaderMaterial({
    vertexShader: vs, fragmentShader: 'varying vec3 vN;varying vec3 vV;void main(){float f=pow(max(-dot(vN,vV),0.),2.2);gl_FragColor=vec4(vec3(.15,.6,1.)*f*1.5,1.);}',
    side: T.BackSide, transparent: true, blending: T.AdditiveBlending, depthWrite: false }));
  halo.scale.setScalar(1.16); globe.add(halo);
}
const dotsMat = new T.ShaderMaterial({
  uniforms: { uT: { value: 0 }, uKZ: { value: 1 }, uRUS: { value: 0 }, uCHN: { value: 0 }, uLand: { value: 1 }, uSize: { value: 5 * DPR * innerHeight / 1000 } },
  vertexShader: `attribute float cid;attribute float rnd;uniform float uT,uKZ,uRUS,uCHN,uLand,uSize;varying vec3 vC;
  void main(){vec3 base=vec3(.2,.5,.7)*uLand;vec3 c=base;float s=1.;
  if(cid==1.){c=mix(base,vec3(1.,.74,.22)*1.7,uKZ);s=1.+.55*uKZ;}
  else if(cid==2.){c=mix(base,vec3(.95,.3,.3)*1.9,uRUS);}
  else if(cid==3.){c=mix(base,vec3(1.,.42,.25)*1.9,uCHN);}
  float tw=.72+.28*sin(uT*1.7+rnd*60.);vC=c*tw;
  vec4 mv=modelViewMatrix*vec4(position,1.);gl_PointSize=uSize*s/-mv.z;gl_Position=projectionMatrix*mv;}`,
  fragmentShader: 'varying vec3 vC;void main(){float r=length(gl_PointCoord-.5);if(r>.5)discard;gl_FragColor=vec4(vC*smoothstep(.5,.05,r),1.);}',
  transparent: true, blending: T.AdditiveBlending, depthWrite: false
});
{
  const d = D.dots, n = d.length / 3, pos = new Float32Array(n * 3), cid = new Float32Array(n), rnd = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = ll2v(d[i * 3], d[i * 3 + 1], 1.002);
    pos[i * 3] = v.x; pos[i * 3 + 1] = v.y; pos[i * 3 + 2] = v.z; cid[i] = d[i * 3 + 2]; rnd[i] = Math.random();
  }
  const g = new T.BufferGeometry();
  g.setAttribute('position', new T.BufferAttribute(pos, 3)); g.setAttribute('cid', new T.BufferAttribute(cid, 1)); g.setAttribute('rnd', new T.BufferAttribute(rnd, 1));
  globe.add(new T.Points(g, dotsMat));
  const lm = new T.LineBasicMaterial({ color: 0xffc845, transparent: true, opacity: .9, blending: T.AdditiveBlending, depthWrite: false });
  for (const ring of D.outline) globe.add(new T.Line(new T.BufferGeometry().setFromPoints(ring.map(([lo, la]) => ll2v(lo, la, 1.004))), lm));
}
const GU = { kz: 1, rus: 0, chn: 0, land: 1 }, GUt = Object.assign({}, GU);

const CITY = {
  astana: [71.43, 51.13], almaty: [76.95, 43.25], atyrau: [51.92, 47.1], aktau: [51.17, 43.65], khorgos: [80.4, 44.2],
  shymkent: [69.6, 42.3], karaganda: [73.1, 49.8], tengiz: [53.38, 46.15], baku: [49.87, 40.41], rome: [12.5, 41.9],
  beijing: [116.4, 39.9], moscow: [37.6, 55.75], amsterdam: [4.9, 52.37], london: [-0.12, 51.5], newyork: [-74, 40.7],
  xian: [108.9, 34.3], duisburg: [6.76, 51.43], istanbul: [29, 41], kzc: [67.5, 48.2]
};
function gPin(tags, ll, color, size = .05) {
  const g = new T.Group(); const p = ll2v(ll[0], ll[1], 1.006);
  const s = sprite(color, size); s.position.copy(p); g.add(s);
  const c = sprite(0xffffff, size * .35); c.position.copy(p); g.add(c);
  const it = reg(tags, g);
  it.update = t => { const k = 1 + .25 * Math.sin(t * 3); s.scale.setScalar(size * k); };
  globe.add(g); return it;
}
function arcPts(a, b, h, n = 120) {
  const va = ll2v(a[0], a[1]), vb = ll2v(b[0], b[1]), pts = [];
  for (let i = 0; i < n; i++) { const t = i / (n - 1); pts.push(slerpV(va, vb, t).multiplyScalar(1.004 + h * Math.sin(PI * t))); }
  return pts;
}
function pathPts(wps, alt = 1.007, step = .5) {
  const pts = [];
  for (let i = 0; i < wps.length - 1; i++) {
    const a = ll2v(...wps[i]), b = ll2v(...wps[i + 1]), n = Math.max(2, Math.ceil(a.angleTo(b) * 180 / PI / step));
    for (let j = 0; j < n; j++) pts.push(slerpV(a, b, j / n).multiplyScalar(alt));
  }
  pts.push(ll2v(...wps[wps.length - 1], alt)); return pts;
}
function gArc(tags, a, b, color, delay, o = {}) {
  const ang = ll2v(...a).angleTo(ll2v(...b));
  const m = tube(arcPts(a, b, o.h != null ? o.h : .05 + .32 * ang / PI), o.r || .0045, flowMat(color, o), 160);
  globe.add(m);
  const it = growTube(tags, m, delay, o.dur || 1.6);
  if (o.flow) {
    const fs = flowSprites(m.userData.curve, o.flow, o.fc || color, o.fs || .035, o.fsp || .22);
    m.add(fs); const prev = it.update;
    it.update = (t, dt) => { prev(t, dt); fs.userData.upd(t, delay + (o.dur || 1.6) * .8); };
  }
  return it;
}
// slide 2 pins
gPin(['heart'], CITY.astana, 0xffc845, .06); gPin(['heart'], CITY.almaty, 0xffc845, .06);
// slide 6 trade arcs
const TR = CITY.kzc;
gArc('trade', TR, CITY.rome, 0xffc845, .3, { flow: 5, fc: 0xffe39a, int: 1.5 });
gArc('trade', TR, CITY.beijing, 0xffc845, .7, { flow: 5, fc: 0xffe39a, int: 1.5 });
gArc('trade', TR, CITY.moscow, 0xffc845, 1.1, { flow: 5, fc: 0xffe39a, int: 1.5 });
gArc('trade', TR, CITY.amsterdam, 0x35d0e6, 1.5, { int: .8, r: .003 });
gArc('trade', TR, [32.9, 39.9], 0x35d0e6, 1.7, { int: .8, r: .003 });
gArc('trade', TR, [69.2, 41.3], 0x35d0e6, 1.9, { int: .8, r: .003, h: .03 });
['rome', 'beijing', 'moscow'].forEach(k => gPin('trade', CITY[k], 0xffc845, .05));
// slide 9 paradox: profits flowing out
[['amsterdam', .4], ['london', .8], ['newyork', 1.2], ['beijing', 1.6]].forEach(([k, d]) =>
  gArc('paradox', CITY.atyrau, CITY[k], 0xff5a5f, d, { flow: 9, fc: 0xffc845, fs: .045, fsp: .28, int: 1.1, dash: 10 }));
gPin('paradox', CITY.atyrau, 0xff5a5f, .07);
// slide 12 corridor
const RAIL_E = [CITY.xian, [103.8, 36.1], [95.8, 40.4], [87.6, 43.8], CITY.khorgos, CITY.almaty, [73.4, 42.9], CITY.shymkent, [66.0, 44.8], [61.0, 45.6], [56.0, 44.6], CITY.aktau];
const SEA = [CITY.aktau, [50.4, 42.2], CITY.baku];
const RAIL_W = [CITY.baku, [44.8, 41.7], [43.1, 40.6], [32.9, 39.9], CITY.istanbul, [23.3, 42.7], [16.4, 48.2], CITY.duisburg];
const NORTH = [[87.6, 43.8], [82.5, 45.2], [76.9, 50.4], CITY.astana, [69.1, 54.9], [55.9, 54.7], CITY.moscow, [27.6, 53.9], [23.7, 52.1], [13.4, 52.5], CITY.duisburg];
const corrRail = tube(pathPts(RAIL_E), .005, flowMat(0xffc845, { dash: 30, speed: .9, int: 1.6 }));
const corrSea = tube(pathPts(SEA, 1.004), .005, flowMat(0x35d0e6, { dash: 12, speed: .9, base: .15, int: 1.8 }));
const corrW = tube(pathPts(RAIL_W), .005, flowMat(0xffc845, { dash: 30, speed: .9, int: 1.6 }));
const corrN = tube(pathPts(NORTH), .0032, flowMat(0xff5a5f, { dash: 40, speed: .3, int: .55, base: .5 }));
[corrRail, corrSea, corrW, corrN].forEach(m => globe.add(m));
growTube('corridor', corrN, .2, 1.4);
growTube('corridor', corrRail, .9, 2.4);
growTube('corridor', corrSea, 3.2, 1.0);
growTube('corridor', corrW, 4.1, 1.6);
['khorgos', 'aktau', 'baku'].forEach(k => gPin('corridor', CITY[k], 0xffc845, .055));
{
  const full = new T.CatmullRomCurve3(pathPts([...RAIL_E, ...SEA.slice(1), ...RAIL_W.slice(1)]), false, 'centripetal');
  const g = new T.Group();
  const train = sprite(0xffffff, .07), halo = sprite(0xffc845, .16);
  const trail = []; for (let i = 0; i < 10; i++) { const s = sprite(0xffc845, .05 * (1 - i / 12), .6 * (1 - i / 10)); trail.push(s); g.add(s); }
  g.add(halo, train);
  const it = reg('corridor', g);
  it.update = t => {
    const u = ((t - 2.2) / 9) % 1; const on = t > 2.2;
    g.visible = g.visible && on;
    if (!on) return;
    const p = full.getPointAt(Math.max(0, u)); train.position.copy(p); halo.position.copy(p);
    trail.forEach((s, i) => s.position.copy(full.getPointAt(Math.max(0, u - (i + 1) * .006))));
    const sea = u > .55 && u < .66; halo.material.color.set(sea ? 0x35d0e6 : 0xffc845);
  };
  globe.add(g);
}
// slide 15 crossroads
[[CITY.rome, 0xffc845], [CITY.beijing, 0xffc845], [CITY.moscow, 0x35d0e6], [CITY.duisburg, 0x35d0e6], [CITY.istanbul, 0xffc845],
 [[77.2, 28.6], 0x35d0e6], [[55.3, 25.2], 0xffc845], [[139.7, 35.7], 0x35d0e6], [[126.98, 37.57], 0xffc845], [[103.8, 1.35], 0x35d0e6], [[-74, 40.7], 0xffc845]]
  .forEach(([c, col], i) => gArc('close', CITY.kzc, c, col, .4 + i * .18, { flow: 4, fs: .03, int: 1.2 }));

// ------------------------------------------------------------------ MAP (hex columns)
const H = {};
{
  const M = W.map;
  M.add(new T.HemisphereLight(0xbfd9ff, 0x0a0f16, .55));
  M.add(new T.AmbientLight(0xffffff, .12));
  const dl = new T.DirectionalLight(0xfff1d6, 1.0); dl.position.set(-6, 12, 9); M.add(dl);
  const ground = new T.Mesh(new T.PlaneGeometry(400, 400), new T.MeshStandardMaterial({ color: 0x050b14, roughness: .95 }));
  ground.rotation.x = -PI / 2; ground.position.y = -.02; M.add(ground);
  const grid = new T.GridHelper(160, 320, 0x0f2a3d, 0x0a1a28); grid.position.y = -.015;
  grid.material.transparent = true; grid.material.opacity = .45; M.add(grid);

  const a = D.hex, n = a.length / 3; H.n = n;
  H.x = new Float32Array(n); H.z = new Float32Array(n); H.code = new Uint8Array(n); H.lon = new Float32Array(n); H.lat = new Float32Array(n); H.rnd = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    H.x[i] = a[i * 3]; H.z[i] = a[i * 3 + 1]; H.code[i] = a[i * 3 + 2];
    H.lon[i] = H.x[i] / K + 68; H.lat[i] = 48 - H.z[i];
    const s = Math.sin(i * 12.9898 + H.x[i] * 78.233) * 43758.5453; H.rnd[i] = s - Math.floor(s);
  }
  H.h = new Float32Array(n).fill(.02); H.th = new Float32Array(n);
  H.col = new Float32Array(n * 3); H.tcol = new Float32Array(n * 3); H.glow = new Float32Array(n * 3); H.tglow = new Float32Array(n * 3);
  H.delay = new Float32Array(n); H.t0 = 0;
  const geo = new T.CylinderGeometry(HR * .93, HR * .93, 1, 6, 1); geo.translate(0, .5, 0);
  H.mesh = new T.InstancedMesh(geo, new T.MeshStandardMaterial({ roughness: .55, metalness: .12, flatShading: true }), n);
  H.caps = new T.InstancedMesh(new T.CylinderGeometry(HR * .93, HR * .93, .016, 6, 1),
    new T.MeshBasicMaterial({ color: 0xffffff, transparent: true, blending: T.AdditiveBlending, depthWrite: false }), n);
  for (const m of [H.mesh, H.caps]) {
    m.instanceMatrix.setUsage(T.DynamicDrawUsage);
    m.instanceColor = new T.InstancedBufferAttribute(new Float32Array(n * 3), 3); m.instanceColor.setUsage(T.DynamicDrawUsage);
    const arr = m.instanceMatrix.array; for (let i = 0; i < n; i++) { arr[i * 16] = arr[i * 16 + 5] = arr[i * 16 + 10] = arr[i * 16 + 15] = 1; }
    m.frustumCulled = false; M.add(m);
  }
}
const g2 = (lon, lat, a, b, sx, sy) => Math.exp(-(((lon - a) / sx) ** 2) - (((lat - b) / sy) ** 2));
function mount(lon, lat) {
  return g2(lon, lat, 77, 43.0, 2.6, .65) + g2(lon, lat, 80.6, 45.2, 1.4, .55) * .75 + g2(lon, lat, 84.8, 49.4, 1.5, .9) * .85
    + g2(lon, lat, 69.6, 43.4, 1.1, .45) * .35 + g2(lon, lat, 74.5, 49.3, 3.2, 1.4) * .18 + g2(lon, lat, 72.5, 42.6, 1.8, .5) * .6;
}
const C3 = h => { const c = new T.Color(h); return [c.r, c.g, c.b]; };
const mix3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const mul3 = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const DESERT = [.4, .31, .18], STEPPE = [.13, .27, .19], SNOW = [.62, .68, .74], WATER = [.04, .22, .4], NB = [.075, .1, .14], DIM = [.07, .1, .13];
function landCol(i) {
  const lon = H.lon[i], lat = H.lat[i], m = mount(lon, lat);
  return mul3(mix3(mix3(DESERT, STEPPE, sstep(43.5, 51, lat)), SNOW, sstep(.45, 1, m)), .85 + .25 * H.rnd[i]);
}
function nbH(i) { return .05 + mount(H.lon[i], H.lat[i]) * .55 + .02 * H.rnd[i]; }
function setT(i, h, col, glow, delay) {
  H.th[i] = h; H.tcol.set(col, i * 3); H.tglow.set(glow || [0, 0, 0], i * 3); H.delay[i] = delay || 0;
}
const ECON = [[76.95, 43.25, 1.5], [71.43, 51.13, 1.3], [69.6, 42.3, .8], [51.92, 47.1, .9], [73.1, 49.8, .6], [57.2, 50.28, .5], [76.95, 52.3, .45], [82.6, 49.95, .45],
  [51.17, 43.65, .5], [65.5, 44.85, .35], [71.37, 42.9, .35], [63.6, 53.2, .35], [51.37, 51.23, .3], [80.25, 50.4, .3]];
const OIL = [[53.38, 46.15, 1, .55, .5], [53.0, 51.35, .6, .5, .4], [52.8, 43.35, .45, .5, .4], [65.5, 46.4, .35, .5, .4], [57.5, 48.0, .3, .5, .4], [52, 47, .15, 2.5, 1.5]];
const VAL = [[67.7, 47.8, .9], [73.1, 49.8, .8], [75.0, 46.85, .6], [76.95, 52.3, .65], [82.6, 49.95, .7], [68.0, 44.9, .6]];
const oilV = (lon, lat) => OIL.reduce((s, [a, b, w, sx, sy]) => s + w * g2(lon, lat, a, b, sx, sy), 0);
const valV = (lon, lat) => VAL.reduce((s, [a, b, w]) => s + w * g2(lon, lat, a, b, .55, .42), 0);
function setMode(mode) {
  H.t0 = tNow; H.mode = mode;
  for (let i = 0; i < H.n; i++) {
    const c = H.code[i], lon = H.lon[i], lat = H.lat[i], r = H.rnd[i];
    if (c === 0) continue;
    if (c === 2) { setT(i, nbH(i), mul3(NB, .8 + .4 * r), null, .2 * r); continue; }
    if (c === 4) { setT(i, .03, WATER, [.03, .2, .26], .2 * r); continue; }
    const aralDry = [.66, .56, .38];
    if (mode === 'land') {
      if (c === 3) {
        const e = Math.sqrt(((lon - 59.9) / 2.25) ** 2 + ((lat - 45.15) / 1.55) ** 2);
        setT(i, .05 + .03 * r, mul3(aralDry, .85 + .2 * r), null, 1.4 + (1 - e) * 4.2 + r * .4);
      } else setT(i, .12 + .05 * r + mount(lon, lat) * 1.25, landCol(i), null, 0);
    } else if (mode === 'econ') {
      const v = Math.min(1.6, ECON.reduce((s, [a, b, w]) => s + w * g2(lon, lat, a, b, .85, .65), 0));
      const k = clamp(v, 0, 1);
      setT(i, .1 + v * 1.7 + .03 * r, mix3([.1, .25, .32], [.18, .8, .92], k), mul3([.15, .75, .95], Math.pow(k, 1.6) * 1.5),
        .1 + Math.hypot(lon - 68, (lat - 48) * 1.4) * .055 + r * .15);
    } else if (mode === 'oil') {
      const v = oilV(lon, lat), k = clamp(v * 1.1, 0, 1);
      setT(i, .05 + v * 3.3 + (lon < 58 ? .08 : 0), mix3(lon < 58 ? [.1, .08, .05] : DIM, [.95, .62, .12], k), mul3([1, .55, .08], Math.pow(k, 1.7) * 2.2),
        .1 + Math.hypot(lon - 53.4, lat - 46.2) * .07 + r * .15);
    } else if (mode === 'value' || mode === 'value2') {
      const v = valV(lon, lat), k = clamp(v * 1.3, 0, 1), two = mode === 'value2';
      setT(i, .05 + v * (two ? 2.9 : 2.0) + .02 * r, mix3(DIM, two ? [.3, .85, .95] : [.62, .32, .16], k),
        mul3(two ? [.3, .9, 1] : [.9, .4, .15], Math.pow(k, 1.5) * (two ? 2.3 : 1.4)),
        two ? .05 + r * .5 : .1 + r * .6 + (1 - k) * .3);
    }
  }
}
function snapHex() { H.h.set(H.th); H.col.set(H.tcol); H.glow.set(H.tglow); }
function updateHex(dt) {
  const k = 1 - Math.exp(-dt * 2.6), el = tNow - H.t0;
  const m = H.mesh.instanceMatrix.array, c = H.mesh.instanceColor.array, m2 = H.caps.instanceMatrix.array, c2 = H.caps.instanceColor.array;
  for (let i = 0; i < H.n; i++) {
    if (H.code[i] === 0) { m[i * 16 + 5] = 0; m2[i * 16] = 0; continue; }
    if (el > H.delay[i]) {
      H.h[i] += (H.th[i] - H.h[i]) * k;
      for (let j = 0; j < 3; j++) { const q = i * 3 + j; H.col[q] += (H.tcol[q] - H.col[q]) * k; H.glow[q] += (H.tglow[q] - H.glow[q]) * k; }
    }
    const h = Math.max(H.h[i], .004), o = i * 16;
    m[o + 5] = h; m[o + 12] = H.x[i]; m[o + 14] = H.z[i];
    m2[o + 12] = H.x[i]; m2[o + 13] = h + .009; m2[o + 14] = H.z[i];
    c[i * 3] = H.col[i * 3]; c[i * 3 + 1] = H.col[i * 3 + 1]; c[i * 3 + 2] = H.col[i * 3 + 2];
    c2[i * 3] = H.glow[i * 3]; c2[i * 3 + 1] = H.glow[i * 3 + 1]; c2[i * 3 + 2] = H.glow[i * 3 + 2];
  }
  H.mesh.instanceMatrix.needsUpdate = H.caps.instanceMatrix.needsUpdate = true;
  H.mesh.instanceColor.needsUpdate = H.caps.instanceColor.needsUpdate = true;
}
function nearestHex(lon, lat) {
  const p = mp(lon, lat); let best = 0, bd = 1e9;
  for (let i = 0; i < H.n; i++) { const d = (H.x[i] - p.x) ** 2 + (H.z[i] - p.z) ** 2; if (d < bd) { bd = d; best = i; } }
  return best;
}
const topAt = (lon, lat, add = .25) => { const i = nearestHex(lon, lat); return () => mp(lon, lat, H.h[i] + add); };
// oil flames
[[53.38, 46.15, 1.1], [53.0, 51.35, .7], [52.8, 43.35, .6]].forEach(([lon, lat, s]) => {
  const g = new T.Group(); const f1 = sprite(0xff8a1c, s), f2 = sprite(0xffe6a8, s * .4); g.add(f1, f2); W.map.add(g);
  const pos = topAt(lon, lat, .3);
  const it = reg('oil', g);
  it.update = t => {
    const k = sstep(2.2, 3.4, t) * (1 + .18 * Math.sin(t * 13 + s * 9) + .1 * Math.sin(t * 23));
    f1.scale.setScalar(s * k); f2.scale.setScalar(s * .4 * k); g.position.copy(pos());
  };
});
// processing glow on value sites
VAL.forEach(([lon, lat, w], j) => {
  const s = sprite(0x7fe8ff, .9 * w), pos = topAt(lon, lat, .15); W.map.add(s);
  const it = reg('value', s);
  it.update = t => { s.position.copy(pos()); s.material.opacity *= sstep(3.4 + j * .15, 4.4 + j * .15, t) * (.75 + .25 * Math.sin(t * 2 + j)); };
});

// ------------------------------------------------------------------ CHART world
const CH = W.chart;
{
  CH.add(new T.HemisphereLight(0xbfd9ff, 0x0a0f16, .5));
  CH.add(new T.AmbientLight(0xffffff, .1));
  const dl = new T.DirectionalLight(0xfff1d6, 1.1); dl.position.set(5, 10, 8); CH.add(dl);
  const fl = new T.Mesh(new T.CircleGeometry(60, 64), new T.MeshStandardMaterial({ color: 0x060c14, roughness: .85, metalness: .2 }));
  fl.rotation.x = -PI / 2;
  const grid = new T.GridHelper(80, 80, 0x123247, 0x0b1c2a); grid.position.y = .002; grid.material.transparent = true; grid.material.opacity = .5;
}
const std = (color, emissive = 0x000000, ei = 0, o = {}) => new T.MeshStandardMaterial(Object.assign({ color, emissive, emissiveIntensity: ei, roughness: .4, metalness: .25 }, o));
const addMat = color => new T.MeshBasicMaterial({ color, transparent: true, blending: T.AdditiveBlending, depthWrite: false });
// inflation bars
const BARS = [['2024', 8.6], ['Dec 2025', 12.3], ['Aug 2026', 9.8], ['Sep 2026', 9.3], ['Target', 5.0]], BK = .38;
const barObjs = [];
{
  const g = new T.Group(); CH.add(g);
  BARS.forEach(([lab, v], i) => {
    const geo = new T.BoxGeometry(1.25, 1, 1.25); geo.translate(0, .5, 0);
    const col = i === 4 ? 0x35d0e6 : i === 1 ? 0xff3b47 : 0xa8343a;
    const m = new T.Mesh(geo, std(col, col, i === 1 ? .55 : i === 4 ? .7 : .12));
    m.position.x = -4.4 + i * 2.2; m.scale.y = .001; g.add(m); barObjs.push(m);
    const cap = new T.Mesh(new T.BoxGeometry(1.27, .03, 1.27), addMat(i === 4 ? 0x7ff0ff : 0xff8088)); m.add(cap); cap.position.y = 1;
  });
  const tl = new T.Mesh(new T.BoxGeometry(11.6, .035, .035), addMat(0x35d0e6)); tl.position.set(0, 5 * BK, .7); g.add(tl);
  const tp = new T.Mesh(new T.PlaneGeometry(11.6, 1.6), addMat(0x0b4450)); tp.rotation.x = -PI / 2; tp.position.set(0, 5 * BK, 0); tp.material.opacity = .35; g.add(tp);
  const it = reg('bars', g);
  it.update = t => {
    barObjs.forEach((m, i) => { const e = ease(clamp((t - .5 - i * .38) / 1.2, 0, 1)); m.scale.y = Math.max(.001, BARS[i][1] * BK * e); });
    tl.scale.x = ease(clamp((t - 2.6) / 1.2, 0, 1)) + .001; tp.scale.x = tl.scale.x;
  };
}
// ---- 3D icon builders
const GOLD = () => std(0xffc845, 0xb87a10, .25, { metalness: .9, roughness: .25 });
function tengeCoin(r, th) {
  const g = new T.Group(), gold = GOLD();
  const c = new T.Mesh(new T.CylinderGeometry(r, r, th, 64), gold); c.rotation.x = PI / 2; g.add(c);
  g.add(new T.Mesh(new T.TorusGeometry(r * .96, th * .22, 10, 64), gold));
  const sym = std(0xfff3c8, 0xffc845, .7, { metalness: .5, roughness: .3 });
  for (const z of [th / 2 + .012, -(th / 2 + .012)]) {
    const b1 = new T.Mesh(new T.BoxGeometry(r * 1.0, r * .15, .03), sym); b1.position.set(0, r * .44, z);
    const b2 = new T.Mesh(new T.BoxGeometry(r * 1.0, r * .15, .03), sym); b2.position.set(0, r * .16, z);
    const st = new T.Mesh(new T.BoxGeometry(r * .17, r * .76, .03), sym); st.position.set(0, -r * .21, z);
    g.add(b1, b2, st);
  }
  g.userData.emi = [gold, sym]; return g;
}
function barrel() {
  const g = new T.Group();
  const body = std(0x15191f, 0x000000, 0, { metalness: .75, roughness: .3 });
  const ring = std(0xffc845, 0xffa514, .2, { metalness: .9, roughness: .25 });
  g.add(new T.Mesh(new T.CylinderGeometry(.42, .42, 1.05, 40), body));
  for (const y of [-.5, -.18, .18, .5]) { const t = new T.Mesh(new T.TorusGeometry(.425, .028, 8, 48), ring); t.rotation.x = PI / 2; t.position.y = y; g.add(t); }
  const drop = new T.Mesh(new T.SphereGeometry(.13, 24, 16), std(0x0b0b0b, 0xffa514, .1, { metalness: 1, roughness: .05 })); drop.scale.set(1, 1.35, 1); drop.position.y = .82; g.add(drop);
  const tip = new T.Mesh(new T.ConeGeometry(.095, .2, 24), drop.material); tip.position.y = 1.0; g.add(tip);
  g.userData.emi = [ring]; return g;
}
function container() {
  const g = new T.Group();
  const body = std(0x1a6f8c, 0x35d0e6, .05, { metalness: .5, roughness: .45 });
  g.add(new T.Mesh(new T.BoxGeometry(1.3, .62, .6), body));
  const rib = std(0x2a8fb0, 0x35d0e6, .05, { metalness: .5, roughness: .4 });
  for (let i = 0; i < 11; i++) { const b = new T.Mesh(new T.BoxGeometry(.035, .58, .63), rib); b.position.x = -.6 + i * .12; g.add(b); }
  const tag = new T.Group(); tag.position.set(0, .72, 0); g.add(tag);
  const red = std(0xff3b47, 0xff2030, .6);
  const sh = new T.Mesh(new T.CylinderGeometry(.06, .06, .32, 16), red); tag.add(sh);
  const hd = new T.Mesh(new T.ConeGeometry(.16, .22, 24), red); hd.position.y = .27; tag.add(hd);
  g.userData.tag = tag; g.userData.emi = [body, rib, red]; return g;
}
function upArrow() {
  const g = new T.Group(), red = std(0xff3b47, 0xff2030, .4, { metalness: .4, roughness: .25 });
  const sh = new T.Mesh(new T.CylinderGeometry(.14, .14, .85, 24), red); sh.position.y = -.1; g.add(sh);
  const hd = new T.Mesh(new T.ConeGeometry(.36, .5, 32), red); hd.position.y = .55; g.add(hd);
  const pct = new T.Group(); pct.position.set(.62, -.05, 0); g.add(pct);
  const pm = std(0xffd0d2, 0xff5a5f, .5);
  const r1 = new T.Mesh(new T.TorusGeometry(.08, .03, 8, 24), pm); r1.position.set(-.1, .13, 0);
  const r2 = new T.Mesh(new T.TorusGeometry(.08, .03, 8, 24), pm); r2.position.set(.1, -.13, 0);
  const sl = new T.Mesh(new T.BoxGeometry(.04, .42, .04), pm); sl.rotation.z = -.55;
  pct.add(r1, r2, sl);
  g.userData.emi = [red, pm]; return g;
}
function gearGeo(R, r, teeth, depth) {
  const s = new T.Shape(), n = teeth * 4;
  for (let i = 0; i <= n; i++) {
    const a = i / n * PI * 2, rad = (i % 4 === 1 || i % 4 === 2) ? R : r;
    const x = Math.cos(a) * rad, y = Math.sin(a) * rad;
    if (i === 0) s.moveTo(x, y); else s.lineTo(x, y);
  }
  const hole = new T.Path(); hole.absarc(0, 0, r * .38, 0, PI * 2, true); s.holes.push(hole);
  const geo = new T.ExtrudeGeometry(s, { depth, bevelEnabled: true, bevelSize: .02, bevelThickness: .02, bevelSegments: 1 });
  geo.center(); return geo;
}
function coinStack() {
  const g = new T.Group(), gold = GOLD();
  for (let i = 0; i < 6; i++) { const c = new T.Mesh(new T.CylinderGeometry(.48, .48, .09, 48), gold); c.position.set(Math.sin(i * 2.1) * .04, .05 + i * .095, Math.cos(i * 1.7) * .04); g.add(c); }
  const big = tengeCoin(.55, .1); big.position.y = 1.25; g.add(big);
  g.userData.spin = big; g.userData.emi = big.userData.emi.concat([gold]); return g;
}
function trainModel() {
  const g = new T.Group();
  const metal = std(0x8a96a3, 0x000000, 0, { metalness: .85, roughness: .3 }), dark = std(0x111820, 0, 0, { metalness: .6, roughness: .5 });
  const body = std(0x1a6f8c, 0x35d0e6, .08, { metalness: .55, roughness: .35 }), gold = GOLD();
  for (const z of [-.24, .24]) { const r = new T.Mesh(new T.BoxGeometry(2.3, .04, .05), metal); r.position.set(0, .02, z); g.add(r); }
  for (let i = 0; i < 9; i++) { const s = new T.Mesh(new T.BoxGeometry(.1, .03, .72), dark); s.position.set(-1.05 + i * .26, 0, 0); g.add(s); }
  const b = new T.Mesh(new T.BoxGeometry(1.05, .42, .52), body); b.position.set(-.15, .42, 0); g.add(b);
  const cab = new T.Mesh(new T.BoxGeometry(.42, .36, .54), body); cab.position.set(-.48, .8, 0); g.add(cab);
  const roof = new T.Mesh(new T.BoxGeometry(.5, .05, .62), gold); roof.position.set(-.48, 1.0, 0); g.add(roof);
  const boil = new T.Mesh(new T.CylinderGeometry(.23, .23, .62, 32), body); boil.rotation.z = PI / 2; boil.position.set(.5, .48, 0); g.add(boil);
  const nose = new T.Mesh(new T.CylinderGeometry(.24, .24, .05, 32), gold); nose.rotation.z = PI / 2; nose.position.set(.82, .48, 0); g.add(nose);
  const ch = new T.Mesh(new T.CylinderGeometry(.07, .09, .28, 16), dark); ch.position.set(.55, .82, 0); g.add(ch);
  const stripe = new T.Mesh(new T.BoxGeometry(1.06, .05, .53), gold); stripe.position.set(-.15, .34, 0); g.add(stripe);
  const wheels = [];
  for (const x of [-.5, -.1, .3, .62]) for (const z of [-.27, .27]) { const w = new T.Mesh(new T.CylinderGeometry(.13, .13, .05, 24), dark); w.rotation.x = PI / 2; w.position.set(x, .15, z); g.add(w); wheels.push(w); }
  const light = sprite(0xffe39a, .6); light.position.set(.88, .48, 0); g.add(light);
  g.userData.wheels = wheels; g.userData.emi = [body, gold]; return g;
}
function factoryModel() {
  const g = new T.Group();
  const wall = std(0x2a3440, 0, 0, { metalness: .3, roughness: .6 }), roofM = std(0x3b4756, 0, 0, { metalness: .4, roughness: .5 });
  const win = std(0x35d0e6, 0x35d0e6, .9);
  const b = new T.Mesh(new T.BoxGeometry(1.4, .55, .8), wall); b.position.y = .28; g.add(b);
  for (let i = 0; i < 3; i++) {
    const r = new T.Mesh(new T.CylinderGeometry(.27, .27, .8, 3), roofM); r.rotation.x = PI / 2; r.rotation.y = 0; r.rotation.z = PI / 2 + .25; r.position.set(-.45 + i * .45, .64, 0); g.add(r);
  }
  for (let i = 0; i < 4; i++) { const w = new T.Mesh(new T.BoxGeometry(.2, .14, .02), win); w.position.set(-.48 + i * .32, .3, .41); g.add(w); }
  const ch = new T.Mesh(new T.CylinderGeometry(.09, .12, 1.0, 20), wall); ch.position.set(.55, .95, -.2); g.add(ch);
  const band = new T.Mesh(new T.TorusGeometry(.1, .02, 8, 24), win); band.rotation.x = PI / 2; band.position.set(.55, 1.25, -.2); g.add(band);
  const gear = new T.Mesh(gearGeo(.42, .33, 12, .1), GOLD()); gear.position.set(-.35, 1.15, .1); g.add(gear);
  const gear2 = new T.Mesh(gearGeo(.24, .18, 8, .09), std(0x35d0e6, 0x35d0e6, .5, { metalness: .8, roughness: .3 })); gear2.position.set(.08, 1.43, .1); g.add(gear2);
  const smoke = []; for (let i = 0; i < 5; i++) { const s = sprite(0x8fa6b8, .35, .35); g.add(s); smoke.push(s); }
  g.userData.gears = [gear, gear2]; g.userData.smoke = smoke; g.userData.emi = [win, gear.material, gear2.material]; return g;
}
// root cause chain (3D symbols)
const NODES = [V(-6, 1, .2), V(-2, 1, -.6), V(2, 1, -.6), V(6, 1, .2)];
{
  const g = new T.Group(); CH.add(g);
  const icons = [barrel(), tengeCoin(.6, .12), container(), upArrow()];
  icons.forEach((ic, i) => {
    ic.position.copy(NODES[i]); g.add(ic);
    const pad = new T.Mesh(new T.RingGeometry(.75, .82, 64), addMat(i === 3 ? 0xff5a5f : 0xffc845)); pad.rotation.x = -PI / 2; pad.position.set(NODES[i].x, .02, NODES[i].z); g.add(pad);
    ic.userData.pad = pad;
    ic.userData.base = ic.userData.emi.map(m => m.emissiveIntensity);
  });
  const links = [];
  for (let i = 0; i < 3; i++) {
    const a = NODES[i].clone().add(V(.7, .3, 0)), b = NODES[i + 1].clone().add(V(-.7, .3, 0)), mid = a.clone().lerp(b, .5).add(V(0, .9, 0));
    const m = tube([a, mid, b], .045, flowMat(i === 2 ? 0xff5a5f : 0xffc845, { dash: 5, speed: 1.2, int: 1.8 }), 80);
    g.add(m); links.push(m);
  }
  const it = reg('chain', g);
  it.update = t => {
    icons.forEach((ic, i) => {
      const on = sstep(.8 + i * 1.15, 1.4 + i * 1.15, t), pop = 1 + .25 * Math.exp(-Math.pow((t - 1.1 - i * 1.15) * 4, 2));
      ic.scale.setScalar(Math.max(.001, on * pop));
      ic.userData.emi.forEach((m, k) => { m.emissiveIntensity = ic.userData.base[k] + on * .6; });
      ic.userData.pad.material.opacity *= on;
      ic.position.y = NODES[i].y + .08 * Math.sin(t * 1.5 + i);
      if (i === 0) ic.rotation.y = t * .5;
      if (i === 1) ic.rotation.y = t * 1.6;
      if (i === 2) { ic.rotation.y = -.5 + .3 * Math.sin(t * .7); ic.userData.tag.position.y = .72 + .12 * Math.abs(Math.sin(t * 3)); }
      if (i === 3) { ic.rotation.y = .4 * Math.sin(t * .8); ic.position.y += .15 * Math.abs(Math.sin(t * 2.4)); }
    });
    links.forEach((m, i) => { m.material.uniforms.uP.value = ease(clamp((t - 1.2 - i * 1.15) / .8, 0, 1)); });
  };
}
// three pedestals with 3D symbols
const PIL = [-4.6, 0, 4.6];
{
  const g = new T.Group(); CH.add(g);
  const models = [coinStack(), trainModel(), factoryModel()];
  const ps = models.map((mdl, i) => {
    const p = new T.Group(); p.position.x = PIL[i]; g.add(p);
    const ped = new T.Mesh(new T.CylinderGeometry(1.15, 1.3, .35, 6), std(0x0d1824, 0xffc845, .05, { metalness: .7, roughness: .35, flatShading: true }));
    ped.position.y = .175; p.add(ped);
    const rim = new T.Mesh(new T.TorusGeometry(1.17, .02, 8, 6), addMat(0xffc845)); rim.rotation.x = PI / 2; rim.rotation.z = PI / 6; rim.position.y = .36; p.add(rim);
    const glow = sprite(0xffc845, 3.2, .18); glow.position.y = 1.4; p.add(glow);
    mdl.position.y = .36; mdl.scale.setScalar(1.25); p.add(mdl);
    return { p, mdl };
  });
  const it = reg('pillars', g);
  it.update = t => ps.forEach(({ p, mdl }, i) => {
    const e = ease(clamp((t - .5 - i * .45) / 1.4, 0, 1)); p.position.y = -4.2 * (1 - e);
    mdl.position.y = .36 + .06 * Math.sin(t * 1.4 + i);
    if (i === 0) { mdl.rotation.y = .3 * Math.sin(t * .6); mdl.userData.spin.rotation.y = t * 1.4; }
    if (i === 1) { mdl.rotation.y = -.6 + .45 * Math.sin(t * .5); mdl.userData.wheels.forEach(w => w.rotation.y = t * 4); }
    if (i === 2) {
      mdl.rotation.y = .35 * Math.sin(t * .5);
      mdl.userData.gears[0].rotation.z = t * .8; mdl.userData.gears[1].rotation.z = -t * 1.25;
      mdl.userData.smoke.forEach((s, k) => { const u = (t * .35 + k / 5) % 1; s.position.set(.55 + u * .25, 1.5 + u * 1.1, -.2); s.scale.setScalar(.25 + u * .5); s.material.opacity *= (1 - u) * .8; });
    }
  });
}
// Baiterek + National Fund
{
  const g = new T.Group(); CH.add(g);
  const white = std(0xaab4bd, 0x000000, 0, { roughness: .45, metalness: .15 });
  const base = new T.Mesh(new T.CylinderGeometry(.75, 1.25, .35, 32), white); base.position.y = .175; g.add(base);
  const trunk = new T.Mesh(new T.CylinderGeometry(.1, .16, 3.4, 16), white); trunk.position.y = 2.0; g.add(trunk);
  for (let i = 0; i < 10; i++) {
    const a = i / 10 * PI * 2, pts = [];
    for (let k = 0; k <= 12; k++) { const u = k / 12, r = .55 * (1 - u) + .17 * u, aa = a + u * .5; pts.push(V(Math.cos(aa) * r, .35 + u * 3.25, Math.sin(aa) * r)); }
    g.add(new T.Mesh(new T.TubeGeometry(new T.CatmullRomCurve3(pts), 24, .022, 6), white));
  }
  for (let i = 0; i < 14; i++) {
    const a = i / 14 * PI * 2, c = Math.cos(a), s = Math.sin(a);
    const pts = [V(c * .12, 3.45, s * .12), V(c * .75, 3.95, s * .75), V(c * .92, 4.65, s * .92), V(c * .62, 5.2, s * .62)];
    g.add(new T.Mesh(new T.TubeGeometry(new T.CatmullRomCurve3(pts), 24, .03, 6), white));
  }
  const orb = new T.Mesh(new T.SphereGeometry(.64, 64, 48), std(0xffc845, 0xffa514, .3, { metalness: .85, roughness: .22 }));
  orb.position.y = 4.58; g.add(orb);
  const orbHalo = sprite(0xffc845, 3, .28); orbHalo.position.y = 4.58; g.add(orbHalo);
  const pl = new T.PointLight(0xffb84a, 0, 9); pl.position.set(0, 4.6, 1.2); g.add(pl);
  const N = 700, pos = new Float32Array(N * 3), seed = Float32Array.from({ length: N }, () => Math.random());
  const pg = new T.BufferGeometry(); pg.setAttribute('position', new T.BufferAttribute(pos, 3));
  const pts = new T.Points(pg, new T.PointsMaterial({ map: GLOW, color: 0xffc845, size: .14, transparent: true, blending: T.AdditiveBlending, depthWrite: false })); g.add(pts);
  const ring = new T.Mesh(new T.RingGeometry(3.3, 3.6, 96), addMat(0xffc845)); ring.rotation.x = -PI / 2; ring.position.y = .01; ring.material.opacity = .25; g.add(ring);
  const it = reg('fund', g);
  it.update = t => {
    const fill = sstep(1, 7, t);
    orb.material.emissiveIntensity = .25 + fill * .9; orbHalo.scale.setScalar(2 + fill * 1.4); pl.intensity = fill * 1.4;
    const on = sstep(.6, 1.6, t);
    for (let i = 0; i < N; i++) {
      const u = (t * .16 + seed[i]) % 1, r = 3.5 * Math.pow(1 - u, 1.3) + .1, a = seed[i] * PI * 14 + u * 9;
      pos[i * 3] = Math.cos(a) * r; pos[i * 3 + 1] = .1 + Math.pow(u, .9) * 4.45; pos[i * 3 + 2] = Math.sin(a) * r;
      if (on < 1 && seed[i] > on) pos[i * 3 + 1] = -50;
    }
    pg.attributes.position.needsUpdate = true;
  };
}
// balance
{
  const g = new T.Group(); CH.add(g);
  const metal = std(0xc9d3dc, 0x000000, 0, { metalness: .85, roughness: .25 });
  const post = new T.Mesh(new T.CylinderGeometry(.08, .22, 2.6, 24), metal); post.position.y = 1.3; g.add(post);
  const baseD = new T.Mesh(new T.CylinderGeometry(.7, .9, .18, 32), metal); baseD.position.y = .09; g.add(baseD);
  const piv = new T.Mesh(new T.SphereGeometry(.16, 24, 16), std(0xffc845, 0xffb020, .8)); piv.position.y = 2.65; g.add(piv);
  const beam = new T.Mesh(new T.BoxGeometry(6, .1, .14), metal); beam.position.y = 2.65; g.add(beam);
  const pan = (color, emi, items) => {
    const p = new T.Group();
    const disc = new T.Mesh(new T.CylinderGeometry(.85, .65, .1, 32), metal); p.add(disc);
    const rim = new T.Mesh(new T.TorusGeometry(.85, .02, 8, 64), addMat(color)); rim.rotation.x = PI / 2; rim.position.y = .05; p.add(rim);
    const lm = new T.LineBasicMaterial({ color: 0x9fb0be, transparent: true });
    for (let i = 0; i < 3; i++) { const a = i / 3 * PI * 2; p.add(new T.Line(new T.BufferGeometry().setFromPoints([V(Math.cos(a) * .8, .05, Math.sin(a) * .8), V(0, 1.45, 0)]), lm)); }
    items(p, color, emi); g.add(p); return p;
  };
  const L = pan(0xff5a5f, 0xff3040, (p, c, e) => { [[-.3, 0], [.3, .05], [0, .35]].forEach(([x, z], i) => { const b = new T.Mesh(new T.BoxGeometry(.42, .42, .42), std(c, e, .6)); b.position.set(x, .27 + (i === 2 ? .42 : 0), z - .1); b.rotation.y = i; p.add(b); }); });
  const R = pan(0x35d0e6, 0x20c0e0, (p, c, e) => { [[-.32, -.1], [.32, -.1], [0, .3], [0, -.05]].forEach(([x, z], i) => { const s = new T.Mesh(new T.SphereGeometry(.24, 24, 16), std(c, e, .9)); s.position.set(x, .3 + (i === 3 ? .4 : 0), z); p.add(s); }); });
  const it = reg('balance', g);
  it.update = t => {
    const th = -.17 * ease(clamp((t - 1.8) / 1.8, 0, 1)) + .03 * Math.sin(t * 1.3) * sstep(3.6, 5, t);
    beam.rotation.z = th;
    const ex = 2.85 * Math.cos(th), ey = 2.85 * Math.sin(th);
    L.position.set(-ex, 2.65 - ey - 1.45, 0); R.position.set(ex, 2.65 + ey - 1.45, 0);
  };
  g.userData.L = L; g.userData.R = R;
}

// ================================================================== STORY: paper world objects
function paperTex(w = 1280, h = 720) {
  const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d');
  const gr = g.createLinearGradient(0, 0, w, h); gr.addColorStop(0, '#24194a'); gr.addColorStop(.5, '#3e2b72'); gr.addColorStop(1, '#271c52');
  g.fillStyle = gr; g.fillRect(0, 0, w, h);
  for (let i = 0; i < 90; i++) {
    const light = Math.random() < .5;
    g.strokeStyle = `rgba(${light ? '210,190,255' : '0,0,0'},${.03 + Math.random() * .07})`; g.lineWidth = .8 + Math.random() * 2.2;
    g.beginPath(); let x = Math.random() * w, y = Math.random() * h; g.moveTo(x, y);
    for (let k = 0; k < 3; k++) { x += (Math.random() - .5) * 500; y += (Math.random() - .5) * 360; g.lineTo(x, y); }
    g.stroke();
  }
  const id = g.getImageData(0, 0, w, h), d = id.data;
  for (let i = 0; i < d.length; i += 4) { const n = (Math.random() - .5) * 16; d[i] += n; d[i + 1] += n; d[i + 2] += n; }
  g.putImageData(id, 0, 0);
  const v = g.createRadialGradient(w / 2, h / 2, h * .25, w / 2, h / 2, w * .7); v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,.6)');
  g.fillStyle = v; g.fillRect(0, 0, w, h);
  return new T.CanvasTexture(c);
}
CH.background = paperTex();
CH.fog = new T.FogExp2(0x241a45, 0.012);

function star(g, x, y, r) { g.beginPath(); for (let i = 0; i < 10; i++) { const a = -PI / 2 + i * PI / 5, rr = i % 2 ? r * .42 : r; g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr); } g.closePath(); g.fill(); }
function flagCanvas(code, lines) {
  const c = document.createElement('canvas'); c.width = 192; c.height = 128; const g = c.getContext('2d'), w = 192, h = 128;
  const hs = cols => cols.forEach((col, i) => { g.fillStyle = col; g.fillRect(0, i * h / cols.length, w, h / cols.length + 1); });
  const vs = cols => cols.forEach((col, i) => { g.fillStyle = col; g.fillRect(i * w / cols.length, 0, w / cols.length + 1, h); });
  const circ = (x, y, r, col) => { g.fillStyle = col; g.beginPath(); g.arc(x, y, r, 0, 7); g.fill(); };
  switch (code) {
    case 'jp': hs(['#fff']); circ(96, 64, 38, '#bc002d'); break;
    case 'ch': hs(['#d52b1e']); g.fillStyle = '#fff'; g.fillRect(84, 34, 24, 60); g.fillRect(66, 52, 60, 24); break;
    case 'kr': hs(['#fff']); circ(96, 64, 32, '#0047a0'); g.fillStyle = '#cd2e3a'; g.beginPath(); g.arc(96, 64, 32, PI, 0); g.fill(); circ(80, 64, 16, '#cd2e3a'); circ(112, 64, 16, '#0047a0'); break;
    case 'de': hs(['#111', '#dd0000', '#ffce00']); break;
    case 'us': for (let i = 0; i < 13; i++) { g.fillStyle = i % 2 ? '#fff' : '#b22234'; g.fillRect(0, i * h / 13, w, h / 13 + 1); } g.fillStyle = '#3c3b6e'; g.fillRect(0, 0, 80, 69); for (let i = 0; i < 5; i++) for (let j = 0; j < 6; j++) circ(8 + j * 13, 8 + i * 13, 2.2, '#fff'); break;
    case 'cn': hs(['#de2910']); g.fillStyle = '#ffde00'; star(g, 34, 32, 16); [[64, 14], [76, 26], [76, 44], [64, 56]].forEach(([x, y]) => star(g, x, y, 5)); break;
    case 'ru': hs(['#fff', '#0039a6', '#d52b1e']); break;
    case 'kz': hs(['#00afca']); circ(104, 56, 22, '#fec50c'); g.fillStyle = '#fec50c'; for (let i = 0; i < 24; i++) { const a = i / 24 * PI * 2; g.beginPath(); g.moveTo(104 + Math.cos(a) * 26, 56 + Math.sin(a) * 26); g.lineTo(104 + Math.cos(a + .1) * 34, 56 + Math.sin(a + .1) * 34); g.lineTo(104 + Math.cos(a + .2) * 26, 56 + Math.sin(a + .2) * 26); g.fill(); } g.fillRect(12, 8, 10, 112); g.fillRect(70, 96, 70, 6); break;
    case 'ml': vs(['#14b53a', '#fcd116', '#ce1126']); break;
    case 'gn': vs(['#ce1126', '#fcd116', '#009460']); break;
    case 'bf': hs(['#ef2b2d', '#009e49']); g.fillStyle = '#fcd116'; star(g, 96, 64, 22); break;
    case 'ae': hs(['#00732f', '#fff', '#111']); g.fillStyle = '#ff0000'; g.fillRect(0, 0, 50, 128); break;
    case 'sg': hs(['#ef3340', '#fff']); circ(40, 32, 20, '#fff'); circ(48, 32, 20, '#ef3340'); g.fillStyle = '#fff'; [[62, 20], [72, 28], [68, 40], [56, 40], [52, 28]].forEach(([x, y]) => star(g, x, y, 4)); break;
    case 'no': hs(['#ba0c2f']); g.fillStyle = '#fff'; g.fillRect(52, 0, 32, 128); g.fillRect(0, 48, 192, 32); g.fillStyle = '#00205b'; g.fillRect(60, 0, 16, 128); g.fillRect(0, 56, 192, 16); break;
    case 'fr': vs(['#0055a4', '#fff', '#ef4135']); break;
    case 'it': vs(['#009246', '#fff', '#ce2b37']); break;
    case 'br': hs(['#009c3b']); g.fillStyle = '#ffdf00'; g.beginPath(); g.moveTo(96, 14); g.lineTo(176, 64); g.lineTo(96, 114); g.lineTo(16, 64); g.fill(); circ(96, 64, 26, '#002776'); break;
    case 'in': hs(['#ff9933', '#fff', '#138808']); circ(96, 64, 14, '#000080'); circ(96, 64, 11, '#fff'); break;
    case 'sa': hs(['#006c35']); g.fillStyle = '#fff'; g.fillRect(50, 80, 92, 6); g.font = 'bold 30px serif'; g.fillText('﷽', 70, 66); break;
    case 'uz': hs(['#0099b5', '#fff', '#1eb53a']); g.fillStyle = '#ce1126'; g.fillRect(0, 41, 192, 4); g.fillRect(0, 83, 192, 4); circ(30, 20, 12, '#fff'); circ(35, 20, 12, '#0099b5'); break;
    case 'ng': vs(['#008751', '#fff', '#008751']); break;
    case 'cd': hs(['#007fff']); g.strokeStyle = '#f7d618'; g.lineWidth = 30; g.beginPath(); g.moveTo(0, 128); g.lineTo(192, 0); g.stroke(); g.strokeStyle = '#ce1021'; g.lineWidth = 18; g.stroke(); g.fillStyle = '#f7d618'; star(g, 30, 28, 18); break;
    case 'gb': hs(['#012169']); g.strokeStyle = '#fff'; g.lineWidth = 22; g.beginPath(); g.moveTo(0, 0); g.lineTo(192, 128); g.moveTo(192, 0); g.lineTo(0, 128); g.stroke(); g.fillStyle = '#fff'; g.fillRect(80, 0, 32, 128); g.fillRect(0, 48, 192, 32); g.fillStyle = '#c8102e'; g.fillRect(86, 0, 20, 128); g.fillRect(0, 54, 192, 20); break;
    case 'mx': vs(['#006847', '#fff', '#ce1126']); circ(96, 64, 12, '#8b5a2b'); break;
    case 'vn': hs(['#da251d']); g.fillStyle = '#ff0'; star(g, 96, 64, 30); break;
    case 'tr': hs(['#e30a17']); circ(80, 64, 30, '#fff'); circ(88, 64, 24, '#e30a17'); g.fillStyle = '#fff'; star(g, 122, 64, 12); break;
    case 'id': hs(['#ce1126', '#fff']); break;
    case 'eg': hs(['#ce1126', '#fff', '#111']); circ(96, 64, 9, '#c09300'); break;
    case 'th': hs(['#a51931', '#f4f5f8', '#2d2a4a', '#2d2a4a', '#f4f5f8', '#a51931']); break;
    case 'ar': hs(['#74acdf', '#fff', '#74acdf']); circ(96, 64, 10, '#f6b40e'); break;
    case 'pl': hs(['#fff', '#dc143c']); break;
    case 'ua': hs(['#0057b7', '#ffd700']); break;
  }
  if (lines) { for (let y = 0; y < h; y += 5) { g.fillStyle = 'rgba(0,0,0,.28)'; g.fillRect(0, y, w, 1.4); g.fillStyle = 'rgba(255,255,255,.12)'; g.fillRect(0, y + 1.5, w, 1); } }
  return c;
}
const FLAG = {};
const flagTex = (code, lines) => FLAG[code + (lines ? 'L' : '')] || (FLAG[code + (lines ? 'L' : '')] = new T.CanvasTexture(flagCanvas(code, lines)));
const FLAGSQ = {};
function flagTexSq(code) {
  if (FLAGSQ[code]) return FLAGSQ[code];
  const c = document.createElement('canvas'); c.width = c.height = 128; c.getContext('2d').drawImage(flagCanvas(code), -32, 0, 192, 128);
  return (FLAGSQ[code] = new T.CanvasTexture(c));
}
const basic = (o) => new T.MeshBasicMaterial(Object.assign({ transparent: true }, o));
function flagBubble(code, r) {
  const g = new T.Group();
  const sh = new T.Mesh(new T.CircleGeometry(r * 1.12, 48), basic({ color: 0x000000, opacity: .35 })); sh.position.set(r * .12, -r * .14, -.02); g.add(sh);
  const ring = new T.Mesh(new T.CircleGeometry(r * 1.1, 48), basic({ color: 0xe9e4f5 })); ring.position.z = -.01; g.add(ring);
  g.add(new T.Mesh(new T.CircleGeometry(r, 48), basic({ map: flagTexSq(code) })));
  return g;
}

// --- slide: flag constellation (income vs complexity), schematic
const BUB = [['jp', 2.3, 34e3], ['ch', 2.1, 99e3], ['de', 1.8, 53e3], ['us', 1.4, 82e3], ['cn', 1.15, 12.6e3], ['ae', .4, 53e3], ['ru', .3, 13.8e3],
  ['br', .05, 7e3], ['in', .4, 2.5e3], ['ml', -1.3, .9e3], ['cd', -1.7, .65e3], ['kz', -.4, 13e3]];
const bubPos = (eci, gdp) => V(-6.4 + (eci + 1.9) / 4.3 * 12.8, .4 + (Math.log10(gdp) - 2.7) / (5.1 - 2.7) * 5.6, 0);
{
  const g = new T.Group(); CH.add(g);
  const items = BUB.map(([c, e, y], i) => {
    const kz = c === 'kz', b = flagBubble(c, kz ? .55 : .34); const p = bubPos(e, y); b.position.copy(p); g.add(b);
    return { b, p, kz, d: kz ? 3.2 : .3 + Math.random() * 1.6, seed: Math.random() * 10 };
  });
  let sd = 7; const rnd = () => { sd = (sd * 16807) % 2147483647; return sd / 2147483647; };
  const dotM = basic({ color: 0xe6defa, opacity: .55 }), dots = [];
  for (let k = 0; dots.length < 70 && k < 2000; k++) {
    const e = -1.8 + rnd() * 4, gy = Math.pow(10, 2.85 + (e + 1.9) / 4.3 * 1.75 + (rnd() - .5) * .7), p = bubPos(e, gy);
    if (p.y < .3 || p.y > 6.3 || items.some(o => o.p.distanceTo(p) < (o.kz ? 1.05 : .6)) || dots.some(d => d.p.distanceTo(p) < .32)) continue;
    const d = new T.Mesh(new T.CircleGeometry(.075, 16), dotM); d.position.copy(p); d.position.z = -.03; g.add(d); dots.push({ d, p, t: .2 + rnd() * 1.2 });
  }
  const ax = new T.LineBasicMaterial({ color: 0xcfc6ea, transparent: true, opacity: .45 });
  g.add(new T.Line(new T.BufferGeometry().setFromPoints([V(-6.8, .1, -.1), V(6.8, .1, -.1)]), ax));
  g.add(new T.Line(new T.BufferGeometry().setFromPoints([V(-6.8, .1, -.1), V(-6.8, 6.4, -.1)]), ax));
  const kzRing = new T.Mesh(new T.RingGeometry(.72, .8, 64), basic({ color: 0xffc845 })); g.add(kzRing);
  const it = reg('bubbles', g);
  it.update = t => {
    items.forEach(o => {
      const e = clamp((t - o.d) / .6, 0, 1), pop = e < 1 ? Math.sin(e * PI * .5) * (1 + .25 * Math.sin(e * PI)) : 1;
      o.b.scale.setScalar(Math.max(.001, pop) * (o.kz ? 1 + .06 * Math.sin(t * 3) : 1));
      o.b.position.set(o.p.x, o.p.y + .04 * Math.sin(t * 1.2 + o.seed), o.p.z);
    });
    dots.forEach(o => o.d.scale.setScalar(Math.max(.001, ease(clamp((t - o.t) / .4, 0, 1)))));
    const kz = items[items.length - 1];
    kzRing.position.copy(kz.b.position); kzRing.position.z = .01; kzRing.scale.setScalar(1 + .25 * ((t * .8) % 1)); kzRing.material.opacity *= sstep(3.4, 3.8, t) * (1 - ((t * .8) % 1));
  };
}

// --- slide: what we sell vs what we buy (torn paper)
function tornTex() {
  const c = document.createElement('canvas'); c.width = 512; c.height = 512; const g = c.getContext('2d');
  g.fillStyle = '#0c0a14'; g.beginPath(); g.moveTo(0, 0); g.lineTo(470, 0);
  for (let y = 0; y <= 512; y += 14) g.lineTo(455 + Math.random() * 40, y);
  g.lineTo(0, 512); g.closePath(); g.fill();
  g.strokeStyle = 'rgba(235,228,250,.85)'; g.lineWidth = 5; g.beginPath(); let first = true;
  for (let y = 0; y <= 512; y += 14) { const x = 462 + Math.random() * 30; first ? g.moveTo(x, y) : g.lineTo(x, y); first = false; } g.stroke();
  const id = g.getImageData(0, 0, 512, 512), d = id.data; for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 0 && d[i] < 40) { const n = (Math.random() - .5) * 14; d[i] += n; d[i + 1] += n; d[i + 2] += n; }
  g.putImageData(id, 0, 0); return new T.CanvasTexture(c);
}
function carModel() {
  const g = new T.Group(), paint = std(0xe8434a, 0, 0, { metalness: .6, roughness: .3 }), dark = std(0x15161c), glass = std(0x9fd8ff, 0x35d0e6, .3, { metalness: .2, roughness: .1 });
  const b = new T.Mesh(new T.BoxGeometry(1.6, .38, .75), paint); b.position.y = .35; g.add(b);
  const cab = new T.Mesh(new T.BoxGeometry(.85, .32, .68), glass); cab.position.set(-.08, .69, 0); g.add(cab);
  for (const x of [-.52, .52]) for (const z of [-.36, .36]) { const w = new T.Mesh(new T.CylinderGeometry(.18, .18, .12, 20), dark); w.rotation.x = PI / 2; w.position.set(x, .18, z); g.add(w); }
  return g;
}
function phoneModel() {
  const g = new T.Group();
  g.add(new T.Mesh(new T.BoxGeometry(.62, 1.2, .07), std(0x1b1c22, 0, 0, { metalness: .8, roughness: .3 })));
  const s = new T.Mesh(new T.PlaneGeometry(.54, 1.08), basic({ color: 0x5b8cff })); s.position.z = .04; g.add(s);
  return g;
}
function pillModel() {
  const g = new T.Group(), a = std(0xff5a5f, 0, 0, { roughness: .25 }), b = std(0xf2f2f2, 0, 0, { roughness: .25 });
  const c1 = new T.Mesh(new T.CylinderGeometry(.22, .22, .38, 24), a); c1.position.y = .19; g.add(c1);
  const c2 = new T.Mesh(new T.CylinderGeometry(.22, .22, .38, 24), b); c2.position.y = -.19; g.add(c2);
  const h1 = new T.Mesh(new T.SphereGeometry(.22, 24, 12, 0, PI * 2, 0, PI / 2), a); h1.position.y = .38; g.add(h1);
  const h2 = new T.Mesh(new T.SphereGeometry(.22, 24, 12, 0, PI * 2, PI / 2, PI / 2), b); h2.position.y = -.38; g.add(h2);
  g.rotation.z = .7; return g;
}
function laptopModel() {
  const g = new T.Group(), al = std(0xc7ccd3, 0, 0, { metalness: .8, roughness: .3 });
  const base = new T.Mesh(new T.BoxGeometry(1.2, .05, .8), al); g.add(base);
  const lid = new T.Group(); lid.position.set(0, .02, -.4); lid.rotation.x = -.35; g.add(lid);
  const l = new T.Mesh(new T.BoxGeometry(1.2, .8, .04), al); l.position.y = .4; lid.add(l);
  const s = new T.Mesh(new T.PlaneGeometry(1.08, .7), basic({ color: 0x35d0e6 })); s.position.set(0, .4, .025); lid.add(s);
  return g;
}
function washerModel() {
  const g = new T.Group();
  g.add(new T.Mesh(new T.BoxGeometry(.9, 1, .8), std(0xeef0f4, 0, 0, { roughness: .4 })));
  const d = new T.Mesh(new T.TorusGeometry(.26, .05, 10, 32), std(0x9aa3ad, 0, 0, { metalness: .8 })); d.position.set(0, -.05, .41); g.add(d);
  const gl = new T.Mesh(new T.CircleGeometry(.24, 32), basic({ color: 0x2a5ea8, opacity: .9 })); gl.position.set(0, -.05, .405); g.add(gl);
  return g;
}
{
  const g = new T.Group(); CH.add(g);
  const torn = new T.Mesh(new T.PlaneGeometry(10, 10), basic({ map: tornTex() })); torn.position.set(-4.6, 2.4, -1.5); g.add(torn);
  const bar = barrel(); bar.children[0].material = std(0x5a6a7e, 0x1a2230, .4, { metalness: .5, roughness: .35 }); bar.scale.setScalar(1.7); bar.position.set(-3.6, 1.3, 0); g.add(bar);
  const items = [[carModel(), 2.3, .8, 1.1], [phoneModel(), 4.6, 3.3, .9], [pillModel(), 5.6, 1.2, 1.2], [laptopModel(), 2.6, 3.3, 1], [washerModel(), 4.3, .9, .9]];
  items.forEach(([m, x, y, s]) => { m.position.set(x, y, 0); m.scale.setScalar(s); g.add(m); m.userData.y = y; });
  const it = reg('sellbuy', g);
  it.update = t => {
    torn.position.x = -4.6 - 6 * (1 - ease(clamp(t / 1.2, 0, 1)));
    const e1 = ease(clamp((t - .6) / .9, 0, 1)); bar.scale.setScalar(1.7 * Math.max(.001, e1)); bar.rotation.y = t * .4;
    items.forEach(([m], i) => {
      const e = ease(clamp((t - 1.6 - i * .25) / .7, 0, 1)); m.scale.setScalar(Math.max(.001, e) * items[i][3]);
      m.position.y = m.userData.y + .1 * Math.sin(t * 1.3 + i); m.rotation.y = .5 * Math.sin(t * .6 + i);
    });
  };
}

// --- slide: Singapore vs Kazakhstan stacks of money
const STK = [['kz', 46.8, -3.4], ['sg', 62.9, 1.0]], SK = .075;
let BILLS;
function billsTex() {
  if (BILLS) return BILLS;
  const c = document.createElement('canvas'); c.width = 256; c.height = 256; const g = c.getContext('2d');
  for (let y = 0; y < 256; y += 4) { const k = 150 + Math.random() * 40; g.fillStyle = `rgb(${k * .62|0},${k|0},${k * .6|0})`; g.fillRect(0, y, 256, 3); g.fillStyle = 'rgba(0,0,0,.35)'; g.fillRect(0, y + 3, 256, 1); }
  BILLS = new T.CanvasTexture(c); BILLS.wrapS = BILLS.wrapT = T.RepeatWrapping; BILLS.repeat.set(1, 3); return BILLS;
}
const stacks = [];
{
  const g = new T.Group(); CH.add(g);
  STK.forEach(([c, v, x]) => {
    const geo = new T.BoxGeometry(2.2, 1, 1.4); geo.translate(0, .5, 0);
    const side = new T.MeshStandardMaterial({ map: billsTex(), roughness: .7 });
    const top = new T.MeshStandardMaterial({ color: 0xa9d8a0, roughness: .7 });
    const m = new T.Mesh(geo, [side, side, top, top, side, side]); m.position.x = x; m.scale.y = .001; g.add(m); stacks.push(m);
    const fl = new T.Group(); g.add(fl); m.userData.flag = fl;
    const back = new T.Mesh(new T.PlaneGeometry(1.86, 1.28), basic({ color: 0xf4f1fa })); fl.add(back);
    const f = new T.Mesh(new T.PlaneGeometry(1.74, 1.16), basic({ map: flagTex(c) })); f.position.z = .005; fl.add(f);
  });
  const it = reg('stacks', g);
  it.update = t => stacks.forEach((m, i) => {
    const e = ease(clamp((t - .6 - i * .9) / 1.6, 0, 1)); m.scale.y = Math.max(.001, STK[i][1] * SK * e);
    const fl = m.userData.flag; const r = m.rotation.y; fl.position.set(m.position.x + Math.sin(r) * .72, Math.max(.7, m.scale.y - .9), Math.cos(r) * .72); fl.rotation.y = r; fl.visible = m.scale.y > 1.6;
    m.rotation.y = .25 * Math.sin(t * .5 + i);
  });
}

// --- slide: McDonald's story (burger + broken supply line)
function burgerModel() {
  const g = new T.Group();
  const bun = std(0xd9913e, 0, 0, { roughness: .55 });
  const top = new T.Mesh(new T.SphereGeometry(1, 40, 20, 0, PI * 2, 0, PI / 2), bun); top.scale.set(1, .55, 1); top.position.y = .95; g.add(top);
  const seed = std(0xfff3d6); for (let i = 0; i < 26; i++) { const a = Math.random() * PI * 2, r = Math.random() * .8; const s = new T.Mesh(new T.SphereGeometry(.05, 8, 6), seed); s.scale.set(1, .5, 1.6); const yy = .95 + .55 * Math.sqrt(Math.max(0, 1 - r * r)); s.position.set(Math.cos(a) * r, yy, Math.sin(a) * r); s.rotation.y = a; g.add(s); }
  const let_ = new T.Mesh(new T.CylinderGeometry(1.08, 1.08, .08, 28), std(0x4caf50, 0, 0, { roughness: .6 })); let_.position.y = .9; g.add(let_);
  const ch = new T.Mesh(new T.BoxGeometry(1.75, .06, 1.75), std(0xffc93a, 0, 0, { roughness: .4 })); ch.position.y = .82; ch.rotation.y = .4; g.add(ch);
  const pat = new T.Mesh(new T.CylinderGeometry(1, 1, .3, 32), std(0x4a2a17, 0, 0, { roughness: .8 })); pat.position.y = .62; g.add(pat);
  const bot = new T.Mesh(new T.CylinderGeometry(.98, .9, .42, 32), bun); bot.position.y = .26; g.add(bot);
  return g;
}

function bearModel() {
  const g = new T.Group();
  const fur = std(0x7a4a26, 0, 0, { roughness: .9 }), light = std(0xd2a06a, 0, 0, { roughness: .9 }), dark = std(0x1a1010, 0, 0, { roughness: .4 });
  const hatM = std(0x2b2018, 0, 0, { roughness: 1 }), hatF = std(0x5a4636, 0, 0, { roughness: 1 });
  const body = new T.Mesh(new T.SphereGeometry(.55, 32, 24), fur); body.scale.set(1, 1.1, .85); body.position.y = .62; g.add(body);
  const belly = new T.Mesh(new T.SphereGeometry(.4, 24, 16), light); belly.scale.set(1, 1.1, .5); belly.position.set(0, .55, .32); g.add(belly);
  for (const x of [-.3, .3]) {
    const leg = new T.Mesh(new T.SphereGeometry(.2, 16, 12), fur); leg.scale.set(1, .75, 1.4); leg.position.set(x, .14, .32); g.add(leg);
    const pad = new T.Mesh(new T.CircleGeometry(.11, 16), light); pad.position.set(x, .14, .6); g.add(pad);
  }
  const head = new T.Group(); head.position.y = 1.4; g.add(head);
  head.add(new T.Mesh(new T.SphereGeometry(.38, 32, 24), fur));
  const snout = new T.Mesh(new T.SphereGeometry(.17, 20, 16), light); snout.scale.set(1.1, .8, 1); snout.position.set(0, -.08, .32); head.add(snout);
  const nose = new T.Mesh(new T.SphereGeometry(.065, 12, 10), dark); nose.scale.set(1.3, 1, 1); nose.position.set(0, -.03, .48); head.add(nose);
  for (const x of [-.13, .13]) { const e = new T.Mesh(new T.SphereGeometry(.045, 12, 10), dark); e.position.set(x, .07, .34); head.add(e); }
  // ushanka
  const cap = new T.Mesh(new T.SphereGeometry(.41, 32, 16, 0, PI * 2, 0, PI / 2), hatM); cap.scale.y = .75; cap.position.y = .1; head.add(cap);
  const band = new T.Mesh(new T.TorusGeometry(.4, .08, 12, 40), hatF); band.rotation.x = PI / 2; band.position.y = .12; head.add(band);
  for (const x of [-.38, .38]) { const f = new T.Mesh(new T.BoxGeometry(.1, .3, .26), hatF); f.position.set(x, -.06, 0); head.add(f); }
  const star = new T.Mesh(new T.CircleGeometry(.06, 5), basic({ color: 0xff3b47 })); star.position.set(0, .22, .38); head.add(star);
  // balalaika held across the chest, neck up to the left
  const bal = new T.Group(); bal.position.set(.18, .5, .58); bal.rotation.z = .85; g.add(bal);
  const wood = std(0xd99a4e, 0, 0, { roughness: .5 }), wood2 = std(0x6b3a1a, 0, 0, { roughness: .6 });
  const sh = new T.Shape(); sh.moveTo(-.34, -.28); sh.lineTo(.34, -.28); sh.quadraticCurveTo(.1, .05, 0, .3); sh.quadraticCurveTo(-.1, .05, -.34, -.28);
  const tri = new T.Mesh(new T.ExtrudeGeometry(sh, { depth: .1, bevelEnabled: true, bevelSize: .015, bevelThickness: .015, bevelSegments: 1 }), wood); tri.position.z = -.05; bal.add(tri);
  const hole = new T.Mesh(new T.CircleGeometry(.05, 16), basic({ color: 0x1a0d05 })); hole.position.set(0, -.05, .07); bal.add(hole);
  const neck = new T.Mesh(new T.BoxGeometry(.07, .85, .05), wood2); neck.position.set(0, .7, .03); bal.add(neck);
  const headb = new T.Mesh(new T.BoxGeometry(.12, .17, .06), wood2); headb.position.set(0, 1.18, .03); bal.add(headb);
  const sm = new T.LineBasicMaterial({ color: 0xf5f5f5 });
  for (const x of [-.018, 0, .018]) bal.add(new T.Line(new T.BufferGeometry().setFromPoints([V(x, -.22, .075), V(x, 1.1, .065)]), sm));
  const at = (x, y) => { const v = V(x, y, .1).applyAxisAngle(V(0, 0, 1), .85); return v.add(bal.position); };
  // arms as connected tubes shoulder -> elbow -> paw
  const armTube = (pts) => new T.Mesh(new T.TubeGeometry(new T.CatmullRomCurve3(pts), 24, .11, 12, false), fur);
  const fretPaw = at(0, .75), strumPaw = at(.02, -.05);
  const lArm = armTube([V(-.4, 1.0, .1), V(-.62, .85, .4), fretPaw.clone().add(V(-.05, -.05, -.02))]); g.add(lArm);
  const lp = new T.Mesh(new T.SphereGeometry(.13, 16, 12), fur); lp.position.copy(fretPaw).add(V(-.04, -.04, 0)); g.add(lp);
  const rArm = new T.Group(); rArm.position.set(.4, 1.0, .1); g.add(rArm);
  rArm.add(armTube([V(0, 0, 0), V(.2, -.3, .3), strumPaw.clone().sub(rArm.position).add(V(.04, .04, 0))]));
  const rp = new T.Mesh(new T.SphereGeometry(.13, 16, 12), fur); rp.position.copy(strumPaw).sub(rArm.position).add(V(.04, .04, .02)); rArm.add(rp);
  const notes = []; for (let i = 0; i < 3; i++) { const n = sprite(0xffc845, .22, .9); g.add(n); notes.push(n); }
  g.userData = { head, arm: rArm, notes, bal };
  return g;
}
{
  const g = new T.Group(); CH.add(g);
  const burger = burgerModel(); burger.position.set(3.2, .2, 0); g.add(burger);
  const crate = new T.Mesh(new T.BoxGeometry(1.5, 1.1, 1.1), [1, 1, 2, 2, 1, 1].map(k => k === 1 ? new T.MeshStandardMaterial({ map: flagTex('ru'), roughness: .7 }) : std(0x7a5a3a))); crate.position.set(-4.2, .75, 0); g.add(crate);
  const bear = bearModel(); bear.position.set(-4.2, 1.3, 0); bear.rotation.y = .2; g.add(bear);
  const mid = V(-.5, 2.1, 0);
  const a = tube([V(-3.4, 1.2, 0), V(-2, 2.1, 0), mid], .06, flowMat(0xffc845, { dash: 5, speed: 1.2, int: 1.6 }), 60); g.add(a);
  const b = tube([mid, V(1.2, 2.1, 0), V(2.2, 1.6, 0)], .06, flowMat(0xffc845, { dash: 5, speed: 1.2, int: 1.6 }), 60); g.add(b);
  const xg = new T.Group(); xg.position.copy(mid); g.add(xg);
  const red = std(0xff3b47, 0xff2030, .8);
  const x1 = new T.Mesh(new T.BoxGeometry(1.1, .2, .2), red); x1.rotation.z = PI / 4; const x2 = x1.clone(); x2.rotation.z = -PI / 4; xg.add(x1, x2);
  const it = reg('burger', g);
  it.update = t => {
    const e = ease(clamp((t - .3) / 1, 0, 1)); burger.scale.setScalar(Math.max(.001, e) * 1.25); burger.rotation.y = t * .35;
    crate.scale.setScalar(Math.max(.001, ease(clamp((t - .6) / .8, 0, 1)))); crate.rotation.y = .3;
    const be = ease(clamp((t - .9) / .8, 0, 1)), u = bear.userData; bear.scale.setScalar(Math.max(.001, be) * .85);
    u.arm.rotation.z = .07 * Math.sin(t * 14); u.head.rotation.z = .12 * Math.sin(t * 3.5); u.head.rotation.y = .15 * Math.sin(t * 1.7); bear.position.y = 1.3 + .03 * Math.abs(Math.sin(t * 7));
    u.notes.forEach((n, k) => { const q = (t * .6 + k / 3) % 1; n.position.set(.5 + q * .6 + .15 * Math.sin(q * 9), 1.0 + q * 1.4, .3); n.material.opacity *= (1 - q) * be; });
    a.material.uniforms.uP.value = ease(clamp((t - 1) / .8, 0, 1)); b.material.uniforms.uP.value = ease(clamp((t - 1.7) / .8, 0, 1));
    const cut = sstep(3.2, 3.5, t);
    xg.scale.setScalar(Math.max(.001, cut * (1 + .15 * Math.sin(t * 6)))); xg.rotation.z = (1 - cut) * PI;
    b.material.uniforms.uO.value *= 1 - .9 * cut;
  };
}

// --- slide: the three whales (ownership pies)
const PIES = [['Tengiz', [20, 50, 25, 5], -4.6], ['Kashagan', [16.88, 16.81, 16.81, 16.81, 16.81, 8.33, 7.56], 0], ['Karachaganak', [10, 29.25, 29.25, 18, 13.5], 4.6]];
const PIECOL = [0x5b3fc4, 0x7a5ad8, 0x41308f, 0x8d74d6, 0x4e3aa8, 0x6a4fc9];
function pieGroup(shares) {
  const g = new T.Group(); const tot = shares.reduce((a, b) => a + b, 0); let a0 = PI / 2;
  shares.forEach((s, i) => {
    const ang = s / tot * PI * 2, sh = new T.Shape(); sh.moveTo(0, 0); sh.absarc(0, 0, 1.45, a0, a0 + ang, false); sh.lineTo(0, 0);
    const kz = i === 0;
    const geo = new T.ExtrudeGeometry(sh, { depth: kz ? .5 : .3, bevelEnabled: true, bevelSize: .02, bevelThickness: .02, bevelSegments: 1, curveSegments: 32 });
    const m = new T.Mesh(geo, kz ? std(0xffc845, 0xffa514, .45, { metalness: .5, roughness: .3 }) : std(PIECOL[i % PIECOL.length], 0, 0, { roughness: .85, metalness: 0 }));
    m.userData.mid = a0 + ang / 2; m.userData.kz = kz; g.add(m); a0 += ang;
  });
  return g;
}
{
  const g = new T.Group(); CH.add(g);
  const pies = PIES.map(([n, s, x]) => { const p = pieGroup(s); p.position.set(x, 2.1, 0); p.rotation.x = -.55; g.add(p); return p; });
  const it = reg('pies', g);
  it.update = t => pies.forEach((p, i) => {
    const e = ease(clamp((t - .4 - i * .45) / 1.1, 0, 1));
    p.scale.setScalar(Math.max(.001, e)); p.rotation.z = (1 - e) * -PI * 1.5 + .08 * Math.sin(t * .7 + i);
    const lift = sstep(2.4 + i * .3, 3.0 + i * .3, t);
    p.children.forEach(m => { if (m.userData.kz) { const a = m.userData.mid; m.position.set(Math.cos(a) * .35 * lift, Math.sin(a) * .35 * lift, .25 * lift); } });
  });
}

// --- globe: CPC pipeline Tengiz -> Novorossiysk
{
  const P = [[53.38, 46.15], [51.9, 47.1], [48.0, 46.4], [44.0, 45.3], [40.5, 45.4], [37.77, 44.72]];
  const m = tube(pathPts(P, 1.006, .3), .0075, flowMat(0xffb020, { dash: 14, speed: .8, int: 2, base: .25 }), 200); globe.add(m);
  const it = growTube('cpc', m, .6, 2.2);
  const fs = flowSprites(m.userData.curve, 14, 0xffd27a, .03, .12); m.add(fs);
  const prev = it.update; it.update = (t, dt) => { prev(t, dt); fs.userData.upd(t, 2.4); };
  gPin('cpc', [53.38, 46.15], 0xffc845, .06); gPin('cpc', [37.77, 44.72], 0xff5a5f, .06);
}

// ------------------------------------------------------------------ labels
const LBL = {}, labelsEl = document.getElementById('labels');
function lbl(key, world, pos, text, cls, o = {}) {
  const el = document.createElement('div'); el.className = 'lbl ' + cls;
  el.innerHTML = `<div class="t">${text}</div>`; labelsEl.appendChild(el);
  LBL[key] = Object.assign({ el, world, pos, on: false, until: 0 }, o);
}
const gl = (lon, lat, r = 1.01) => ll2v(lon, lat, r);
lbl('g_kz', 'globe', gl(63.5, 47, 1.02), 'KAZAKHSTAN', 'country', { occl: true });
lbl('g_rus', 'globe', gl(75, 60), 'RUSSIA', 'country hot', { occl: true });
lbl('g_chn', 'globe', gl(95, 35), 'CHINA', 'country hot', { occl: true });
lbl('g_astana', 'globe', gl(...CITY.astana), 'Astana · capital', 'city', { occl: true });
lbl('g_almaty', 'globe', gl(...CITY.almaty), 'Almaty · “city of apples”', 'city', { occl: true });
lbl('g_italy', 'globe', gl(...CITY.rome), 'Italy', 'city', { occl: true });
lbl('g_china', 'globe', gl(...CITY.beijing), 'China', 'city', { occl: true });
lbl('g_russia', 'globe', gl(...CITY.moscow), 'Russia', 'city', { occl: true });
lbl('g_profit', 'globe', gl(48, 52, 1.12), 'profits paid to foreign investors', 'redcap', { occl: true });
lbl('g_khorgos', 'globe', gl(...CITY.khorgos), 'Khorgos dry port', 'city', { occl: true });
lbl('g_aktau', 'globe', gl(...CITY.aktau), 'Aktau port', 'city', { occl: true });
lbl('g_baku', 'globe', gl(...CITY.baku), 'Baku', 'city', { occl: true });
lbl('g_europe', 'globe', gl(10, 50), 'EUROPE', 'country', { occl: true });
lbl('g_china2', 'globe', gl(100, 38), 'CHINA', 'country', { occl: true });
lbl('g_north', 'globe', gl(50, 57.5), 'route through Russia', 'redcap', { occl: true });
lbl('g_caspian', 'globe', gl(51, 41.6, 1.005), 'CASPIAN', 'water', { occl: true });
lbl('m_aral', 'map', mp(60, 45.6, .3), 'ARAL SEA', 'water');
lbl('m_caspian', 'map', mp(50.6, 43.5, .2), 'CASPIAN SEA', 'water');
lbl('m_balkhash', 'map', mp(74.6, 46.4, .3), 'LAKE BALKHASH', 'water');
lbl('m_rus', 'map', mp(63, 54.6, .6), 'RUSSIA', 'country');
lbl('m_uzb', 'map', mp(62.5, 41.3, .6), 'UZBEKISTAN', 'country');
lbl('m_chn', 'map', mp(86.5, 44, .9), 'CHINA', 'country');
lbl('m_shipcap', 'map', mp(58.6, 44.2, .5), 'rusting ships on the old seabed', 'cap');
[['astana', 71.43, 51.13], ['almaty', 76.95, 43.25], ['shymkent', 69.6, 42.3], ['atyrau', 51.92, 47.1], ['karaganda', 73.1, 49.8]].forEach(([k, lo, la]) =>
  lbl('m_' + k, 'map', topAt(lo, la, .25), k[0].toUpperCase() + k.slice(1), 'city', { dyn: true }));
lbl('m_tengiz', 'map', topAt(53.38, 46.15, .9), 'TENGIZ', 'big', { dyn: true });
lbl('m_karach', 'map', topAt(53.0, 51.35, .6), 'Karachaganak', 'city', { dyn: true });
lbl('m_uzen', 'map', topAt(52.8, 43.35, .6), 'Uzen', 'city', { dyn: true });
[['Zhezkazgan · copper', 67.7, 47.8], ['Karaganda · steel', 73.1, 49.8], ['Balkhash · copper', 75.0, 46.85], ['Pavlodar · aluminium', 76.95, 52.3], ['Oskemen · zinc, titanium', 82.6, 49.95], ['South · uranium', 68.0, 44.9]]
  .forEach(([t, lo, la], i) => lbl('m_v' + i, 'map', topAt(lo, la, .3), t, 'city', { dyn: true }));
BARS.forEach(([lab, v], i) => {
  lbl('b_v' + i, 'chart', () => V(-4.4 + i * 2.2, barObjs[i].scale.y + .1, 0), v.toFixed(1) + '%', 'val', { dyn: true });
  lbl('b_y' + i, 'chart', V(-4.4 + i * 2.2, 0, .7), lab, 'year');
});
lbl('b_t', 'chart', V(-6.6, 5 * BK + .25, .7), 'TARGET 5%', 'cap');
['Oil price or output swings', 'Tenge moves', 'Import prices jump', 'Inflation ↑ → rates ↑'].forEach((t, i) =>
  lbl('n' + i, 'chart', NODES[i].clone().add(V(0, -1.2, 0)), t, 'node' + (i === 3 ? ' red' : '')));
[['1', 'Save the windfall', 'A fiscal rule that parks oil money in the National Fund'], ['2', 'Build the corridor', 'Make Kazakhstan the land bridge between China and Europe'], ['3', 'Add value at home', 'Process our metals here instead of exporting them raw']]
  .forEach(([n, h, b], i) => lbl('p' + i, 'chart', V(PIL[i], -.15, 1.2), `<div class="card"><div class="h"><i>${n}</i>${h}</div><div class="b">${b}</div></div>`, 'pcard'));
lbl('c_fund', 'chart', V(.95, 4.6, 0), 'National Fund', 'cap');
lbl('c_bait', 'chart', V(1.4, .5, .8), 'Baiterek tower, Astana', 'cap');
lbl('c_cost', 'chart', () => { const L = CH.children.find(o => o.userData.L).userData.L; return L.position.clone().add(V(0, 1.9, 0)); }, 'COSTS', 'redcap', { dyn: true });
lbl('c_ben', 'chart', () => { const R = CH.children.find(o => o.userData.R).userData.R; return R.position.clone().add(V(0, 1.9, 0)); }, 'BENEFITS', 'cap', { dyn: true });

// ---- STORY labels
lbl('kz_b', 'chart', () => bubPos(-.4, 13e3).add(V(0, .95, 0)), 'KAZAKHSTAN', 'stk', { dyn: true });
lbl('ax_x', 'chart', V(3.6, -.35, 0), 'Complexity of what a country makes →', 'axis');
lbl('ax_y', 'chart', V(-5.3, 4.9, 0), '↑ Income per person', 'axis');
[['b_jp', 'Japan', 'jp'], ['b_ch', 'Switzerland', 'ch'], ['b_de', 'Germany', 'de'], ['b_us', 'USA', 'us'], ['b_cn', 'China', 'cn'], ['b_ae', 'UAE', 'ae'], ['b_ru', 'Russia', 'ru'], ['b_br', 'Brazil', 'br'], ['b_in', 'India', 'in'], ['b_ml', 'Mali', 'ml'], ['b_cd', 'DR Congo', 'cd']].forEach(([k, t, c]) => {
  const b = BUB.find(x => x[0] === c); lbl(k, 'chart', bubPos(b[1], b[2]).add(V(0, -.52, 0)), t, 'mini');
});
STK.forEach(([c, v, x], i) => {
  lbl('st_v' + i, 'chart', () => V(x, stacks[i].scale.y + .15, 0), '$' + v.toFixed(1) + 'B', 'val', { dyn: true });
  lbl('st_n' + i, 'chart', V(x, -.1, .8), i === 0 ? 'Kazakhstan · crude oil exports' : 'Singapore · refined fuel exports', 'node');
});
lbl('bg_r', 'chart', V(-4.2, -.05, .7), 'Beef patties from Russia', 'node');
lbl('bg_b', 'chart', V(3.2, -.05, 1.3), 'McDonald’s Kazakhstan<br>2016 → Jan 2023', 'node');
lbl('bg_x', 'chart', V(-.5, 3.1, 0), 'sanctions · supply cut', 'redcap');
PIES.forEach(([n, s, x], i) => {
  lbl('pi_n' + i, 'chart', V(x, .2, .4), n, 'stk');
  lbl('pi_v' + i, 'chart', V(x, 4.25, 0), 'Kazakhstan: ' + s[0] + '%', 'gold');
});
lbl('g_tengiz', 'globe', gl(53.38, 46.15), 'Tengiz', 'city', { occl: true });
lbl('g_novo', 'globe', gl(37.77, 44.72), 'Novorossiysk, Russia', 'city', { occl: true });
lbl('g_bsea', 'globe', gl(34, 43.2, 1.004), 'BLACK SEA', 'water', { occl: true });
lbl('g_csea', 'globe', gl(50.6, 42.6, 1.004), 'CASPIAN SEA', 'water', { occl: true });
lbl('g_cpc', 'globe', gl(45, 47.6, 1.02), 'CPC · Caspian Pipeline Consortium', 'cap', { occl: true });

const tmpV = V();
function updateLabels() {
  const w = innerWidth, h = innerHeight;
  for (const L of Object.values(LBL)) {
    if (!L.on && tNow > L.until) continue;
    const p = typeof L.pos === 'function' ? L.pos() : L.pos;
    tmpV.copy(p).project(camera);
    let vis = L.world === active && tmpV.z < 1;
    if (vis && L.occl) { const n = p.clone().normalize(); vis = n.dot(camera.position.clone().sub(p).normalize()) > .12; }
    L.el.classList.toggle('on', L.on && vis);
    L.el.style.transform = `translate(${(tmpV.x * .5 + .5) * w}px,${(-tmpV.y * .5 + .5) * h}px)`;
  }
}

// ------------------------------------------------------------------ slides
const kick = (t, d = .1) => `<div class="kicker a" style="--d:${d}s">${t}</div>`;
const ttl = (t, d = .3, st = '', cls = '') => `<h1 class="title ${cls}" data-d="${d}" style="${st}">${t}</h1>`;
const stat = (n, l, c = 'white', d = 1, nc = false) => `<div class="stat a" style="--d:${d}s"><div class="n ${c}" ${nc ? 'data-nc' : ''} data-d="${d}">${n}</div><div class="l">${l}</div></div>`;
const para = (hh, d = 1, st = '') => `<p class="p a" style="--d:${d}s;${st}">${hh}</p>`;
const src = t => `<div class="src a" style="--d:2.4s">${t}</div>`;
const box = (st, inner) => `<div class="box" style="${st}">${inner}</div>`;
const gcam = (lon, lat, dist, shift = 0, o = {}) => Object.assign({ p: ll2v(lon, lat, dist), t: o.t || V(0, 0, 0), shift }, o);
const mcam = (lon, lat, off, shift, o = {}) => { const t = mp(lon, lat, o.ty || 0); return Object.assign({ p: t.clone().add(off), t, shift }, o); };

const PAPER_CAM = (p, t, shift = 0, orbit = 0) => ({ p, t, shift, orbit });
const SLIDES = [
  { // 1 title
    shade: 'shadeB', world: 'globe', cam: gcam(66, 26, 3.25, .2, { orbit: .018 }), gu: { kz: 1, rus: 0, chn: 0 }, show: [], labels: [],
    html: box('left:4vw;bottom:13vh;width:62vw', kick('ECO 3701 · Policy Proposal', .4) + `<br>` + ttl('KAZAKHSTAN', .7, '', 'hero')
      + `<div class="sub a" style="--d:1.9s">Rich land. One engine.</div><div class="small a" style="--d:2.4s;margin-top:1.4vh">Anatolii Voronin · Fall 2026</div>`)
      + `<div class="orn" style="--d:2.2s;left:4vw;bottom:7vh;width:44vw"></div><div class="sun" style="--d:1.2s;left:4vw;top:7vh;width:7vw;height:7vw"></div>`
  },
  { // 2 landlocked
    world: 'globe', cam: gcam(72, 38, 2.45, .22, { orbit: .012 }), gu: { kz: 1, rus: .8, chn: .8 }, show: ['heart'], labels: ['g_kz', 'g_rus', 'g_chn', 'g_astana', 'g_almaty'],
    html: box('left:4vw;top:11vh;width:31vw', kick('Where we are') + `<br>` + ttl('The biggest country with no sea')
      + stat('9th', 'largest country on Earth', 'gold', .9) + stat('#1', 'largest landlocked country: every export crosses a neighbor', 'white', 1.3, true)
      + stat('20.6 M', 'people on a huge land, between Russia and China', 'teal', 1.7))
      + src('Sources: Bureau of National Statistics (2026); World Bank (2026).')
  },
  { // 3 flag constellation
    shade: 'shadeT', world: 'chart', nobloom: true, cam: PAPER_CAM(V(0, 3.3, 12.6), V(0, 3.25, 0), .03, .004), show: ['bubbles'], labels: ['kz_b', 'ax_x', 'ax_y', 'b_jp', 'b_ch', 'b_de', 'b_us', 'b_cn', 'b_ae', 'b_ru', 'b_br', 'b_in', 'b_ml', 'b_cd'],
    html: box('left:4vw;top:7vh;width:40vw', kick('The big picture') + `<br>` + ttl('Stuck in the middle'))
      + box('right:4vw;bottom:13vh;width:27vw', `<div class="panel a" style="--d:3.6s">` + para('Rich countries make <b>many complex things</b>. The poorest sell <b>one raw thing</b>. Kazakhstan sits right in between.', 3.6, 'margin:0;max-width:none') + `</div>`)
      + src('Schematic positions. Based on Harvard Growth Lab, Atlas of Economic Complexity, and World Bank GDP per capita.')
  },
  { // 4 sell vs buy
    shade: 'shadeT', world: 'chart', nobloom: true, cam: PAPER_CAM(V(0, 2.3, 10.8), V(0, 2.1, 0), 0, 0), show: ['sellbuy'], labels: [],
    html: box('left:4vw;top:7vh;width:40vw', kick('What we sell', .2) + `<br>` + `<div class="stat a" style="--d:.9s"><div class="n gold" data-d=".9">50.5%</div><div class="l">of exports are crude oil and oil products (2025)</div></div>`)
      + box('right:4vw;top:7vh;width:34vw;text-align:right', kick('What we buy', 1.4) + `<br>` + `<div class="stat a" style="--d:1.8s"><div class="n white" data-nc>Finished goods</div><div class="l" style="margin-left:auto">machines, cars, electronics, medicine, mostly from Russia and China</div></div>`)
      + src('Source: Bureau of National Statistics (2026a).')
  },
  { // 5 Singapore
    shade: 'shadeT', world: 'chart', nobloom: true, cam: PAPER_CAM(V(0, 3.4, 12), V(0, 2.9, 0), 0, .01), show: ['stacks'], labels: ['st_v0', 'st_v1', 'st_n0', 'st_n1'],
    html: box('left:4vw;top:7vh;width:60vw', kick('The Singapore paradox') + `<br>` + ttl('No oil, but more oil money', .3, 'font-size:3vw'))
      + box('right:4vw;top:30vh;width:22vw', `<div class="panel a" style="--d:3.3s">` + para('Singapore has <b>no oil at all</b>. It refines other countries’ crude and sells fuel.', 3.3, 'margin:0 0 1.4vh;max-width:none') + para('Kazakhstan has only <b>3 big refineries</b>.', 3.8, 'margin:0;max-width:none') + `</div>`)
      + src('Sources: OEC (2024), refined petroleum exports, Singapore, 2022; Bureau of National Statistics via Reuters (2023), Kazakhstan oil exports, 2022.')
  },
  { // 6 McDonald's
    shade: 'shadeT', world: 'chart', nobloom: true, cam: PAPER_CAM(V(-.4, 2.6, 10.5), V(-.4, 1.5, 0), 0, 0), show: ['burger'], labels: ['bg_r', 'bg_b', 'bg_x'],
    html: box('left:4vw;top:7vh;width:60vw', kick('A small story') + `<br>` + ttl('The McDonald’s lesson'))
      + box('right:4vw;top:9vh;width:26vw', `<div class="panel a" style="--d:3.8s">` + para('The beef came from Russia. After the sanctions, <b>no local supplier</b> could replace it, so the brand left.', 3.8, 'margin:0;max-width:none') + `</div>`)
      + `<div class="meme2 a" style="--d:4.4s"><svg viewBox="0 0 200 170" class="sadb">
  <g class="body">
    <path d="M30 78 Q30 22 100 20 Q170 22 170 78 Z" class="bt"/>
    <ellipse cx="70" cy="40" rx="5" ry="2.5" class="sd"/><ellipse cx="100" cy="32" rx="5" ry="2.5" class="sd"/><ellipse cx="128" cy="42" rx="5" ry="2.5" class="sd"/><ellipse cx="88" cy="55" rx="5" ry="2.5" class="sd"/><ellipse cx="118" cy="58" rx="5" ry="2.5" class="sd"/>
    <path d="M24 80 Q40 92 56 82 Q72 94 88 82 Q104 94 120 82 Q136 94 152 82 Q168 92 176 80 L176 86 L24 86 Z" class="lt"/>
    <path d="M26 86 L174 86 L160 98 L40 98 Z" class="ch"/>
    <rect x="34" y="96" width="132" height="22" rx="10" class="pt"/>
    <path d="M36 118 L164 118 Q164 142 100 144 Q36 142 36 118 Z" class="bb"/>
    <path d="M72 62 Q80 56 88 62" class="brow"/><path d="M112 62 Q120 56 128 62" class="brow"/>
    <circle cx="80" cy="70" r="5" class="eye"/><circle cx="120" cy="70" r="5" class="eye"/>
    <path d="M86 112 Q100 102 114 112" class="mouth"/>
    <path d="M80 76 q-3 8 0 12 q3 -4 0 -12" class="tear t1"/><path d="M120 76 q-3 8 0 12 q3 -4 0 -12" class="tear t2"/>
    <path d="M30 106 L8 92" class="arm"/><path d="M170 106 L192 92" class="arm"/>
    <path d="M78 144 L74 162" class="arm"/><path d="M122 144 L126 162" class="arm"/>
  </g></svg><div class="mcap"><div class="mt">POV: your only beef supplier gets sanctioned</div><div class="ms">“guys… we messed up”</div></div></div>`
      + src('Source: Reuters (2023, January 4), McDonald’s set to exit Kazakhstan over Russian supply curbs.')
  },
  { // 7 three whales
    shade: 'shadeT', world: 'chart', nobloom: true, cam: PAPER_CAM(V(0, 3.2, 12.5), V(0, 2.1, 0), 0, 0), show: ['pies'], labels: ['pi_n0', 'pi_n1', 'pi_n2', 'pi_v0', 'pi_v1', 'pi_v2'],
    html: box('left:4vw;top:7vh;width:60vw', kick('The three whales') + `<br>` + ttl('Whose oil is it?'))
      + box('left:0;right:0;bottom:11vh;text-align:center', `<div class="a" style="--d:3.6s;font-size:1.5vw;font-weight:700">Our 3 biggest fields make most of our oil. <span style="color:var(--gold)">Gold</span> is the state’s share. The rest belongs to foreign companies.</div>`)
      + src('Source: The Times of Central Asia (2026), shareholder structures of Tengiz, Kashagan and Karachaganak.')
  },
  { // 8 pipeline via Russia
    world: 'globe', cam: gcam(47, 39, 1.95, .22, { t: ll2v(47, 45, .62), orbit: 0 }), gu: { kz: 1, rus: .5, chn: 0 }, show: ['cpc'], labels: ['g_tengiz', 'g_novo', 'g_bsea', 'g_csea', 'g_cpc'],
    html: box('left:4vw;top:11vh;width:31vw', kick('And then') + `<br>` + ttl('The oil leaves through Russia')
      + stat('80%+', 'of our pipeline crude exports go through the CPC (Caspian Pipeline Consortium) pipeline to Russia’s Black Sea coast', 'gold', 1.0)
      + stat('20.75%', 'Kazakhstan’s share of that pipeline', 'white', 1.5))
      + src('Source: Interfax (2026, May 25), CPC shareholders and export volumes.')
  },
  { // 9 the cost
    shade: 'shadeT', world: 'chart', nobloom: true, cam: { p: V(-2.2, 4.6, 15.5), t: V(-1.4, 2.5, 0), shift: -.2, orbit: .01 }, show: ['bars'], labels: ['b_v0', 'b_v1', 'b_v2', 'b_v3', 'b_v4', 'b_y0', 'b_y1', 'b_y2', 'b_y3', 'b_y4', 'b_t'],
    html: box('left:4vw;top:7vh;width:60vw', kick('What it costs people') + `<br>` + ttl('Growth people can’t feel'))
      + box('right:4vw;top:30vh;width:27vw', `<div class="small a" style="--d:.6s;margin-bottom:2vh;letter-spacing:.2em">ANNUAL INFLATION, %</div>`
      + stat('~16%', 'interest rate: loans stay expensive', 'gold', 3.2) + stat('2% drop', 'in real wages: prices rose faster than paychecks', 'red', 3.7))
      + src('Sources: Bureau of National Statistics (2026c); National Bank of Kazakhstan (2026); World Bank (2026a).')
  },
  { // 10 plan
    shade: 'shadeT', world: 'chart', nobloom: true, cam: { p: V(0, 3.9, 13.5), t: V(0, 1.7, 0), shift: 0, orbit: .008 }, show: ['pillars'], labels: ['p0', 'p1', 'p2'],
    html: box('left:4vw;top:7vh;width:70vw', kick('My plan') + `<br>` + ttl('Build a second engine'))
  },
  { // 11 UAE
    shade: 'shadeT', world: 'chart', nobloom: true, cam: { p: V(0, 3.9, 13.5), t: V(0, 1.7, 0), shift: 0, orbit: 0 }, show: [], labels: [],
    html: box('left:4vw;top:7vh;width:70vw', kick('Proof it works') + `<br>` + ttl('The UAE did it'))
      + box('left:6vw;right:6vw;top:31vh;display:grid;grid-template-columns:1fr 1fr;gap:4vw',
        `<div class="tm a" style="--d:.8s"><div class="tmh"><span class="yr">1995</span> 🇦🇪</div><div class="tmb">`
        + `<div class="blk oil" style="flex:61.9"><div class="mid"><div class="ico">🛢️</div><div class="cap">Crude oil</div></div><b>61.9%</b></div>`
        + `<div class="blk g1" style="flex:38.1"><div class="mid"><div class="ico sm">📦</div><div class="cap">Everything else</div></div><b>38.1%</b></div></div></div>`
        + `<div class="tm a" style="--d:2.2s"><div class="tmh"><span class="yr">2024</span> 🇦🇪</div><div class="tmb">`
        + `<div class="blk n1" style="flex:75.5"><div class="mid"><div class="icos"><span>🛍️</span><span>✈️</span><span>🏦</span><span>🏭</span><span>🏗️</span><span>🏙️</span></div><div class="cap">Non oil: trade, tourism, finance, factories</div></div><b>75.5%</b></div>`
        + `<div class="blk oil" style="flex:24.5"><div class="mid"><div class="ico sm">🛢️</div><div class="cap">Oil</div></div><b>24.5%</b></div></div></div>`)
      + src('Sources: OEC (2024), UAE exports 1995; The National (2025, June 15), UAE GDP 2024, non oil share of real GDP.')
  },
  { // 12 closing
    shade: 'shadeB', world: 'globe', cam: gcam(64, 24, 4.1, .2, { t: V(0, -.32, 0), orbit: .025 }), gu: { kz: 1, rus: 0, chn: 0 }, show: ['close'], labels: [],
    html: box('left:4vw;right:4vw;bottom:10vh', kick('From a pipeline to a crossroads', .3) + `<br>` + ttl('Save the windfall. Build the corridor. Add value at home.', .6, 'font-size:2.6vw;margin-bottom:2.4vh')
      + `<div class="sub a" style="--d:2.6s;font-size:1.7vw">Thank you! Please don’t ask me any questions.</div>`
      + `<div class="a" style="--d:5.4s;font-size:1.6vw;font-weight:800;color:var(--gold);margin-top:1vh;text-shadow:0 0 24px rgba(255,200,69,.6)">Just kidding. Questions are welcome :)</div>`)
      + `<div class="orn" style="--d:1.4s;left:4vw;bottom:5vh;width:44vw"></div><div class="sun" style="--d:1s;left:4vw;top:7vh;width:6vw;height:6vw"></div>`
  },
  { // 13 references
    world: 'globe', cam: gcam(110, 15, 5.2, .33, { orbit: .02 }), gu: { kz: .6, rus: 0, chn: 0, land: .6 }, show: [], labels: [],
    html: box('left:4vw;top:7vh;width:58vw', ttl('References', .2, 'font-size:2.2vw') + `<div class="refs a" style="--d:.6s">` + [
      'Bureau of National Statistics of Kazakhstan. (2026a, b, c). Foreign trade; GDP; inflation statistics. stat.gov.kz',
      'Harvard Growth Lab. (n.d.). The Atlas of Economic Complexity. atlas.hks.harvard.edu',
      'Interfax. (2026, May 25). CPC remains key route for Kazakh oil exports. interfax.com',
      'National Bank of Kazakhstan. (2026). Base rate decisions. nationalbank.kz',
      'OEC. (2024). Refined petroleum exports, Singapore 2022; Exports of the United Arab Emirates 1995. oec.world',
      'Reuters. (2023, January 4). McDonald’s set to exit Kazakhstan over Russian supply curbs.',
      'Reuters. (2023, May 2). Kazakhstan’s oil export revenues rose by 50% in 2022.',
      'The National. (2025, June 15). UAE economy grows 4% in 2024 as non oil sectors expand.',
      'The Times of Central Asia. (2026). Kashagan and Karachaganak: shareholder structure.',
      'World Bank. (2026a). Kazakhstan: Economic overview; (2026b) World Development Indicators.'
    ].map(r => `<p>${r}</p>`).join('') + `</div>`)
      + `<div class="meme a" style="--d:1.6s"><svg viewBox="0 0 240 250" class="besh">
  <g class="notes"><text x="30" y="60" class="nt n1">♪</text><text x="200" y="50" class="nt n2">♫</text><text x="215" y="120" class="nt n3">♪</text></g>
  <g class="dancer">
    <g class="leg l"><path d="M100 178 L92 222" /><ellipse cx="86" cy="226" rx="14" ry="6" class="shoe"/></g>
    <g class="leg r"><path d="M140 178 L148 222" /><ellipse cx="154" cy="226" rx="14" ry="6" class="shoe"/></g>
    <g class="arm l"><path d="M58 150 Q34 128 30 100" /><circle cx="30" cy="98" r="7" class="hand"/></g>
    <g class="arm r"><path d="M182 150 Q206 128 210 100" /><circle cx="210" cy="98" r="7" class="hand"/></g>
    <ellipse cx="120" cy="168" rx="72" ry="20" class="plate"/>
    <ellipse cx="120" cy="164" rx="60" ry="14" class="orn"/>
    <path d="M62 160 Q66 112 120 104 Q174 112 178 160 Z" class="heap"/>
    <rect x="72" y="138" width="20" height="16" rx="4" class="noodle" transform="rotate(-12 82 146)"/>
    <rect x="146" y="136" width="20" height="16" rx="4" class="noodle" transform="rotate(14 156 144)"/>
    <rect x="100" y="148" width="18" height="14" rx="4" class="noodle" transform="rotate(6 109 155)"/>
    <ellipse cx="128" cy="150" rx="11" ry="7" class="meat"/><ellipse cx="88" cy="126" rx="9" ry="6" class="meat"/><ellipse cx="160" cy="124" rx="9" ry="6" class="meat"/>
    <ellipse cx="140" cy="158" rx="9" ry="4" class="onion"/><ellipse cx="78" cy="152" rx="8" ry="4" class="onion"/>
    <circle cx="104" cy="124" r="9" class="eye"/><circle cx="136" cy="124" r="9" class="eye"/>
    <circle cx="106" cy="126" r="4" class="pupil"/><circle cx="138" cy="126" r="4" class="pupil"/>
    <path d="M106 138 Q120 150 134 138" class="smile"/>
    <path d="M92 104 L120 62 L148 104 Z" class="kalpak"/><path d="M90 104 Q120 112 150 104 L150 96 Q120 104 90 96 Z" class="brim"/>
    <path d="M106 90 l6 -8 l6 8 l6 -8 l6 8" class="kpat"/>
  </g></svg><div class="mcap"><div class="mt">Me after zero questions</div><div class="ms">beshbarmak.exe has started dancing</div></div></div>`
  }
];

// build slide DOM
const ui = document.getElementById('ui');
SLIDES.forEach(s => {
  const el = document.createElement('div'); el.className = 'slide'; el.innerHTML = `<div class="${s.shade || 'shadeL'}"></div>` + s.html; ui.appendChild(el); s.el = el;
  el.querySelectorAll('.title').forEach(t => {
    const d0 = parseFloat(t.dataset.d || 0); let k = 0;
    t.innerHTML = t.textContent.split(' ').map(w => `<span style="display:inline-block;white-space:nowrap">` +
      [...w].map(ch => `<span class="ch" style="--d:${(d0 + (k++) * .028).toFixed(3)}s">${ch}</span>`).join('') + `</span>`).join('<span class="sp"></span>');
  });
});

// count up
const COUNTS = [];
function startCounts(s) {
  s.el.querySelectorAll('.n').forEach(n => {
    if (n.hasAttribute('data-nc')) return;
    const txt = n.dataset.txt || (n.dataset.txt = n.textContent);
    const m = txt.match(/^(.*?)([\d,]+(?:\.\d+)?)(.*)$/); if (!m) return;
    const dec = (m[2].split('.')[1] || '').length, comma = m[2].includes(','), val = parseFloat(m[2].replace(/,/g, ''));
    const fmt = v => { let s2 = v.toFixed(dec); if (comma) s2 = Number(s2).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec }); return m[1] + s2 + m[3]; };
    n.textContent = fmt(0);
    COUNTS.push({ n, fmt, val, t0: tNow + parseFloat(n.dataset.d || 0) + .25 + (s.dipDelay || 0), dur: 1.6 });
  });
}
function updateCounts() {
  for (let i = COUNTS.length - 1; i >= 0; i--) {
    const c = COUNTS[i], u = clamp((tNow - c.t0) / c.dur, 0, 1);
    c.n.textContent = c.fmt(c.val * (1 - Math.pow(1 - u, 3)));
    if (u >= 1) COUNTS.splice(i, 1);
  }
}

// ------------------------------------------------------------------ camera & navigation
let cur = -1, TOKEN = 0, slideT0 = 0, tw = null, lastNav = 0;
const camState = { shift: 0 };
function setShift(sh) {
  const w = innerWidth, h = innerHeight;
  if (Math.abs(sh) < 1e-4) camera.clearViewOffset(); else camera.setViewOffset(w, h, -sh * w, 0, w, h);
}
function startTween(to, from, dur, globeMode) {
  tw = { fp: from.p.clone(), ft: from.t.clone(), fs: from.shift, tp: to.p.clone(), tt: to.t.clone(), ts: to.shift, t0: tNow, dur, globe: globeMode, lift: globeMode ? 0 : .8 };
}
let camT = V();
function updateCamera() {
  if (!tw) return;
  const u = clamp((tNow - tw.t0) / tw.dur, 0, 1), e = ease(u);
  const tg = tw.ft.clone().lerp(tw.tt, e), sh = tw.fs + (tw.ts - tw.fs) * e;
  let p;
  if (tw.globe) { const r = tw.fp.length() + (tw.tp.length() - tw.fp.length()) * e; p = slerpV(tw.fp.clone().normalize(), tw.tp.clone().normalize(), e).multiplyScalar(r); }
  else { p = tw.fp.clone().lerp(tw.tp, e); p.y += Math.sin(PI * e) * tw.lift; }
  const S = SLIDES[cur], ang = (tNow - slideT0) * (S.cam.orbit || 0);
  p = tg.clone().add(p.clone().sub(tg).applyAxisAngle(Y, ang));
  const dist = p.distanceTo(tg);
  p.x += Math.sin(tNow * .27) * .006 * dist; p.y += Math.sin(tNow * .21 + 1) * .005 * dist;
  camera.position.copy(p); camera.lookAt(tg); camT = tg; camState.shift = sh; setShift(sh);
}
function fromPose() { return { p: camera.position.clone(), t: camT.clone(), shift: camState.shift }; }
function entryPose(S) {
  const c = S.cam;
  if (S.world === 'globe') return { p: c.p.clone().multiplyScalar(1.7), t: c.t.clone(), shift: c.shift };
  if (S.world === 'map') return { p: c.p.clone().add(V(-1, 9, 8)), t: c.t.clone().add(V(0, 0, -1)), shift: c.shift };
  return { p: c.p.clone().add(V(-2.5, 2.5, 5)), t: c.t.clone(), shift: c.shift };
}
const dip = document.getElementById('dip'), prog = document.querySelector('#progress i'), countEl = document.getElementById('count'), hint = document.getElementById('hint');
function applySlideState(S, delay) {
  for (const it of REG) {
    const show = it.tags.some(t => S.show.includes(t));
    if (show && it.tgt === 0) it.t0 = tNow + delay;
    it.tgt = show ? 1 : 0;
    if (!show && it.cur > 0 && delay > 0) it.cur = 0;
  }
  for (const [k, L] of Object.entries(LBL)) { const on = S.labels.includes(k); if (L.on && !on) L.until = tNow + 1; L.on = false; if (on) setTimeout(() => { if (SLIDES[cur] === S) L.on = true; }, (delay + .9) * 1000); }
  if (S.gu) Object.assign(GUt, { kz: 1, rus: 0, chn: 0, land: 1 }, S.gu);
}
function goTo(i, o = {}) {
  i = clamp(i, 0, SLIDES.length - 1);
  if (i === cur && !o.force) return;
  const prev = SLIDES[cur], S = SLIDES[i], tok = ++TOKEN;
  if (prev) prev.el.classList.remove('on');
  const switching = !prev || prev.world !== S.world;
  cur = i; prog.style.width = ((i + 1) / SLIDES.length * 100) + '%';
  countEl.textContent = String(i + 1).padStart(2, '0') + ' / ' + SLIDES.length;
  const begin = (dipDelay) => {
    if (tok !== TOKEN) return;
    slideT0 = tNow;
    S.dipDelay = 0;
    if (S.mode) { setMode(S.mode); if (switching) { snapHex(); if (S.mode === 'land') for (let k = 0; k < H.n; k++) if (H.code[k] === 3) { H.h[k] = .03; H.col.set(WATER, k * 3); H.glow.set([.03, .2, .26], k * 3); } } }
    applySlideState(S, 0);
    bloom.enabled = QL[qLevel].bloom && !S.nobloom;
    S.el.classList.add('on');
    startCounts(S);
    if (S.enter) S.enter(tok);
  };
  if (o.intro) {
    active = S.world; renderPass.scene = W[active];
    startTween(S.cam, { p: ll2v(20, 5, 11), t: V(), shift: 0 }, 5.5, true); slideT0 = tNow;
    setTimeout(() => begin(0), 900);
  } else if (switching) {
    dip.classList.add('on');
    setTimeout(() => {
      if (tok !== TOKEN) return;
      active = S.world; renderPass.scene = W[active];
      startTween(S.cam, o.instant ? S.cam : entryPose(S), o.instant ? .01 : 3.0, S.world === 'globe');
      slideT0 = tNow;
      if (S.world !== 'globe') updateHexOnce = true;
      begin(0);
      dip.classList.remove('on');
    }, o.instant ? 0 : 480);
  } else {
    startTween(S.cam, fromPose(), 2.8, S.world === 'globe'); slideT0 = tNow;
    setTimeout(() => begin(0), 250);
  }
}
let updateHexOnce = false;
function nav(d) {
  if (tNow - lastNav < .35) return; lastNav = tNow;
  hint.classList.add('off');
  goTo(cur + d);
}
addEventListener('keydown', e => {
  if (['ArrowRight', 'PageDown', ' ', 'Enter', 'ArrowDown'].includes(e.key)) { e.preventDefault(); nav(1); }
  else if (['ArrowLeft', 'PageUp', 'ArrowUp', 'Backspace'].includes(e.key)) { e.preventDefault(); nav(-1); }
  else if (e.code === 'KeyF' || e.key === 'f' || e.key === 'F' || e.key === 'а' || e.key === 'А') toggleFS();
  else if (e.key === 'Home') goTo(0);
  else if (e.key === 'End') goTo(SLIDES.length - 1);
});
function toggleFS() {
  const d = document, el = d.documentElement;
  const isFS = d.fullscreenElement || d.webkitFullscreenElement;
  try {
    if (!isFS) (el.requestFullscreen || el.webkitRequestFullscreen).call(el);
    else (d.exitFullscreen || d.webkitExitFullscreen).call(d);
  } catch (err) {}
}
document.getElementById('fs').addEventListener('click', e => { e.stopPropagation(); toggleFS(); });
addEventListener('dblclick', e => { e.preventDefault(); });
addEventListener('click', e => { if (e.button === 0) nav(1); });
addEventListener('contextmenu', e => { e.preventDefault(); nav(-1); });
let idleT;
addEventListener('mousemove', () => { document.body.classList.remove('idle'); clearTimeout(idleT); idleT = setTimeout(() => document.body.classList.add('idle'), 2000); });
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight); composer.setSize(innerWidth, innerHeight); bloom.resolution.set(innerWidth, innerHeight);
  dotsMat.uniforms.uSize.value = 5 * QL[qLevel].pr * innerHeight / 1000;
});

// ------------------------------------------------------------------ adaptive quality
const QL = [
  { name: 'high', pr: Math.min(DPR, 2), bloom: true },
  { name: 'medium', pr: 1, bloom: true },
  { name: 'low', pr: .75, bloom: false },
  { name: 'lowest', pr: .55, bloom: false }
];
let qLevel = 0, qAuto = true;
const toast = document.createElement('div'); toast.id = 'qtoast'; document.body.appendChild(toast);
let toastT;
function showToast(t) { toast.textContent = t; toast.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => toast.classList.remove('on'), 1800); }
function applyQuality(l, why) {
  qLevel = clamp(l, 0, QL.length - 1); const q = QL[qLevel];
  renderer.setPixelRatio(q.pr); composer.setPixelRatio(q.pr);
  renderer.setSize(innerWidth, innerHeight); composer.setSize(innerWidth, innerHeight);
  bloom.enabled = q.bloom && !(SLIDES[cur] && SLIDES[cur].nobloom);
  dotsMat.uniforms.uSize.value = 5 * q.pr * innerHeight / 1000;
  try { localStorage.setItem('kzq2', String(qLevel)); } catch (e) {}
  if (why) showToast('Quality: ' + q.name + ' (' + why + ')');
}
try { const sv = parseInt(localStorage.getItem('kzq2'), 10); if (sv > 0) applyQuality(sv); } catch (e) {}
const qm = location.search.match(/q=(\w+)/); if (qm) { const i = QL.findIndex(x => x.name === qm[1]); if (i >= 0) { applyQuality(i); qAuto = false; } }
let fpsN = 0, fpsT = clock(), slow = 0;
function watchFps() {
  fpsN++;
  const el = tNow - fpsT;
  if (el < 2) return;
  const fps = fpsN / el; fpsN = 0; fpsT = tNow;
  if (!qAuto || tNow < 4 || document.hidden) return;
  if (fps < 40 && qLevel < QL.length - 1) { if (++slow >= 2) { slow = 0; applyQuality(qLevel + 1, 'auto, ' + Math.round(fps) + ' fps'); } }
  else slow = 0;
}
addEventListener('keydown', e => {
  if (e.code === 'KeyQ') { qAuto = false; applyQuality((qLevel + 1) % QL.length, 'manual'); }
});

// ------------------------------------------------------------------ loop
let last = clock();
function frame() {
  requestAnimationFrame(frame);
  tNow = clock(); const dt = Math.min(.05, tNow - last); last = tNow;
  updateCamera();
  for (const m of FLOW) m.uniforms.uT.value = tNow;
  const u = dotsMat.uniforms, k = Math.min(1, dt * 2);
  GU.kz += (GUt.kz - GU.kz) * k; GU.rus += (GUt.rus - GU.rus) * k; GU.chn += (GUt.chn - GU.chn) * k; GU.land += (GUt.land - GU.land) * k;
  u.uT.value = tNow; u.uKZ.value = GU.kz * (.85 + .15 * Math.sin(tNow * 2.2)); u.uRUS.value = GU.rus; u.uCHN.value = GU.chn; u.uLand.value = GU.land;
  updateReg(dt);
  if (active === 'map') updateHex(dt);
  composer.render();
  updateLabels(); updateCounts(); watchFps();
}
const m0 = location.hash.match(/^#(\d+)/);
setMode('land'); snapHex();
if (m0) goTo(parseInt(m0[1], 10) - 1, { instant: true, force: true }); else goTo(0, { intro: true });
(function warm() {
  const vis = []; for (const sc of Object.values(W)) sc.traverse(o => { vis.push([o, o.visible]); o.visible = true; o.traverse(x => { if (x.material) (Array.isArray(x.material) ? x.material : [x.material]).forEach(m => { if (m.map) renderer.initTexture(m.map); }); }); });
  for (const sc of Object.values(W)) { if (sc.background && sc.background.isTexture) renderer.initTexture(sc.background); renderer.compile(sc, camera); }
  vis.forEach(([o, v]) => o.visible = v);
})();
frame();
setTimeout(() => hint.classList.add('off'), 9000);
window.__goTo = goTo;
})();
