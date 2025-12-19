"use strict";

// ========== SHARED AUDIO VARIABLEN ==========
let audioContext = null;
let analyser = null;
let dataArray = null;
let timeDataArray = null;
let audioActive = false;
let playlist = [];
let currentTrackIndex = 0;

// Emitter-Positionen für Fluid
let emitters = [
  { x: 0.3, y: 0.8, vx: 0.001, vy: 0 },
  { x: 0.7, y: 0.8, vx: -0.001, vy: 0 },
  { x: 0.5, y: 0.5, vx: 0, vy: 0.001 },
  { x: 0.2, y: 0.3, vx: 0.002, vy: 0 },
  { x: 0.8, y: 0.3, vx: -0.002, vy: 0 },
];

// Beat-Detection
let lastSubBass = 0, lastBass = 0, lastMid = 0;
let subBassEnergy = 0, bassEnergy = 0;

// ========== OVERLAY VARIABLEN (Waveform + Avg Circle) ==========
const waveform_color = "rgba(29, 36, 57, 0.05)";
const waveform_color_2 = "rgba(0,0,0,0)";
const waveform_line_color = "rgba(157, 242, 157, 0.11)";
const waveform_line_color_2 = "rgba(157, 242, 157, 0.8)";
const waveform_tick = 0.05;
const TOTAL_POINTS = 512;
let points = [];

const bubble_avg_color = "rgba(29, 36, 57, 0.5)";
const bubble_avg_color_2 = "rgba(77, 218, 248, 0.3)";
const bubble_avg_line_color = "rgba(77, 218, 248, 1)";
const bubble_avg_line_color_2 = "rgba(120, 240, 255, 1)";
const AVG_BREAK_POINT = 100;
let avg_circle;

const PI = Math.PI;
const PI_TWO = PI * 2;
const PI_HALF = PI / 180;
const sin = Math.sin;
const cos = Math.cos;

let w = 0, h = 0, cx = 0, cy = 0;
let rotation = 0;
let avg = 0;
let AVG_BREAK_POINT_HIT = false;

let overlayCtx;

// ========== AUDIO INIT ==========
function initAudioContext() {
  if (audioContext) return;
  audioContext = new (window.AudioContext || window.webkitAudioContext)();
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 2048;
  analyser.minDecibels = -100;
  analyser.maxDecibels = -30;
  analyser.smoothingTimeConstant = 0.8;
  dataArray = new Uint8Array(analyser.frequencyBinCount);
  timeDataArray = new Uint8Array(analyser.frequencyBinCount);
}

function getAverageVolume(start, end) {
  if (!dataArray) return 0;
  let sum = 0;
  for (let i = start; i < end && i < dataArray.length; i++) sum += dataArray[i];
  return sum / (end - start);
}

function getAvg(values) {
  let value = 0;
  for (let i = 0; i < values.length; i++) value += values[i];
  return value / values.length;
}

// ========== FLUID SIMULATION ==========

let canvas = document.getElementById("fluidCanvas");
canvas.width = window.innerWidth;
canvas.height = window.innerHeight;

let config = {
  TEXTURE_DOWNSAMPLE: 1,
  DENSITY_DISSIPATION: 0.96,
  VELOCITY_DISSIPATION: 0.97,
  PRESSURE_DISSIPATION: 0.8,
  PRESSURE_ITERATIONS: 25,
  CURL: 35,
  SPLAT_RADIUS: 0.002
};

let pointers = [];
let splatStack = [];

let _getWebGLContext = getWebGLContext(canvas);
let gl = _getWebGLContext.gl;
let ext = _getWebGLContext.ext;
let support_linear_float = _getWebGLContext.support_linear_float;

function getWebGLContext(canvas) {
  let params = { alpha: false, depth: false, stencil: false, antialias: false };
  let gl = canvas.getContext("webgl2", params);
  let isWebGL2 = !!gl;
  if (!isWebGL2) gl = canvas.getContext("webgl", params) || canvas.getContext("experimental-webgl", params);

  let halfFloat = gl.getExtension("OES_texture_half_float");
  let support_linear_float = gl.getExtension("OES_texture_half_float_linear");
  if (isWebGL2) {
    gl.getExtension("EXT_color_buffer_float");
    support_linear_float = gl.getExtension("OES_texture_float_linear");
  }
  gl.clearColor(0.0, 0.0, 0.0, 1.0);

  let internalFormat = isWebGL2 ? gl.RGBA16F : gl.RGBA;
  let internalFormatRG = isWebGL2 ? gl.RG16F : gl.RGBA;
  let formatRG = isWebGL2 ? gl.RG : gl.RGBA;
  let texType = isWebGL2 ? gl.HALF_FLOAT : halfFloat.HALF_FLOAT_OES;

  return { gl, ext: { internalFormat, internalFormatRG, formatRG, texType }, support_linear_float };
}

function pointerPrototype() {
  this.id = -1; this.x = 0; this.y = 0; this.dx = 0; this.dy = 0;
  this.down = false; this.moved = false; this.color = [6, 0.3, 3];
}
pointers.push(new pointerPrototype());

