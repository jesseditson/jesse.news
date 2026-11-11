import { RAIN_WGSL, rainLevel } from "./rain-wgsl.js";
import { isMinimal } from "./mode.js";

const FRAME_MS = 1000 / 30;

const SHADER = /* wgsl */ `
struct Uniforms {
  res: vec2f,
  time: f32,
  amount: f32,
  opacity: f32,
  pad0: f32,
  pad1: f32,
  pad2: f32,
};

@group(0) @binding(0) var<uniform> u: Uniforms;

${RAIN_WGSL}

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-1.0, -3.0), vec2f(-1.0, 1.0), vec2f(3.0, 1.0));
  return vec4f(p[i], 0.0, 1.0);
}

@fragment
fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let s = rainSurface(pos.xy / u.res.y, u.time, u.amount);
  let h = s.z;
  let body = smoothstep(0.0, 0.04, h);
  if (body <= 0.0 && s.w <= 0.0) { return vec4f(0.0); }

  let n = normalize(vec3f(-s.xy * 0.03, 1.0));
  let light = normalize(vec3f(-0.45, -0.7, 0.55));
  let spec = pow(max(dot(n, light), 0.0), 28.0) * body;
  let caustic = smoothstep(0.35, 0.95, n.y) * body;
  let rim = body * pow(1.0 - h, 8.0);

  let glow = spec * 0.95 + caustic * 0.4 + body * 0.06 + s.w * 0.03;
  let alpha = clamp(glow + rim * 0.2, 0.0, 1.0) * u.opacity;
  return vec4f(vec3f(glow * u.opacity), alpha);
}
`;

export interface Rain {
  stop(): void;
}

export async function startRain({
  intensity = 0.5,
  prefersReducedMotion = false,
}: { intensity?: number; prefersReducedMotion?: boolean } = {}): Promise<Rain | null> {
  if (!navigator.gpu) return null;
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "low-power" });
  if (!adapter) return null;
  const device = await adapter.requestDevice();

  const canvas = document.createElement("canvas");
  canvas.className = "rain";
  canvas.setAttribute("aria-hidden", "true");
  document.body.append(canvas);

  const found = canvas.getContext("webgpu");
  if (!found) {
    canvas.remove();
    return null;
  }
  const context = found;
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: "premultiplied" });

  const module = device.createShaderModule({ code: SHADER });
  const pipeline = await device.createRenderPipelineAsync({
    layout: "auto",
    vertex: { module, entryPoint: "vs" },
    fragment: { module, entryPoint: "fs", targets: [{ format }] },
    primitive: { topology: "triangle-list" },
  });
  const uniforms = new Float32Array(8);
  const buffer = device.createBuffer({ size: uniforms.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer } }],
  });

  const amount = Math.min(1, Math.max(0.2, intensity));
  const frozenAt = 40 + Math.random() * 100;
  let running = true;
  let last = 0;

  function resize(): boolean {
    const scale = Math.min(window.devicePixelRatio || 1, 1.25);
    const width = Math.max(1, Math.round(window.innerWidth * scale));
    const height = Math.max(1, Math.round(window.innerHeight * scale));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      return true;
    }
    return false;
  }

  function draw(seconds: number): void {
    uniforms.set([canvas.width, canvas.height, seconds, amount, 0.9, 0, 0, 0]);
    device.queue.writeBuffer(buffer, 0, uniforms);
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        { view: context.getCurrentTexture().createView(), loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 0] },
      ],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
    device.queue.submit([encoder.finish()]);
  }

  function frame(now: number): void {
    if (!running) return;
    requestAnimationFrame(frame);
    if (document.hidden || isMinimal() || now - last < FRAME_MS) return;
    last = now;
    resize();
    draw(now / 1000);
  }

  const onResize = () => {
    if (resize() && prefersReducedMotion) draw(frozenAt);
  };
  window.addEventListener("resize", onResize);

  resize();
  if (prefersReducedMotion) draw(frozenAt);
  else requestAnimationFrame(frame);
  requestAnimationFrame(() => canvas.classList.add("is-live"));
  rainLevel.amount = amount;

  return {
    stop() {
      rainLevel.amount = 0;
      canvas.classList.remove("is-live");
      window.removeEventListener("resize", onResize);
      setTimeout(() => {
        running = false;
        canvas.remove();
        device.destroy();
      }, 2500);
    },
  };
}
