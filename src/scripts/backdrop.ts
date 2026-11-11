import { isMinimal, whenScenic } from "./mode.js";
import { RAIN_WGSL, rainLevel } from "./rain-wgsl.js";

const DWELL_MIN = 20;
const DWELL_MAX = 75;
const TRANSITION = 2.8;
const RECHECK = 60;
const FRAME_MS = 1000 / 30;

const WGSL = /* wgsl */ `
struct Uniforms {
  res: vec2f,
  sizeA: vec2f,
  sizeB: vec2f,
  progress: f32,
  time: f32,
  pixel: f32,
  seed: f32,
  grade: f32,
  rain: f32,
};

@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var texA: texture_external;
@group(0) @binding(2) var texB: texture_external;
@group(0) @binding(3) var<uniform> u: Uniforms;

${RAIN_WGSL}

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-1.0, -3.0), vec2f(-1.0, 1.0), vec2f(3.0, 1.0));
  return vec4f(p[i], 0.0, 1.0);
}

fn cover(uv: vec2f, size: vec2f) -> vec2f {
  let screen = u.res.x / max(u.res.y, 1.0);
  let video = size.x / max(size.y, 1.0);
  var s = vec2f(1.0, 1.0);
  if (screen > video) { s.y = video / screen; } else { s.x = screen / video; }
  return clamp((uv - 0.5) * s + 0.5, vec2f(0.0005), vec2f(0.9995));
}

fn hash(p: vec2f) -> f32 {
  return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453);
}

fn noise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let w = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash(i), hash(i + vec2f(1.0, 0.0)), w.x),
    mix(hash(i + vec2f(0.0, 1.0)), hash(i + vec2f(1.0, 1.0)), w.x),
    w.y
  );
}

// 8x8 Bayer threshold, from bit-interleaving x^y with y.
fn bayer(p: vec2u) -> f32 {
  let x = p.x & 7u;
  let y = p.y & 7u;
  let v = x ^ y;
  let r = ((v & 1u) << 5u) | ((y & 1u) << 4u) | ((v & 2u) << 2u)
        | ((y & 2u) << 1u) | ((v & 4u) >> 1u) | ((y & 4u) >> 2u);
  return (f32(r) + 0.5) / 64.0;
}

fn grabA(uv: vec2f, shift: vec2f) -> vec3f {
  let r = textureSampleBaseClampToEdge(texA, samp, cover(uv + shift, u.sizeA)).r;
  let g = textureSampleBaseClampToEdge(texA, samp, cover(uv, u.sizeA)).g;
  let b = textureSampleBaseClampToEdge(texA, samp, cover(uv - shift, u.sizeA)).b;
  return vec3f(r, g, b);
}

fn grabB(uv: vec2f, shift: vec2f) -> vec3f {
  let r = textureSampleBaseClampToEdge(texB, samp, cover(uv + shift, u.sizeB)).r;
  let g = textureSampleBaseClampToEdge(texB, samp, cover(uv, u.sizeB)).g;
  let b = textureSampleBaseClampToEdge(texB, samp, cover(uv - shift, u.sizeB)).b;
  return vec3f(r, g, b);
}

@fragment
fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let t = clamp(u.progress, 0.0, 1.0);
  let d = sin(t * 3.14159265);

  let cellSize = max(1.0, floor(mix(1.0, u.pixel, d) + 0.5));
  let cell = floor(pos.xy / cellSize);
  var uv = (cell + 0.5) * cellSize / u.res;

  // A soft tracking band rolls down the frame every so often.
  let band = fract(u.time * 0.037 + u.seed);
  let dy = uv.y - band;
  let tracking = exp(-dy * dy * 3500.0);
  uv.x += tracking * 0.006 * (hash(vec2f(floor(pos.y / 2.0), floor(u.time * 24.0))) - 0.5) * u.grade;

  // Seen through the wet pane: drops refract, the rest of the glass is a little fogged.
  var fog = 0.0;
  if (u.rain > 0.001) {
    let glass = rainSurface(pos.xy / u.res.y, u.time, u.rain);
    uv -= glass.xy * 0.0007;
    fog = (1.0 - smoothstep(0.0, 0.12, max(glass.z, glass.w))) * u.rain;
  }

  let shift = vec2f((1.4 + tracking * 3.0) / u.res.x * u.grade, 0.0);
  let a = grabA(uv, shift);
  let b = grabB(uv, shift);

  var color = a;
  if (t > 0.0) {
    let threshold = bayer(vec2u(cell)) * 0.8 + noise(cell * 0.03 + u.seed * 17.0) * 0.2;
    color = select(a, b, threshold < t * 1.02);
    let levels = mix(28.0, 3.0, d);
    let quantized = floor(color * (levels - 1.0) + threshold) / (levels - 1.0);
    color = mix(color, quantized, smoothstep(0.0, 0.3, d));
  }

  // Mild camcorder grade: lifted blacks, warm mids, a little less saturation.
  let luma = dot(color, vec3f(0.299, 0.587, 0.114));
  color = mix(color, vec3f(luma), 0.18 * u.grade);
  color = mix(color, color * vec3f(1.06, 1.0, 0.9) * 0.88 + vec3f(0.05, 0.04, 0.055), u.grade);
  color = (color - 0.5) * (1.0 + 0.06 * u.grade) + 0.5;
  color += vec3f(tracking * 0.08 * u.grade);
  color *= 1.0 - 0.07 * u.grade * step(2.0, pos.y % 3.0);
  color += (hash(pos.xy + vec2f(fract(u.time * 7.0) * 113.0, 0.0)) - 0.5) * 0.045 * u.grade;
  color = mix(color, vec3f(dot(color, vec3f(0.299, 0.587, 0.114))) * 0.85 + vec3f(0.06, 0.065, 0.075), fog * 0.4);
  color *= 0.78;

  return vec4f(clamp(color, vec3f(0.0), vec3f(1.0)), 1.0);
}
`;