let GLProgram = (function () {
  function GLProgram(vertexShader, fragmentShader) {
    this.uniforms = {};
    this.program = gl.createProgram();
    gl.attachShader(this.program, vertexShader);
    gl.attachShader(this.program, fragmentShader);
    gl.linkProgram(this.program);
    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) throw gl.getProgramInfoLog(this.program);
    let uniformCount = gl.getProgramParameter(this.program, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < uniformCount; i++) {
      let uniformName = gl.getActiveUniform(this.program, i).name;
      this.uniforms[uniformName] = gl.getUniformLocation(this.program, uniformName);
    }
  }
  GLProgram.prototype.bind = function() { gl.useProgram(this.program); };
  return GLProgram;
})();

function compileShader(type, source) {
  let shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw gl.getShaderInfoLog(shader);
  return shader;
}

let baseVertexShader = compileShader(gl.VERTEX_SHADER, `
  precision highp float;
  precision mediump sampler2D;
  attribute vec2 aPosition;
  varying vec2 vUv;
  varying vec2 vL;
  varying vec2 vR;
  varying vec2 vT;
  varying vec2 vB;
  uniform vec2 texelSize;
  void main () {
    vUv = aPosition * 0.5 + 0.5;
    vL = vUv - vec2(texelSize.x, 0.0);
    vR = vUv + vec2(texelSize.x, 0.0);
    vT = vUv + vec2(0.0, texelSize.y);
    vB = vUv - vec2(0.0, texelSize.y);
    gl_Position = vec4(aPosition, 0.0, 1.0);
  }
`);

let clearShader = compileShader(gl.FRAGMENT_SHADER, `
  precision highp float;
  precision mediump sampler2D;
  varying vec2 vUv;
  uniform sampler2D uTexture;
  uniform float value;
  void main () {
    gl_FragColor = value * texture2D(uTexture, vUv);
  }
`);

let displayShader = compileShader(gl.FRAGMENT_SHADER, `
  precision highp float;
  precision mediump sampler2D;
  varying vec2 vUv;
  uniform sampler2D uTexture;
  void main () {
    gl_FragColor = texture2D(uTexture, vUv);
  }
`);

let splatShader = compileShader(gl.FRAGMENT_SHADER, `
  precision highp float;
  precision mediump sampler2D;
  varying vec2 vUv;
  uniform sampler2D uTarget;
  uniform float aspectRatio;
  uniform vec3 color;
  uniform vec2 point;
  uniform float radius;
  void main () {
    vec2 p = vUv - point.xy;
    p.x *= aspectRatio;
    vec3 splat = exp(-dot(p, p) / radius) * color;
    vec3 base = texture2D(uTarget, vUv).xyz;
    gl_FragColor = vec4(base + splat, 1.0);
  }
`);

let advectionManualFilteringShader = compileShader(gl.FRAGMENT_SHADER, `
  precision highp float;
  precision mediump sampler2D;
  varying vec2 vUv;
  uniform sampler2D uVelocity;
  uniform sampler2D uSource;
  uniform vec2 texelSize;
  uniform float dt;
  uniform float dissipation;
  vec4 bilerp (in sampler2D sam, in vec2 p) {
    vec4 st;
    st.xy = floor(p - 0.5) + 0.5;
    st.zw = st.xy + 1.0;
    vec4 uv = st * texelSize.xyxy;
    vec4 a = texture2D(sam, uv.xy);
    vec4 b = texture2D(sam, uv.zy);
    vec4 c = texture2D(sam, uv.xw);
    vec4 d = texture2D(sam, uv.zw);
    vec2 f = p - st.xy;
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }
  void main () {
    vec2 coord = gl_FragCoord.xy - dt * texture2D(uVelocity, vUv).xy;
    gl_FragColor = dissipation * bilerp(uSource, coord);
    gl_FragColor.a = 1.0;
  }
`);

let advectionShader = compileShader(gl.FRAGMENT_SHADER, `
  precision highp float;
  precision mediump sampler2D;
  varying vec2 vUv;
  uniform sampler2D uVelocity;
  uniform sampler2D uSource;
  uniform vec2 texelSize;
  uniform float dt;
  uniform float dissipation;
  void main () {
    vec2 coord = vUv - dt * texture2D(uVelocity, vUv).xy * texelSize;
    gl_FragColor = dissipation * texture2D(uSource, coord);
    gl_FragColor.a = 1.0;
  }
`);

let divergenceShader = compileShader(gl.FRAGMENT_SHADER, `
  precision highp float;
  precision mediump sampler2D;
  varying vec2 vUv;
  varying vec2 vL;
  varying vec2 vR;
  varying vec2 vT;
  varying vec2 vB;
  uniform sampler2D uVelocity;
  void main () {
    float L = texture2D(uVelocity, vL).x;
    float R = texture2D(uVelocity, vR).x;
    float T = texture2D(uVelocity, vT).y;
    float B = texture2D(uVelocity, vB).y;
    float div = 0.5 * (R - L + T - B);
    gl_FragColor = vec4(div, 0.0, 0.0, 1.0);
  }
`);

