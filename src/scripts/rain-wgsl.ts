// How wet the glass is right now (0–1); the backdrop eases toward it.
export const rainLevel: { amount: number } = { amount: 0 };

// Rain on glass as a height field, shared by the overlay and the backdrop so the
// drops drawn over the page and the refraction in the video line up.
// Coordinates are in viewport heights (pos.xy / res.y), time in seconds.
export const RAIN_WGSL = /* wgsl */ `
fn rainHash11(p: f32) -> f32 {
  var x = fract(p * 0.1031);
  x *= x + 33.33;
  x *= x + x;
  return fract(x);
}

fn rainHash21(p: vec2f) -> f32 {
  var q = fract(vec3f(p.x, p.y, p.x) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

fn rainDome(d: f32, r: f32) -> f32 {
  return sqrt(clamp(1.0 - (d * d) / max(r * r, 1e-6), 0.0, 1.0));
}

// Beads that condense, sit a while, and evaporate.
fn rainBeads(uv: vec2f, t: f32, amount: f32) -> f32 {
  let p = uv * 30.0;
  let id = floor(p);
  let st = fract(p) - 0.5;
  let keep = rainHash21(id + 71.3);
  if (keep > 0.1 + amount * 0.3) { return 0.0; }
  let center = (vec2f(rainHash21(id), rainHash21(id + 13.7)) - 0.5) * 0.6;
  let life = fract(t * 0.045 + rainHash21(id + 3.9) * 9.0);
  let fade = smoothstep(0.0, 0.1, life) * smoothstep(1.0, 0.65, life);
  let r = mix(0.1, 0.24, rainHash21(id + 5.1));
  return rainDome(length(st - center), r) * fade;
}

// Drops that hang, then slip down the glass, leaving a wet path dotted with beads.
// Returns (height, wetness).
fn rainSlides(uv: vec2f, t: f32, scale: f32, amount: f32) -> vec2f {
  var p = vec2f(uv.x * scale, uv.y * scale * 0.5);
  p.y -= t * 0.16 + rainHash11(floor(p.x)) * 17.0;
  let id = floor(p);
  let st = fract(p);
  let n = rainHash21(id);
  if (rainHash21(id + 41.7) > amount) { return vec2f(0.0); }

  let phase = fract(t * 0.21 + n * 13.0);
  let dropY = 0.86 - 0.7 * (phase - smoothstep(0.84, 1.0, phase));
  let lane = 0.5 + (n - 0.5) * 0.55;
  let pathX = lane + sin(st.y * 9.0 + n * 31.0) * 0.05 + sin(st.y * 21.0 + n * 7.0) * 0.018;
  let dropX = lane + sin(dropY * 9.0 + n * 31.0) * 0.05 + sin(dropY * 21.0 + n * 7.0) * 0.018;

  var dv = vec2f(st.x - dropX, (st.y - dropY) * 2.0);
  if (dv.y > 0.0) { dv.y *= 0.72; }
  let main = rainDome(length(dv), mix(0.13, 0.19, rainHash21(id + 2.3)));

  let above = dropY - st.y;
  let inPath = smoothstep(0.0, 0.05, above) * smoothstep(0.8, 0.2, above);
  let wet = smoothstep(0.08, 0.02, abs(st.x - pathX)) * inPath;

  let row = floor(st.y * 8.0);
  let beadY = (row + 0.5) / 8.0;
  let tv = vec2f(st.x - pathX, (st.y - beadY) * 2.0);
  let beadR = 0.055 * smoothstep(0.8, 0.1, above) * step(rainHash21(id + vec2f(row, 9.1)), 0.75);
  let trail = rainDome(length(tv), beadR) * step(0.07, above);

  return vec2f(max(main, trail), wet);
}

// (height, wetness) for the whole pane.
fn rainHeight(uv: vec2f, t: f32, amount: f32) -> vec2f {
  let a = rainSlides(uv, t, 13.0, amount * 0.45);
  let b = rainSlides(uv * 1.4 + vec2f(7.3, 1.9), t * 1.07 + 4.0, 13.0, amount * 0.35);
  let beads = rainBeads(uv, t, amount);
  return vec2f(max(beads, max(a.x, b.x)), max(a.y, b.y));
}

// (slope.x, slope.y, height, wetness)
fn rainSurface(uv: vec2f, t: f32, amount: f32) -> vec4f {
  let e = 0.0011;
  let c = rainHeight(uv, t, amount);
  let gx = rainHeight(uv + vec2f(e, 0.0), t, amount).x - c.x;
  let gy = rainHeight(uv + vec2f(0.0, e), t, amount).x - c.x;
  return vec4f(gx / e, gy / e, c.x, c.y);
}
`;