interface VideoEntry {
  url: string;
  mime: string;
  starts: string;
  ends: string;
}

interface PoolEntry extends VideoEntry {
  startMin: number | null;
  endMin: number | null;
}

interface Renderer {
  readonly kind: "webgpu" | "css";
  readonly lost?: boolean;
  show(video: HTMLVideoElement): void;
  hide(): void;
  transition(from: HTMLVideoElement, to: HTMLVideoElement, seconds: number): Promise<void>;
}

function parseClock(value: string | undefined): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec((value || "").trim());
  if (!match) return null;
  return (Number(match[1]) % 24) * 60 + Math.min(59, Number(match[2]));
}

// Windows may wrap midnight (22:00 → 05:00); an open end means "until midnight" / "from midnight".
function inWindow(entry: PoolEntry, date = new Date()): boolean {
  const start = entry.startMin;
  const end = entry.endMin;
  if (start === null && end === null) return true;
  const now = date.getHours() * 60 + date.getMinutes();
  const s = start ?? 0;
  const e = end ?? 24 * 60;
  if (s === e) return true;
  return s < e ? now >= s && now < e : now >= s || now < e;
}

const pick = <T>(list: T[]): T => list[Math.floor(Math.random() * list.length)];
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function makeVideo(parent: Element): HTMLVideoElement {
  const video = document.createElement("video");
  video.muted = true;
  video.defaultMuted = true;
  video.loop = true;
  video.playsInline = true;
  video.preload = "auto";
  video.crossOrigin = "anonymous";
  video.setAttribute("aria-hidden", "true");
  video.setAttribute("tabindex", "-1");
  parent.append(video);
  return video;
}

function loadInto(video: HTMLVideoElement, entry: VideoEntry, { play = true } = {}): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("timeout")), 20000);
    const ready = () => finish();
    const failed = () => finish(video.error || new Error("video error"));
    function finish(error?: unknown) {
      clearTimeout(timer);
      video.removeEventListener("canplay", ready);
      video.removeEventListener("error", failed);
      if (error) reject(error);
      else resolve();
    }
    video.addEventListener("canplay", ready);
    video.addEventListener("error", failed);
    video.src = entry.url;
    video.load();
  }).then(async () => {
    if (play) await video.play();
  });
}