let curlShader = compileShader(gl.FRAGMENT_SHADER, `
  precision highp float;
  precision mediump sampler2D;
  varying vec2 vUv;
  varying vec2 vL;
  varying vec2 vR;
  varying vec2 vT;
  varying vec2 vB;
  uniform sampler2D uVelocity;
  void main () {
    float L = texture2D(uVelocity, vL).y;
    float R = texture2D(uVelocity, vR).y;
    float T = texture2D(uVelocity, vT).x;
    float B = texture2D(uVelocity, vB).x;
    float vorticity = R - L - T + B;
    gl_FragColor = vec4(vorticity, 0.0, 0.0, 1.0);
  }
`);

let vorticityShader = compileShader(gl.FRAGMENT_SHADER, `
  precision highp float;
  precision mediump sampler2D;
  varying vec2 vUv;
  varying vec2 vL;
  varying vec2 vR;
  varying vec2 vT;
  varying vec2 vB;
  uniform sampler2D uVelocity;
  uniform sampler2D uCurl;
  uniform float curl;
  uniform float dt;
  void main () {
    float L = texture2D(uCurl, vL).x;
    float R = texture2D(uCurl, vR).x;
    float T = texture2D(uCurl, vT).x;
    float B = texture2D(uCurl, vB).x;
    float C = texture2D(uCurl, vUv).x;
    vec2 force = vec2(abs(T) - abs(B), abs(R) - abs(L));
    force *= 1.0 / length(force + 0.00001) * curl * C;
    vec2 vel = texture2D(uVelocity, vUv).xy;
    gl_FragColor = vec4(vel + force * dt, 0.0, 1.0);
  }
`);

let pressureShader = compileShader(gl.FRAGMENT_SHADER, `
  precision highp float;
  precision mediump sampler2D;
  varying vec2 vUv;
  varying vec2 vL;
  varying vec2 vR;
  varying vec2 vT;
  varying vec2 vB;
  uniform sampler2D uPressure;
  uniform sampler2D uDivergence;
  void main () {
    float L = texture2D(uPressure, vL).x;
    float R = texture2D(uPressure, vR).x;
    float T = texture2D(uPressure, vT).x;
    float B = texture2D(uPressure, vB).x;
    float C = texture2D(uPressure, vUv).x;
    float divergence = texture2D(uDivergence, vUv).x;
    float pressure = (L + R + B + T - divergence) * 0.25;
    gl_FragColor = vec4(pressure, 0.0, 0.0, 1.0);
  }
`);

let gradientSubtractShader = compileShader(gl.FRAGMENT_SHADER, `
  precision highp float;
  precision mediump sampler2D;
  varying vec2 vUv;
  varying vec2 vL;
  varying vec2 vR;
  varying vec2 vT;
  varying vec2 vB;
  uniform sampler2D uPressure;
  uniform sampler2D uVelocity;
  void main () {
    float L = texture2D(uPressure, vL).x;
    float R = texture2D(uPressure, vR).x;
    float T = texture2D(uPressure, vT).x;
    float B = texture2D(uPressure, vB).x;
    vec2 velocity = texture2D(uVelocity, vUv).xy;
    velocity.xy -= vec2(R - L, T - B);
    gl_FragColor = vec4(velocity, 0.0, 1.0);
  }
`);

let blit = (() => {
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, -1, 1, 1, 1, 1, -1]), gl.STATIC_DRAW);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.enableVertexAttribArray(0);
  return (destination) => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, destination);
    gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
  };
})();

function createFBO(texId, w, h, internalFormat, format, type, param) {
  gl.activeTexture(gl.TEXTURE0 + texId);
  let texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, param);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, param);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, format, type, null);
  let fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  gl.viewport(0, 0, w, h);
  gl.clear(gl.COLOR_BUFFER_BIT);
  return { texture, fbo, texId };
}

function createDoubleFBO(texId, w, h, internalFormat, format, type, param) {
  let fbo1 = createFBO(texId, w, h, internalFormat, format, type, param);
  let fbo2 = createFBO(texId + 1, w, h, internalFormat, format, type, param);
  return {
    read: fbo1, write: fbo2,
    swap() { let temp = this.read; this.read = this.write; this.write = temp; }
  };
}

let clearProgram = new GLProgram(baseVertexShader, clearShader);
let displayProgram = new GLProgram(baseVertexShader, displayShader);
let splatProgram = new GLProgram(baseVertexShader, splatShader);
let advectionProgram = new GLProgram(baseVertexShader, support_linear_float ? advectionShader : advectionManualFilteringShader);
let divergenceProgram = new GLProgram(baseVertexShader, divergenceShader);
let curlProgram = new GLProgram(baseVertexShader, curlShader);
let vorticityProgram = new GLProgram(baseVertexShader, vorticityShader);
let pressureProgram = new GLProgram(baseVertexShader, pressureShader);
let gradientSubtractProgram = new GLProgram(baseVertexShader, gradientSubtractShader);

let textureWidth, textureHeight, density, velocity, divergence, curl, pressure;

