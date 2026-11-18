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
for (const s of Object.values(W)) { addStars(s, 3500, 150, 1.3, .7); addStars(s, 500, 150, 2.4, .9); }

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
  fl.rotation.x = -PI / 2; CH.add(fl);
  const grid = new T.GridHelper(80, 80, 0x123247, 0x0b1c2a); grid.position.y = .002; grid.material.transparent = true; grid.material.opacity = .5; CH.add(grid);
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

const SLIDES = [
  { // 1 title
    shade: 'shadeB', world: 'globe', cam: gcam(66, 26, 3.25, .2, { orbit: .018 }), gu: { kz: 1, rus: 0, chn: 0 }, show: [], labels: [],
    html: box('left:4vw;bottom:13vh;width:60vw', kick('ECO 3701 · The Global Economy · Policy Proposal', .4) + ttl('KAZAKHSTAN', .7, '', 'hero')
      + `<div class="sub a" style="--d:1.9s">Building a second engine for the economy of the steppe</div><div class="small a" style="--d:2.4s;margin-top:1.4vh">Anatolii Voronin · Fall 2026</div>`)
      + `<div class="orn" style="--d:2.2s;left:4vw;bottom:7vh;width:44vw"></div><div class="sun" style="--d:1.2s;left:4vw;top:7vh;width:7vw;height:7vw"></div>`
  },
  { // 2 heart of Eurasia
    world: 'globe', cam: gcam(72, 38, 2.45, .22, { orbit: .012 }), gu: { kz: 1, rus: .8, chn: .8 }, show: ['heart'], labels: ['g_kz', 'g_rus', 'g_chn', 'g_astana', 'g_almaty'],
    html: box('left:4vw;top:11vh;width:31vw', kick('Where we are') + ttl('The heart of Eurasia') + stat('9th', 'largest country on Earth and the largest landlocked one', 'gold', .9)
      + stat('20.6 M', 'people (Aug 2026): a small population on a huge land', 'white', 1.3) + stat('1991', 'independence from the USSR · new constitution in force June 30, 2026', 'teal', 1.7, true))
      + src('Sources: Bureau of National Statistics (2026a, 2026b); Reuters (2026a).')
  },
  { // 3 the land / Aral
    world: 'map', cam: mcam(61.5, 46.5, V(2.6, 9.4, 12), .24, { orbit: .008 }), mode: 'land', show: [], labels: ['m_aral', 'm_caspian', 'm_rus', 'm_uzb', 'm_shipcap'],
    html: box('left:4vw;top:11vh;width:33vw', kick('The land') + ttl('Steppe, desert and a vanished sea')
      + para('<b>Steppe, desert and semi desert</b> cover most of the country; mountains rise in the east and south east along China and Kyrgyzstan.', 1)
      + para('<b>A Caspian coast, but no ocean:</b> every export has to cross someone else’s territory.', 1.4)
      + para('<b>The Aral Sea</b> shrank after Soviet era water diversion, a reminder of what happens when one resource is over used.', 1.8))
      + src('Source: Part 1 country overview (Bureau of National Statistics, 2026; Reuters, 2026a).')
  },
  { // 4 economy
    world: 'map', cam: mcam(67.5, 46, V(0, 19, 17.5), .2, { orbit: .006 }), mode: 'econ', show: [], labels: ['m_astana', 'm_almaty', 'm_shymkent', 'm_atyrau', 'm_karaganda'],
    html: box('left:4vw;top:11vh;width:34vw', kick('The economy today') + ttl('Central Asia’s largest economy')
      + `<div style="display:grid;grid-template-columns:1fr 1fr;gap:0 2vw">` + stat('$306.2B', 'GDP, 2025', 'white', .9) + stat('$14,692', 'GDP per capita, upper middle income', 'white', 1.2)
      + stat('+6.5%', 'real GDP growth in 2025 (+4.1% in H1 2026)', 'teal', 1.5) + stat('4.5%', 'unemployment, Q2 2026', 'teal', 1.8) + `</div>`
      + para('<b>But where does this growth come from?</b>', 2.6))
      + src('Sources: World Bank (2026a, 2026b); Bureau of National Statistics (2026a, 2026b).')
  },
  { // 5 oil
    world: 'map', cam: mcam(53.6, 46.4, V(5.2, 3.6, 7.2), .2, { ty: .9, orbit: .03 }), mode: 'oil', show: ['oil'], labels: ['m_tengiz', 'm_karach', 'm_atyrau'],
    html: box('left:4vw;top:11vh;width:31vw', kick('Engine #1') + ttl('Oil pays the bills') + stat('50.5%', 'of all merchandise exports were crude oil and oil products (2025)', 'gold', .9)
      + stat('+13.5%', 'oil output in 2025 after the Tengiz expansion, the main driver of record growth', 'white', 1.3)
      + stat('$79.0B', 'exports (down 3.2%) vs $64.8B imports (+7.4%). Top buyers: Italy, China, Russia', 'white', 1.7))
      + src('Sources: Bureau of National Statistics (2026a); World Bank (2026a).')
  },
  { // 6 trade
    shade: 'shadeB', world: 'globe', cam: gcam(64, 34, 3.0, 0, { t: V(0, -.2, 0), orbit: .01 }), gu: { kz: 1, rus: 0, chn: 0 }, show: ['trade'], labels: ['g_italy', 'g_china', 'g_russia'],
    html: box('left:4vw;bottom:8vh;right:4vw', kick('Who we trade with') + `<div style="display:grid;grid-template-columns:1fr 1.5fr 1.3fr;gap:3vw">`
      + stat('$143.9B', 'total goods trade, 2025 (+1.3%)', 'white', .9) + stat('Italy · China · Russia', 'top export markets; Russia and China supply most imports', 'gold sm', 1.3, true)
      + stat('57.2%', 'of GDP is trade (2024), down from 68.3% in 2022', 'teal', 1.7) + `</div>`)
      + src('Sources: Bureau of National Statistics (2026a); World Bank via Lloyds Bank Trade (2026). Arcs are schematic.')
  },
  { // 7 inflation
    shade: 'shadeT', world: 'chart', cam: { p: V(-2.2, 4.6, 15.5), t: V(-1.4, 2.5, 0), shift: -.2, orbit: .01 }, show: ['bars'], labels: ['b_v0', 'b_v1', 'b_v2', 'b_v3', 'b_v4', 'b_y0', 'b_y1', 'b_y2', 'b_y3', 'b_y4', 'b_t'],
    html: box('left:4vw;top:8vh;width:60vw', kick('The problem') + ttl('Growth that people can’t feel'))
      + box('right:4vw;top:30vh;width:27vw', `<div class="small a" style="--d:.6s;margin-bottom:2vh;letter-spacing:.2em">ANNUAL INFLATION, %</div>`
      + stat('18% → 15.75%', 'National Bank base rate, early 2026 → Oct 2026. Loans stay expensive.', 'gold', 3.2, true)
      + stat('2% drop', 'in real wages, Q3 2025: prices rose faster than paychecks', 'red', 3.7))
      + src('Sources: World Bank (2026a); Bureau of National Statistics (2026c); National Bank of Kazakhstan (2026); Regxplora (2026).')
  },
  { // 8 chain
    shade: 'shadeT', world: 'chart', cam: { p: V(0, 3.6, 12.5), t: V(0, .6, -.3), shift: 0, orbit: .01 }, show: ['chain'], labels: ['n0', 'n1', 'n2', 'n3'],
    html: box('left:4vw;top:8vh;width:70vw', kick('Root cause') + ttl('One engine = one big risk'))
      + box('left:4vw;right:4vw;bottom:9vh;display:grid;grid-template-columns:1fr 1fr;gap:3vw',
        para('<b>A floating tenge:</b> its value is set by supply and demand for dollars, so oil revenue and global markets push it around.', 5.2, 'max-width:none')
        + para('<b>Rates fight inflation, not the currency:</b> the National Bank targets prices, so when the tenge falls, it must keep loans expensive for everyone.', 5.6, 'max-width:none'))
      + box('left:0;right:0;top:25vh;text-align:center', `<div class="a" style="--d:6.4s;font-size:1.7vw;font-weight:700;color:var(--gold);text-shadow:0 0 30px rgba(255,200,69,.5)">Kazakhstan is not short of money. It is short of diversity.</div>`)
      + src('Sources: National Bank of Kazakhstan (n.d.); Regxplora (2026).')
  },
  { // 9 paradox
    shade: 'shadeR', world: 'globe', cam: gcam(40, 30, 2.95, -.2, { orbit: -.008 }), gu: { kz: 1, rus: 0, chn: 0 }, show: ['paradox'], labels: ['g_profit'],
    html: box('right:4vw;top:11vh;width:32vw', kick('The paradox') + ttl('Selling more than we buy, and still borrowing', .3, 'font-size:2.6vw')
      + stat('$13.1B', 'current account deficit in 2025, despite a goods trade surplus', 'red', .9)
      + stat('$173.4B', 'stock of foreign direct investment: owners abroad collect the oil and mining profits', 'white', 1.3)
      + stat('+$2.4B', 'surplus in H1 2026: the account swings from borrower to lender within a year', 'teal', 1.7))
      + `<div class="src a" style="--d:2.4s;left:auto;right:4vw">Sources: Government of Kazakhstan (2026); U.S. Department of State (2024).</div>`
  },
  { // 10 proposal
    shade: 'shadeT', world: 'chart', cam: { p: V(0, 3.9, 13.5), t: V(0, 1.7, 0), shift: 0, orbit: .008 }, show: ['pillars'], labels: ['p0', 'p1', 'p2'],
    html: box('left:4vw;top:8vh;width:70vw', kick('My policy proposal') + ttl('Build a second engine', .3, 'font-size:4vw'))
  },
  { // 11 save the windfall
    world: 'chart', cam: { p: V(4.6, 3.7, 11.2), t: V(0, 2.55, 0), shift: .24, orbit: .045 }, show: ['fund'], labels: ['c_fund', 'c_bait'],
    html: box('left:4vw;top:11vh;width:33vw', kick('My proposal · Step 1 of 3') + ttl('Save the oil windfall')
      + para('<b>A strict fiscal rule:</b> every dollar of oil revenue above a conservative reference price goes into the National Fund, not into today’s budget.', 1)
      + para('<b>Why it helps:</b> less money chasing goods → lower inflation; a steadier tenge; a cushion when oil falls.', 1.5)
      + para('<b>Works with the National Bank:</b> fiscal discipline lets it cut rates toward the 5% target faster.', 2))
  },
  { // 12 corridor
    shade: 'shadeB', world: 'globe', cam: gcam(58, 34, 2.85, 0, { t: V(0, -.14, 0), orbit: .006 }), gu: { kz: 1, rus: 0, chn: 0 }, show: ['corridor'], labels: ['g_khorgos', 'g_aktau', 'g_baku', 'g_europe', 'g_china2', 'g_north', 'g_caspian'],
    html: box('left:4vw;right:4vw;bottom:7vh', `<div class="panel a" style="--d:.2s;display:grid;grid-template-columns:1.1fr 1fr;gap:3vw;align-items:center">`
      + `<div>${kick('Step 2 of 3 · The Middle Corridor', .4)}${ttl('Turn geography into a business', .6, 'font-size:2.6vw;margin-bottom:1.5vh')}`
      + para('Earns dollars from services, not barrels, and uses the EAEU, WTO and EU partnership access we already have.', 1.6, 'margin:0') + `</div>`
      + para('Invest in rail, the <b>Khorgos dry port</b> on the Chinese border and <b>Aktau port</b> on the Caspian, plus digital customs, so China to Europe cargo crosses Kazakhstan.', 1.2, 'margin:0;max-width:none') + `</div>`)
      + `<div class="src a" style="--d:2.4s;bottom:2vh">Trade agreements: Lloyds Bank Trade (2026). Route is schematic.</div>`
  },
  { // 13 add value
    world: 'map', cam: mcam(74, 49, V(-1.5, 8.6, 10.2), .22, { orbit: .01 }), mode: 'value', show: ['value'], labels: ['m_v0', 'm_v1', 'm_v2', 'm_v3', 'm_v4', 'm_v5'],
    enter: tok => setTimeout(() => { if (tok === TOKEN) setMode('value2'); }, 2900),
    html: box('left:4vw;top:11vh;width:31vw', kick('Step 3 of 3 · Add value at home') + ttl('Sell products, not just rocks')
      + para('<b>Tax breaks</b> and cheaper long term credit (once rates fall) for firms that process copper, uranium and ferroalloys into higher value goods inside Kazakhstan.', 1)
      + `<div style="display:grid;grid-template-columns:1fr 1fr;gap:2vw">` + stat('+9.8%', 'manufacturing, H1 2026', 'teal', 1.6) + stat('+15.2%', 'construction, H1 2026', 'white', 1.9) + `</div>`
      + para('More factories mean jobs outside the oil regions and exports that don’t move with the price of a barrel.', 2.4))
      + src('Sources: Bureau of National Statistics (2026a, 2026b).')
  },
  { // 14 trade offs
    shade: 'shadeT', world: 'chart', cam: { p: V(0, 3.4, 14), t: V(0, 1.9, 0), shift: 0, orbit: .01 }, show: ['balance'], labels: ['c_cost', 'c_ben'],
    html: box('left:4vw;top:8vh;width:80vw', kick('Defending the plan') + ttl('Costs, risks and how we’ll know it works', .3, 'font-size:3vw'))
      + box('left:3vw;bottom:9vh;width:25vw', `<div class="panel a" style="--d:.9s;border-color:rgba(255,90,95,.35)"><div class="kicker" style="color:var(--red)">Trade offs</div><ul class="list">`
        + '<li>Less government spending today under the fiscal rule.</li><li>The corridor needs big upfront investment in rail and ports.</li><li>Transit depends on stable relations with Russia and China.</li>'
        + '<li><b style="color:#fff">But doing nothing = another inflation shock every time oil moves.</b></li></ul></div>')
      + box('right:3vw;bottom:9vh;width:25vw', `<div class="panel a" style="--d:2.4s;border-color:rgba(53,208,230,.35)"><div class="kicker" style="color:var(--teal)">How we measure success</div>`
        + stat('5%', 'inflation back at the National Bank target (now 9.3%)', 'teal', 2.8) + stat('< 40%', 'oil’s share of exports (now 50.5%)', 'gold', 3.2, true)
        + stat('↑ non oil', 'manufacturing and transit revenue growing every year', 'white', 3.6, true) + `</div>`)
      + `<div class="src a" style="--d:2.4s;bottom:3vh">Targets are my proposal; current values from Parts 2 and 3.</div>`
  },
  { // 15 closing
    shade: 'shadeB', world: 'globe', cam: gcam(64, 24, 4.1, .2, { t: V(0, -.32, 0), orbit: .025 }), gu: { kz: 1, rus: 0, chn: 0 }, show: ['close'], labels: [],
    html: box('left:4vw;right:4vw;bottom:10vh', kick('From a pipeline to a crossroads', .3) + ttl('Save the windfall. Build the corridor. Add value at home.', .6, 'font-size:2.9vw;margin-bottom:2.4vh')
      + `<div class="sub a" style="--d:2.6s;font-size:1.7vw">Thank you! Please don’t ask me any questions.</div>`
      + `<div class="a" style="--d:5.4s;font-size:1.6vw;font-weight:800;color:var(--gold);margin-top:1vh;text-shadow:0 0 24px rgba(255,200,69,.6)">Just kidding. Questions are welcome :)</div>`)
      + `<div class="orn" style="--d:1.4s;left:4vw;bottom:5vh;width:44vw"></div><div class="sun" style="--d:1s;left:4vw;top:7vh;width:6vw;height:6vw"></div>`
  },
  { // 16 references
    world: 'globe', cam: gcam(110, 15, 5.2, .33, { orbit: .02 }), gu: { kz: .6, rus: 0, chn: 0, land: .6 }, show: [], labels: [],
    html: box('left:4vw;top:9vh;width:56vw', ttl('References', .2, 'font-size:2.6vw') + `<div class="refs a" style="--d:.6s">` + [
      'Bureau of National Statistics of Kazakhstan. (2026a). GDP by method of production; Demographic statistics; Foreign trade turnover (Jan to Dec 2025). stat.gov.kz',
      'Bureau of National Statistics of Kazakhstan. (2026b). Labor market statistics; Population by ethnic group; Foreign trade turnover (Jan to Jul 2026). stat.gov.kz',
      'Bureau of National Statistics of Kazakhstan. (2026c). Inflation in the Republic of Kazakhstan (September 2026). stat.gov.kz',
      'Government of Kazakhstan. (2026). The current account of the payment balance was in surplus for the first time in three years. gov.kz',
      'Lloyds Bank Trade. (2026). Foreign trade figures of Kazakhstan. lloydsbanktrade.com',
      'National Bank of Kazakhstan. (2026, September 4). The base rate was lowered to 16.25%. nationalbank.kz; (n.d.) Frequently asked questions.',
      'Regxplora. (2026). Monetary policy tracker: Kazakhstan.',
      'Reuters. (2026a, June 30). New Kazakhstan constitution takes effect as political transition gathers pace.',
      'U.S. Department of State. (2024). 2024 investment climate statements: Kazakhstan.',
      'World Bank. (2026a). Kazakhstan: Economic overview; (2026b) World Development Indicators: Kazakhstan.'
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
  </g></svg>
  <div class="mcap"><div class="mt">Me after zero questions</div><div class="ms">beshbarmak.exe has started dancing</div></div></div>`
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
  bloom.enabled = q.bloom;
  dotsMat.uniforms.uSize.value = 5 * q.pr * innerHeight / 1000;
  try { localStorage.setItem('kzq', String(qLevel)); } catch (e) {}
  if (why) showToast('Quality: ' + q.name + ' (' + why + ')');
}
try { const sv = parseInt(localStorage.getItem('kzq'), 10); if (sv > 0) applyQuality(sv); } catch (e) {}
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
frame();
setTimeout(() => hint.classList.add('off'), 9000);
window.__goTo = goTo;
})();