async function createGPURenderer(canvas: HTMLCanvasElement): Promise<Renderer> {
  if (!navigator.gpu) throw new Error("no webgpu");
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "low-power" });
  if (!adapter) throw new Error("no adapter");
  const device = await adapter.requestDevice();
  const found = canvas.getContext("webgpu");
  if (!found) throw new Error("no context");
  const context = found;
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: "opaque" });

  const module = device.createShaderModule({ code: WGSL });
  const pipeline = await device.createRenderPipelineAsync({
    layout: "auto",
    vertex: { module, entryPoint: "vs" },
    fragment: { module, entryPoint: "fs", targets: [{ format }] },
    primitive: { topology: "triangle-list" },
  });
  const sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
  const uniforms = new Float32Array(12);
  const uniformBuffer = device.createBuffer({
    size: uniforms.byteLength,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  let lost = false;
  device.lost.then(() => {
    lost = true;
  });

  const state = {
    a: null as HTMLVideoElement | null,
    b: null as HTMLVideoElement | null,
    progress: 0,
    seed: Math.random(),
    running: false,
    last: 0,
    rain: 0,
  };

  function resize(): void {
    const scale = Math.min(window.devicePixelRatio || 1, 1);
    const width = Math.max(1, Math.round(canvas.clientWidth * scale));
    const height = Math.max(1, Math.round(canvas.clientHeight * scale));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
  }

  function draw(now: number): void {
    if (lost) return;
    const a = state.a;
    if (!a || a.readyState < 2 || !a.videoWidth) return;
    const b = state.b && state.b.readyState >= 2 && state.b.videoWidth ? state.b : a;
    resize();
    state.rain += (rainLevel.amount - state.rain) * 0.04;
    if (Math.abs(rainLevel.amount - state.rain) < 0.002) state.rain = rainLevel.amount;

    uniforms.set([
      canvas.width, canvas.height,
      a.videoWidth, a.videoHeight,
      b.videoWidth, b.videoHeight,
      b === a ? 0 : state.progress,
      now / 1000,
      Math.max(3, Math.round(canvas.width / 320)),
      state.seed,
      1,
      state.rain,
    ]);
    device.queue.writeBuffer(uniformBuffer, 0, uniforms);

    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: sampler },
        { binding: 1, resource: device.importExternalTexture({ source: a }) },
        { binding: 2, resource: device.importExternalTexture({ source: b }) },
        { binding: 3, resource: { buffer: uniformBuffer } },
      ],
    });

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        { view: context.getCurrentTexture().createView(), loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 1] },
      ],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
    device.queue.submit([encoder.finish()]);
  }

  function loop(now: number): void {
    if (!state.running) return;
    requestAnimationFrame(loop);
    if (document.hidden || isMinimal() || now - state.last < FRAME_MS) return;
    state.last = now;
    try {
      draw(now);
    } catch {
      // A frame the decoder hasn't produced yet; the next one will.
    }
  }

  return {
    kind: "webgpu",
    get lost() {
      return lost;
    },
    show(video: HTMLVideoElement) {
      state.a = video;
      state.b = null;
      state.progress = 0;
      if (!state.running) {
        state.running = true;
        requestAnimationFrame(loop);
      }
      canvas.classList.add("is-live");
    },
    hide() {
      canvas.classList.remove("is-live");
    },
    transition(from: HTMLVideoElement, to: HTMLVideoElement, seconds: number) {
      state.a = from;
      state.b = to;
      state.seed = Math.random();
      const start = performance.now();
      return new Promise<void>((resolve) => {
        const step = (now: number) => {
          const t = Math.min(1, (now - start) / (seconds * 1000));
          state.progress = ease(t);
          if (t < 1) {
            requestAnimationFrame(step);
          } else {
            state.a = to;
            state.b = null;
            state.progress = 0;
            resolve();
          }
        };
        requestAnimationFrame(step);
      });
    },
  };
}

// Without WebGPU the same ordered dither runs as a stepped CSS mask over the incoming video.
function bayerMasks(): string[] {
  const matrix: number[] = [];
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const v = x ^ y;
      matrix.push(
        ((v & 1) << 5) | ((y & 1) << 4) | ((v & 2) << 2) | ((y & 2) << 1) | ((v & 4) >> 1) | ((y & 4) >> 2)
      );
    }
  }
  const cell = 4;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 8 * cell;
  const ctx = canvas.getContext("2d");
  const masks: string[] = [];
  if (!ctx) return masks;
  for (let level = 0; level <= 64; level++) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#000";
    matrix.forEach((threshold, i) => {
      if (threshold < level) ctx.fillRect((i % 8) * cell, Math.floor(i / 8) * cell, cell, cell);
    });
    masks.push(`url(${canvas.toDataURL()})`);
  }
  return masks;
}