function initFramebuffers() {
  textureWidth = gl.drawingBufferWidth >> config.TEXTURE_DOWNSAMPLE;
  textureHeight = gl.drawingBufferHeight >> config.TEXTURE_DOWNSAMPLE;
  let texType = ext.texType;
  let rgba = ext.internalFormat;
  let rg = ext.internalFormatRG;
  let formatRG = ext.formatRG;
  let filtering = support_linear_float ? gl.LINEAR : gl.NEAREST;
  density = createDoubleFBO(0, textureWidth, textureHeight, rgba, gl.RGBA, texType, filtering);
  velocity = createDoubleFBO(2, textureWidth, textureHeight, rg, formatRG, texType, filtering);
  divergence = createFBO(4, textureWidth, textureHeight, rg, formatRG, texType, gl.NEAREST);
  curl = createFBO(5, textureWidth, textureHeight, rg, formatRG, texType, gl.NEAREST);
  pressure = createDoubleFBO(6, textureWidth, textureHeight, rg, formatRG, texType, gl.NEAREST);
}

initFramebuffers();

function splat(x, y, dx, dy, color, customRadius) {
  splatProgram.bind();
  gl.uniform1i(splatProgram.uniforms.uTarget, velocity.read.texId);
  gl.uniform1f(splatProgram.uniforms.aspectRatio, canvas.width / canvas.height);
  gl.uniform2f(splatProgram.uniforms.point, x / canvas.width, 1.0 - y / canvas.height);
  gl.uniform3f(splatProgram.uniforms.color, dx, -dy, 1.0);
  gl.uniform1f(splatProgram.uniforms.radius, customRadius || config.SPLAT_RADIUS);
  blit(velocity.write.fbo);
  velocity.swap();
  gl.uniform1i(splatProgram.uniforms.uTarget, density.read.texId);
  gl.uniform3f(splatProgram.uniforms.color, color[0], color[1], color[2]);
  blit(density.write.fbo);
  density.swap();
}

// ========== OVERLAY FUNKTIONEN (Waveform + Avg Circle) ==========

function Point(config) {
  this.index = config.index;
  this.angle = (this.index * 360) / TOTAL_POINTS;

  this.updateDynamics = function() {
    this.radius = Math.abs(w, h) / 10;
    this.x = cx + this.radius * sin(PI_HALF * this.angle);
    this.y = cy + this.radius * cos(PI_HALF * this.angle);
  }

  this.updateDynamics();
  this.value = Math.random() * 256;
  this.dx = this.x + this.value * sin(PI_HALF * this.angle);
  this.dy = this.y + this.value * cos(PI_HALF * this.angle);
}

function AvgCircle() {
  this.update = function() {
    this.radius = (Math.abs(w, h) / 10);
  }
  this.update();
}

function createPoints() {
  points = [];
  for (let i = 0; i < TOTAL_POINTS; i++) {
    points.push(new Point({index: i+1}));
  }
  avg_circle = new AvgCircle();
}

function drawAverageCircle() {
  if (AVG_BREAK_POINT_HIT) {
    overlayCtx.strokeStyle = bubble_avg_line_color_2;
    overlayCtx.fillStyle = bubble_avg_color_2;
  } else {
    overlayCtx.strokeStyle = bubble_avg_line_color;
    overlayCtx.fillStyle = bubble_avg_color;
  }

  overlayCtx.beginPath();
  overlayCtx.lineWidth = 2;
  overlayCtx.arc(cx, cy, (avg + avg_circle.radius), 0, PI_TWO, false);
  overlayCtx.stroke();
  overlayCtx.fill();
  overlayCtx.closePath();
}

function drawWaveform() {
  if (AVG_BREAK_POINT_HIT) {
    rotation += waveform_tick;
    overlayCtx.strokeStyle = waveform_line_color_2;
    overlayCtx.fillStyle = waveform_color_2;
  } else {
    rotation += -waveform_tick;
    overlayCtx.strokeStyle = waveform_line_color;
    overlayCtx.fillStyle = waveform_color;
  }

  overlayCtx.beginPath();
  overlayCtx.lineWidth = 2;
  overlayCtx.lineCap = "round";

  overlayCtx.save();
  overlayCtx.translate(cx, cy);
  overlayCtx.rotate(rotation);
  overlayCtx.translate(-cx, -cy);

  overlayCtx.moveTo(points[0].dx, points[0].dy);

  const waveformScale = 3.75; // Verstärkungsfaktor für die Ausschläge
  
  for (let i = 0; i < TOTAL_POINTS - 1; i++) {
    let p = points[i];
    let value = timeDataArray ? (timeDataArray[i] || 128) : 128;
    let scaledValue = (value - 128) * waveformScale + 128; // Verstärkte Abweichung von der Mitte
    p.dx = p.x + scaledValue * sin(PI_HALF * p.angle);
    p.dy = p.y + scaledValue * cos(PI_HALF * p.angle);
    let xc = (p.dx + points[i+1].dx) / 2;
    let yc = (p.dy + points[i+1].dy) / 2;
    overlayCtx.quadraticCurveTo(p.dx, p.dy, xc, yc);
  }

  let p = points[TOTAL_POINTS - 1];
  let value = timeDataArray ? (timeDataArray[TOTAL_POINTS - 1] || 128) : 128;
  let scaledValue = (value - 128) * waveformScale + 128;
  p.dx = p.x + scaledValue * sin(PI_HALF * p.angle);
  p.dy = p.y + scaledValue * cos(PI_HALF * p.angle);
  let xc = (p.dx + points[0].dx) / 2;
  let yc = (p.dy + points[0].dy) / 2;

  overlayCtx.quadraticCurveTo(p.dx, p.dy, xc, yc);
  overlayCtx.quadraticCurveTo(xc, yc, points[0].dx, points[0].dy);

  overlayCtx.stroke();
  overlayCtx.fill();
  overlayCtx.restore();
  overlayCtx.closePath();

  // Horizontale Waveform bei Beat
  if (AVG_BREAK_POINT_HIT && timeDataArray) {
    overlayCtx.beginPath();
    for (let i = 0; i < TOTAL_POINTS; i++) {
      let val = timeDataArray[i] || 128;
      let percent = val / 256;
      let height = h * percent;
      let offset = h - height - 1;
      let barWidth = w / TOTAL_POINTS;
      overlayCtx.fillStyle = waveform_line_color_2;
      overlayCtx.fillRect(i * barWidth, offset, 1, 1);
    }
    overlayCtx.stroke();
    overlayCtx.fill();
    overlayCtx.closePath();
  }
}

// ========== OVERLAY CANVAS INIT ==========
function initOverlayCanvas() {
  let overlayCanvas = document.getElementById('overlayCanvas');
  overlayCanvas.width = window.innerWidth;
  overlayCanvas.height = window.innerHeight;
  overlayCtx = overlayCanvas.getContext('2d');
  
  w = window.innerWidth;
  h = window.innerHeight;
  cx = w / 2;
  cy = h / 2;
  
  createPoints();
}

// ========== HAUPTANIMATIONSLOOP ==========

function update() {
  requestAnimationFrame(update);
  
  // Audio-Daten holen
  if (audioActive && analyser && dataArray) {
    analyser.getByteFrequencyData(dataArray);
    analyser.getByteTimeDomainData(timeDataArray);
    
    // Durchschnitt berechnen
    avg = getAvg([...dataArray].slice(0, 256));
    AVG_BREAK_POINT_HIT = avg > AVG_BREAK_POINT;
  }
  
  processAudioFrame();
  fluidUpdate();
  drawOverlayFrame();
}

function processAudioFrame() {
  if (!audioActive || !analyser || !dataArray) return;
  
  const subBass = getAverageVolume(0, 3);
  const bass = getAverageVolume(3, 6);
  const mid = getAverageVolume(12, 48);
  const treble = getAverageVolume(48, 256);
  
  const subBassDelta = subBass - lastSubBass;
  const bassDelta = bass - lastBass;
  
  const isSubBassHit = (subBassDelta > 8 && subBass > 25) || (subBass > lastSubBass * 1.5 && subBass > 30);
  const isBassHit = (bassDelta > 10 && bass > 30) || (bass > lastBass * 1.35 && bass > 40);
  
  if (isSubBassHit) { subBassEnergy = 1.5; } else { subBassEnergy *= 0.75; }
  if (isBassHit) { bassEnergy = 1.3; } else { bassEnergy *= 0.8; }
  
  const subPump = '💥'.repeat(Math.min(Math.floor(subBassEnergy * 3), 5));
  const bassPump = '🔥'.repeat(Math.min(Math.floor(bassEnergy * 3), 4));
  document.getElementById('trackInfo').innerHTML = 
    `🎵 ${currentTrackIndex + 1}/${playlist.length || 1} | ` +
    `<span style="color:#ff3333">Sub: ${subBass.toFixed(0)} ${subPump}</span> | ` +
    `<span style="color:#ff8844">Bass: ${bass.toFixed(0)} ${bassPump}</span> | ` +
    `<span style="color:#44aaff">Mid: ${mid.toFixed(0)}</span>`;
  
  for (let e of emitters) {
    e.x += e.vx; e.y += e.vy;
    if (e.x < 0.1 || e.x > 0.9) e.vx *= -1;
    if (e.y < 0.1 || e.y > 0.9) e.vy *= -1;
  }
  
  // SUB-BASS (tiefes Weinrot)
  if (subBass > 15) {
    const intensity = Math.min(subBass / 220, 0.3);
    const explosionPower = 1 + subBassEnergy * 1.5;
    const centerX = canvas.width * 0.5;
    const centerY = canvas.height * 0.98;
    
    splatStack.push({
      x: centerX, y: centerY,
      dx: (Math.random() - 0.5) * 15 * explosionPower,
      dy: -subBass * 1.5 * explosionPower,
      color: [8 * intensity * explosionPower, 0.5 * intensity, 2 * intensity]
    });
    
    if (subBassEnergy > 0.3) {
      const velInput = subBass * 0.08 * subBassEnergy;
      splat(canvas.width * 0.5, canvas.height * 0.9, 0, -velInput * 12, [0, 0, 0], 0.06);
    }
    
    if (subBassEnergy > 0.5) {
      const numExplosions = Math.floor(subBassEnergy * 4) + 2;
      const curlForce = subBass * 2 * subBassEnergy;
      const splitDistance = canvas.width * 0.005;
      
      splat(canvas.width * 0.5 - splitDistance, canvas.height * 0.9, -curlForce * 0.05, -curlForce * 0.3, [0, 0, 0]);
      splat(canvas.width * 0.5 + splitDistance, canvas.height * 0.9, curlForce * 0.05, -curlForce * 0.3, [0, 0, 0]);
      
      for (let i = 0; i < numExplosions; i++) {
        const x = canvas.width * (0.2 + Math.random() * 0.6);
        const y = canvas.height * (0.7 + Math.random() * 0.25);
        const angle = -Math.PI * (0.3 + Math.random() * 0.4);
        const force = subBass * 1.2 * subBassEnergy * (0.5 + Math.random());
        splatStack.push({ x, y, dx: Math.cos(angle) * force, dy: Math.sin(angle) * force, color: [7 * intensity * subBassEnergy, 0.3 * intensity * subBassEnergy, 1.5 * intensity] });
      }
      
      if (subBassEnergy > 0.8) {
        for (let i = 0; i < 3; i++) {
          splatStack.push({ x: canvas.width * (0.3 + i * 0.2), y: canvas.height * 0.99, dx: (Math.random() - 0.5) * 8, dy: -subBass * 2.5 * subBassEnergy, color: [10 * subBassEnergy, 0.5 * subBassEnergy, 2.5 * subBassEnergy] });
        }
      }
    }
  }
  
  // BASS (tiefes Weinrot / dunkles Magenta)
  if (bass > 20) {
    const intensity = Math.min(bass / 250, 0.25);
    const pumpPower = 1 + bassEnergy * 1.5;
    const dx = (Math.random() - 0.5) * bass * 0.5 * pumpPower;
    const dy = -bass * 0.8 * pumpPower;
    
    splatStack.push({ x: emitters[0].x * canvas.width, y: emitters[0].y * canvas.height, dx, dy, color: [6 * intensity * pumpPower, 0.3 * intensity, 1.5 * intensity] });
    splatStack.push({ x: emitters[1].x * canvas.width, y: emitters[1].y * canvas.height, dx: -dx, dy, color: [5 * intensity * pumpPower, 0.2 * intensity, 4 * intensity * pumpPower] });
    
    if (bassEnergy > 0.3) {
      const velInput = bass * 0.05 * bassEnergy;
      splat(canvas.width * 0.5, canvas.height * 0.85, 0, -velInput * 8, [0, 0, 0], 0.04);
    }
    
    if (bassEnergy > 0.4) {
      const numSplats = Math.floor(bassEnergy * 3) + 1;
      for (let i = 0; i < numSplats; i++) {
        const x = canvas.width * (0.1 + Math.random() * 0.8);
        const y = canvas.height * (0.6 + Math.random() * 0.35);
        const angle = -Math.PI/2 + (Math.random() - 0.5) * 1.0;
        const force = bass * 0.8 * bassEnergy;
        splatStack.push({ x, y, dx: Math.cos(angle) * force, dy: Math.sin(angle) * force, color: [5 * intensity * bassEnergy, 0.2 * intensity * bassEnergy, 2 * intensity] });
      }
    }
  }
  
  // MITTEN (tiefes Blau / Indigo)
  if (mid > 80) {
    const intensity = Math.min(mid / 500, 0.15);
    const angle = Date.now() * 0.002;
    const force = mid * 0.08;
    splatStack.push({ x: emitters[2].x * canvas.width, y: emitters[2].y * canvas.height, dx: Math.cos(angle) * force, dy: Math.sin(angle) * force, color: [0.3 * intensity, 0.2 * intensity, 1.2 * intensity] });
  }
  
  // HÖHEN (tiefes Blau / Cyan-Blau)
  if (treble > 80) {
    const intensity = Math.min(treble / 500, 0.12);
    const dx = (Math.random() - 0.5) * treble * 0.05;
    const dy = (Math.random() - 0.5) * treble * 0.05;
    splatStack.push({ x: emitters[3].x * canvas.width, y: emitters[3].y * canvas.height, dx, dy, color: [0.15 * intensity, 0.3 * intensity, 0.8 * intensity] });
    splatStack.push({ x: emitters[4].x * canvas.width, y: emitters[4].y * canvas.height, dx: -dx, dy: -dy, color: [0.2 * intensity, 0.15 * intensity, 0.7 * intensity] });
  }
  
  lastSubBass = subBass; lastBass = bass; lastMid = mid;
}