function createCSSRenderer(videos: HTMLVideoElement[]): Renderer {
  let masks: string[] | null = null;
  let live: HTMLVideoElement | null = null;
  const apply = (video: HTMLVideoElement, mask: string) => {
    video.style.webkitMaskImage = mask;
    video.style.maskImage = mask;
    video.style.webkitMaskSize = mask ? "2rem 2rem" : "";
    video.style.maskSize = mask ? "2rem 2rem" : "";
  };
  return {
    kind: "css",
    show(video: HTMLVideoElement) {
      videos.forEach((v) => v !== video && v.classList.remove("is-live"));
      video.style.zIndex = "1";
      video.classList.add("is-live");
      live = video;
    },
    hide() {
      live?.classList.remove("is-live");
    },
    transition(from: HTMLVideoElement, to: HTMLVideoElement, seconds: number) {
      const steps = (masks ||= bayerMasks());
      from.style.zIndex = "1";
      to.style.zIndex = "2";
      to.style.transition = "none";
      apply(to, steps[0] ?? "");
      to.classList.add("is-live");
      const start = performance.now();
      return new Promise<void>((resolve) => {
        const step = (now: number) => {
          const t = Math.min(1, (now - start) / (seconds * 1000));
          apply(to, steps[Math.round(ease(t) * 64)] ?? "");
          if (t < 1) {
            requestAnimationFrame(step);
          } else {
            apply(to, "");
            to.style.transition = "";
            from.classList.remove("is-live");
            live = to;
            resolve();
          }
        };
        requestAnimationFrame(step);
      });
    },
  };
}

export async function startBackdrop({ prefersReducedMotion }: { prefersReducedMotion: boolean }): Promise<void> {
  const backdrop = document.querySelector(".backdrop");
  const canvas = backdrop?.querySelector<HTMLCanvasElement>(".backdrop-canvas");
  let entries: VideoEntry[] = [];
  try {
    entries = JSON.parse(document.getElementById("backdrop-videos")?.textContent || "[]");
  } catch {
    return;
  }
  if (!backdrop || !canvas || !entries.length) return;

  await whenScenic();

  const pool: PoolEntry[] = entries.map((e) => ({ ...e, startMin: parseClock(e.starts), endMin: parseClock(e.ends) }));
  const eligible = () => pool.filter((entry) => inWindow(entry));
  const slots = [makeVideo(backdrop), makeVideo(backdrop)];

  if (prefersReducedMotion) {
    const options = eligible();
    if (!options.length) return;
    const entry = pick(options);
    const renderer = createCSSRenderer(slots);
    try {
      await loadInto(slots[0], entry, { play: false });
      renderer.show(slots[0]);
    } catch {
      // The plain backdrop stays.
    }
    return;
  }

  let renderer: Renderer;
  try {
    renderer = await createGPURenderer(canvas);
  } catch {
    renderer = createCSSRenderer(slots);
  }

  let active = 0;
  let current: PoolEntry | null = null;

  const syncPlayback = () => {
    const video = slots[active];
    if (!current) return;
    if (document.hidden || isMinimal()) video.pause();
    else video.play().catch(() => {});
  };
  document.addEventListener("visibilitychange", syncPlayback);
  document.addEventListener("modechange", syncPlayback);

  const dwell = (video: HTMLVideoElement) =>
    Math.min(DWELL_MAX, Math.max(DWELL_MIN, Number.isFinite(video.duration) ? video.duration : DWELL_MIN));

  async function cycle(): Promise<void> {
    if (isMinimal()) await whenScenic();
    const options = eligible();

    if (!options.length) {
      if (current) {
        renderer.hide();
        await sleep(1600);
        slots[active].pause();
        current = null;
      }
      setTimeout(cycle, RECHECK * 1000);
      return;
    }

    if (!current) {
      const entry = pick(options);
      try {
        await loadInto(slots[active], entry);
        current = entry;
        renderer.show(slots[active]);
      } catch {
        pool.splice(pool.indexOf(entry), 1);
        if (pool.length) setTimeout(cycle, 1000);
        return;
      }
      setTimeout(cycle, (dwell(slots[active]) - TRANSITION) * 1000);
      return;
    }

    const others = options.filter((entry) => entry !== current);
    if (!others.length) {
      setTimeout(cycle, RECHECK * 1000);
      return;
    }

    const next = pick(others);
    const incoming = 1 - active;
    try {
      await loadInto(slots[incoming], next);
    } catch {
      pool.splice(pool.indexOf(next), 1);
      setTimeout(cycle, 1000);
      return;
    }

    if (renderer.lost) renderer = createCSSRenderer(slots);
    await renderer.transition(slots[active], slots[incoming], TRANSITION);
    slots[active].pause();
    active = incoming;
    current = next;
    syncPlayback();
    setTimeout(cycle, Math.max(4, dwell(slots[active]) - TRANSITION) * 1000);
  }

  cycle();
}