function fluidUpdate() {
  gl.viewport(0, 0, textureWidth, textureHeight);
  
  while (splatStack.length > 0) {
    let s = splatStack.pop();
    splat(s.x, s.y, s.dx, s.dy, s.color);
  }
  
  curlProgram.bind();
  gl.uniform2f(curlProgram.uniforms.texelSize, 1.0 / textureWidth, 1.0 / textureHeight);
  gl.uniform1i(curlProgram.uniforms.uVelocity, velocity.read.texId);
  blit(curl.fbo);
  
  vorticityProgram.bind();
  gl.uniform2f(vorticityProgram.uniforms.texelSize, 1.0 / textureWidth, 1.0 / textureHeight);
  gl.uniform1i(vorticityProgram.uniforms.uVelocity, velocity.read.texId);
  gl.uniform1i(vorticityProgram.uniforms.uCurl, curl.texId);
  gl.uniform1f(vorticityProgram.uniforms.curl, config.CURL);
  gl.uniform1f(vorticityProgram.uniforms.dt, 0.016);
  blit(velocity.write.fbo);
  velocity.swap();
  
  divergenceProgram.bind();
  gl.uniform2f(divergenceProgram.uniforms.texelSize, 1.0 / textureWidth, 1.0 / textureHeight);
  gl.uniform1i(divergenceProgram.uniforms.uVelocity, velocity.read.texId);
  blit(divergence.fbo);
  
  clearProgram.bind();
  let pressureTexId = pressure.read.texId;
  gl.activeTexture(gl.TEXTURE0 + pressureTexId);
  gl.bindTexture(gl.TEXTURE_2D, pressure.read.texture);
  gl.uniform1i(clearProgram.uniforms.uTexture, pressureTexId);
  gl.uniform1f(clearProgram.uniforms.value, config.PRESSURE_DISSIPATION);
  blit(pressure.write.fbo);
  pressure.swap();
  
  pressureProgram.bind();
  gl.uniform2f(pressureProgram.uniforms.texelSize, 1.0 / textureWidth, 1.0 / textureHeight);
  gl.uniform1i(pressureProgram.uniforms.uDivergence, divergence.texId);
  for (let i = 0; i < config.PRESSURE_ITERATIONS; i++) {
    gl.uniform1i(pressureProgram.uniforms.uPressure, pressure.read.texId);
    blit(pressure.write.fbo);
    pressure.swap();
  }
  
  gradientSubtractProgram.bind();
  gl.uniform2f(gradientSubtractProgram.uniforms.texelSize, 1.0 / textureWidth, 1.0 / textureHeight);
  gl.uniform1i(gradientSubtractProgram.uniforms.uPressure, pressure.read.texId);
  gl.uniform1i(gradientSubtractProgram.uniforms.uVelocity, velocity.read.texId);
  blit(velocity.write.fbo);
  velocity.swap();
  
  advectionProgram.bind();
  gl.uniform2f(advectionProgram.uniforms.texelSize, 1.0 / textureWidth, 1.0 / textureHeight);
  let velocityTexId = velocity.read.texId;
  gl.uniform1i(advectionProgram.uniforms.uVelocity, velocityTexId);
  gl.uniform1i(advectionProgram.uniforms.uSource, velocityTexId);
  gl.uniform1f(advectionProgram.uniforms.dt, 0.016);
  gl.uniform1f(advectionProgram.uniforms.dissipation, config.VELOCITY_DISSIPATION);
  blit(velocity.write.fbo);
  velocity.swap();
  
  gl.uniform1i(advectionProgram.uniforms.uSource, density.read.texId);
  gl.uniform1f(advectionProgram.uniforms.dissipation, config.DENSITY_DISSIPATION);
  blit(density.write.fbo);
  density.swap();
  
  gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
  displayProgram.bind();
  gl.uniform1i(displayProgram.uniforms.uTexture, density.read.texId);
  blit(null);
}

function drawOverlayFrame() {
  overlayCtx.clearRect(0, 0, w, h);
  
  if (avg_circle) {
    drawAverageCircle();
  }
  
  drawWaveform();
}

// ========== PLAYLIST ==========
const audioExtensions = /\.(mp3|flac|wav|ogg|oga|m4a|aac|opus|weba)$/i;
const playlistExtensions = /\.(m3u|m3u8|pls|asx|xspf)$/i;

function stripExtension(name) {
  return name.replace(/\.[^/.]+$/, "");
}

function isAudioFile(file) {
  if (!file) return false;
  return (file.type && file.type.startsWith('audio/')) || audioExtensions.test(file.name);
}

function isPlaylistFile(file) {
  if (!file) return false;
  return playlistExtensions.test(file.name);
}

function deriveNameFromPath(path) {
  const lastPart = (path || '').split(/[\\\\/]/).pop() || 'Unbenannt';
  return stripExtension(lastPart);
}

async function parsePlaylistFile(file, allFiles) {
  const text = await file.text();
  const entries = [];
  const audioLookup = new Map();
  allFiles.filter(isAudioFile).forEach(f => audioLookup.set(f.name.toLowerCase(), f));

  const addLocalOrRemote = (raw) => {
    if (!raw) return;
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    if (/^https?:\/\//i.test(line) || line.startsWith('blob:')) {
      entries.push({ name: deriveNameFromPath(line), url: line });
      return;
    }
    const normalized = line.split(/[\\\\/]/).pop().toLowerCase();
    const local = audioLookup.get(normalized);
    if (local) entries.push({ name: stripExtension(local.name), url: URL.createObjectURL(local) });
  };

  const ext = file.name.split('.').pop().toLowerCase();
  if (ext === 'm3u' || ext === 'm3u8') {
    text.split(/\r?\n/).forEach(addLocalOrRemote);
  } else if (ext === 'pls') {
    const matches = [...text.matchAll(/file\d+=([^\n\r]+)/ig)];
    matches.forEach(match => addLocalOrRemote(match[1]));
  } else if (ext === 'xspf' || ext === 'asx') {
    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(text, 'application/xml');
      const nodes = doc.querySelectorAll('location, ref[href], entry ref, media ref');
      nodes.forEach(node => {
        const url = node.textContent || node.getAttribute('href');
        addLocalOrRemote(url);
      });
    } catch (err) {
      console.warn('Playlist parse error', err);
    }
  }

  return entries;
}

async function loadPlaylist(event) {
  const files = Array.from(event.target.files);
  if (!files.length) return;
  
  initAudioContext();
  if (audioContext.state === 'suspended') audioContext.resume();

  const audioEntries = files.filter(isAudioFile).map(file => ({ name: stripExtension(file.name), url: URL.createObjectURL(file) }));
  const playlistFiles = files.filter(isPlaylistFile);

  let parsedEntries = [];
  for (const pl of playlistFiles) {
    const parsed = await parsePlaylistFile(pl, files);
    parsedEntries = parsedEntries.concat(parsed);
  }

  const merged = [...parsedEntries, ...audioEntries];
  const seen = new Set();
  playlist = merged.filter(entry => {
    const key = `${entry.name}-${entry.url}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (!playlist.length) {
    document.getElementById('trackInfo').textContent = '⚠️ Keine unterstützten Audio- oder Playlist-Einträge gefunden';
    return;
  }
  
  const audioPlayer = document.getElementById('audioPlayer');
  
  if (!audioPlayer.dataset.connected) {
    const source = audioContext.createMediaElementSource(audioPlayer);
    source.connect(analyser);
    source.connect(audioContext.destination);
    audioPlayer.dataset.connected = 'true';
    
    audioPlayer.addEventListener('ended', () => { currentTrackIndex = (currentTrackIndex + 1) % playlist.length; playCurrentTrack(); });
    audioPlayer.addEventListener('play', () => { audioActive = true; document.getElementById('playBtn').textContent = '⏸️ Pause'; if (audioContext && audioContext.state === 'suspended') audioContext.resume(); });
    audioPlayer.addEventListener('pause', () => { audioActive = false; document.getElementById('playBtn').textContent = '▶️ Play'; });
  }
  
  currentTrackIndex = 0;
  playCurrentTrack();
}

function playCurrentTrack() {
  if (!playlist.length) return;
  const track = playlist[currentTrackIndex];
  const audioPlayer = document.getElementById('audioPlayer');
  const btn = document.getElementById('playBtn');
  audioPlayer.src = track.url;
  
  const playPromise = audioPlayer.play();
  if (playPromise !== undefined) {
    playPromise.then(() => {
      audioActive = true; btn.textContent = '⏸️ Pause';
      document.getElementById('trackInfo').textContent = `🎵 ${currentTrackIndex + 1}/${playlist.length}: ${track.name}`;
    }).catch(error => {
      console.log('Autoplay blocked:', error);
      btn.textContent = '▶️ Play';
      document.getElementById('trackInfo').textContent = `⏸️ Klicke PLAY! - ${track.name}`;
    });
  }
}

function nextTrack() { if (!playlist.length) return; currentTrackIndex = (currentTrackIndex + 1) % playlist.length; playCurrentTrack(); }
function prevTrack() { if (!playlist.length) return; currentTrackIndex = (currentTrackIndex - 1 + playlist.length) % playlist.length; playCurrentTrack(); }
function togglePlay() { const audioPlayer = document.getElementById('audioPlayer'); if (audioPlayer.paused) audioPlayer.play(); else audioPlayer.pause(); }

// ========== RESIZE HANDLER ==========
window.addEventListener('resize', () => {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  initFramebuffers();
  
  let overlayCanvas = document.getElementById('overlayCanvas');
  overlayCanvas.width = window.innerWidth;
  overlayCanvas.height = window.innerHeight;
  w = window.innerWidth;
  h = window.innerHeight;
  cx = w / 2;
  cy = h / 2;
  
  points.forEach(p => p.updateDynamics());
  if (avg_circle) avg_circle.update();
});

// ========== MOUSE INTERACTION ==========
canvas.addEventListener("mousemove", (e) => {
  pointers[0].moved = pointers[0].down;
  pointers[0].dx = (e.offsetX - pointers[0].x) * 10.0;
  pointers[0].dy = (e.offsetY - pointers[0].y) * 10.0;
  pointers[0].x = e.offsetX;
  pointers[0].y = e.offsetY;
});

canvas.addEventListener("mousedown", () => {
  pointers[0].down = true;
  pointers[0].color = [Math.random() * 8 + 3, Math.random() * 1, Math.random() * 6 + 2];
});

window.addEventListener("mouseup", () => pointers[0].down = false);

canvas.addEventListener("touchmove", (e) => {
  e.preventDefault();
  const touch = e.touches[0];
  pointers[0].moved = pointers[0].down;
  pointers[0].dx = (touch.clientX - pointers[0].x) * 10.0;
  pointers[0].dy = (touch.clientY - pointers[0].y) * 10.0;
  pointers[0].x = touch.clientX;
  pointers[0].y = touch.clientY;
});

canvas.addEventListener("touchstart", (e) => {
  const touch = e.touches[0];
  pointers[0].down = true;
  pointers[0].x = touch.clientX;
  pointers[0].y = touch.clientY;
  pointers[0].color = [Math.random() * 8 + 3, Math.random() * 1, Math.random() * 6 + 2];
});

window.addEventListener("touchend", () => pointers[0].down = false);

setInterval(() => {
  if (pointers[0].moved) {
    splat(pointers[0].x, pointers[0].y, pointers[0].dx, pointers[0].dy, pointers[0].color);
    pointers[0].moved = false;
  }
}, 16);

// ========== START ==========
initOverlayCanvas();
update();
