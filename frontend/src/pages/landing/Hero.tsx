// Hero — port of the design's hero section + sculptural canvas engine.
//
// Decorative canvases (dither + sculpture) are ported as-is: they are
// procedural art with no data dependency. The status line is live:
// the clock is real client time and the availability line is wired to
// GET /health (real uptime / real error state, never a canned "warm").
import { useEffect, useRef, useState } from "react";
import { useHealth } from "../../lib/hooks";
import { BOND_DISPLAY, DIAMOND_SHORT } from "../../config";

const FIG_META = [
  { code: "fig. a", name: "veritas.bust" },
  { code: "fig. b", name: "quorum.sphere" },
  { code: "fig. c", name: "vault.seal" },
];
const STYLES = ["marble", "engrave", "ascii"] as const;
type StyleMode = (typeof STYLES)[number];
const GLYPHS = ["0x", "9a", "4b", "f2", "e7", "c1", "8f", "d4", "#", "=", ":", "."];

function useUtcClock(): string {
  const [now, setNow] = useState(() => new Date().toISOString().slice(11, 19) + " UTC+0");
  useEffect(() => {
    const t = setInterval(() => {
      setNow(new Date().toISOString().slice(11, 19) + " UTC+0");
    }, 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

interface EngineApi {
  setStyle: (s: StyleMode) => void;
  setFig: (i: number) => void;
  destroy: () => void;
}

function createHeroEngine(
  dCanvas: HTMLCanvasElement,
  sCanvas: HTMLCanvasElement,
  rightBox: HTMLElement,
  captionEl: HTMLElement,
  onMorph: (fig: number, style: StyleMode) => void,
): EngineApi {
  // getContext("2d") on a <canvas> element does not return null in real
  // browsers — but it DOES in jsdom (no canvas implementation). The hero
  // is decorative, so a null context runs a no-op engine instead of
  // crashing the page (this also keeps the app smoke test renderable).
  const dCtxRaw = dCanvas.getContext("2d");
  const sCtxRaw = sCanvas.getContext("2d");
  if (!dCtxRaw || !sCtxRaw) {
    return { setStyle: () => {}, setFig: () => {}, destroy: () => {} };
  }
  const dCtx = dCtxRaw;
  const sCtx = sCtxRaw;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const MW = 360;
  const MH = 440;

  function makePedestal(ctx: CanvasRenderingContext2D) {
    const gBase = ctx.createLinearGradient(115, 0, 245, 0);
    gBase.addColorStop(0, "#D8D8D8");
    gBase.addColorStop(0.28, "#FFFFFF");
    gBase.addColorStop(0.62, "#787878");
    gBase.addColorStop(1, "#202020");
    ctx.fillStyle = gBase;
    ctx.beginPath();
    ctx.moveTo(116, 412);
    ctx.quadraticCurveTo(180, 424, 244, 412);
    ctx.lineTo(238, 392);
    ctx.quadraticCurveTo(180, 402, 122, 392);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(180, 391, 58, 9, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = gBase;
    ctx.beginPath();
    ctx.moveTo(140, 388);
    ctx.quadraticCurveTo(154, 362, 152, 336);
    ctx.lineTo(208, 336);
    ctx.quadraticCurveTo(206, 362, 220, 388);
    ctx.quadraticCurveTo(180, 396, 140, 388);
    ctx.closePath();
    ctx.fill();
    for (let i = 0; i < 7; i++) {
      const fx = 152 + i * 9.5;
      ctx.strokeStyle = i < 3 ? "rgba(255,255,255,0.45)" : "rgba(0,0,0,0.55)";
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.moveTo(fx, 340);
      ctx.lineTo(fx + (i - 3) * 1.4, 386);
      ctx.stroke();
    }
    const gCol = ctx.createLinearGradient(135, 326, 225, 344);
    gCol.addColorStop(0, "#FFFFFF");
    gCol.addColorStop(0.5, "#9A9A9A");
    gCol.addColorStop(1, "#1A1A1A");
    ctx.fillStyle = gCol;
    ctx.beginPath();
    ctx.ellipse(180, 336, 40, 10, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  function buildSculptureMap(figIdx: number) {
    const c = document.createElement("canvas");
    c.width = MW;
    c.height = MH;
    const ctx = c.getContext("2d")!;
    ctx.clearRect(0, 0, MW, MH);
    makePedestal(ctx);
    if (figIdx === 0) {
      const gTorso = ctx.createRadialGradient(138, 258, 12, 180, 275, 132);
      gTorso.addColorStop(0, "#FFFFFF");
      gTorso.addColorStop(0.38, "#D2D2D2");
      gTorso.addColorStop(0.72, "#5C5C5C");
      gTorso.addColorStop(1, "#151515");
      ctx.fillStyle = gTorso;
      ctx.beginPath();
      ctx.moveTo(84, 244);
      ctx.bezierCurveTo(92, 214, 128, 200, 160, 198);
      ctx.lineTo(208, 200);
      ctx.bezierCurveTo(246, 206, 276, 224, 280, 252);
      ctx.bezierCurveTo(282, 294, 236, 332, 180, 338);
      ctx.bezierCurveTo(122, 332, 78, 288, 84, 244);
      ctx.closePath();
      ctx.fill();
      ctx.save();
      ctx.clip();
      for (let f = 0; f < 5; f++) {
        ctx.strokeStyle = "rgba(0,0,0,0.42)";
        ctx.lineWidth = 8 - f;
        ctx.beginPath();
        ctx.moveTo(96 + f * 18, 212);
        ctx.quadraticCurveTo(165 + f * 10, 275 + f * 6, 260, 296 - f * 14);
        ctx.stroke();
        ctx.strokeStyle = "rgba(255,255,255,0.52)";
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(92 + f * 18, 208);
        ctx.quadraticCurveTo(162 + f * 10, 270 + f * 6, 256, 291 - f * 14);
        ctx.stroke();
      }
      const gClav = ctx.createRadialGradient(178, 232, 2, 178, 232, 36);
      gClav.addColorStop(0, "rgba(0,0,0,0.65)");
      gClav.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = gClav;
      ctx.fillRect(130, 200, 100, 70);
      ctx.restore();
      const gNeck = ctx.createLinearGradient(142, 160, 218, 228);
      gNeck.addColorStop(0, "#EFEFEF");
      gNeck.addColorStop(0.45, "#A4A4A4");
      gNeck.addColorStop(0.75, "#343434");
      gNeck.addColorStop(1, "#121212");
      ctx.fillStyle = gNeck;
      ctx.beginPath();
      ctx.moveTo(148, 162);
      ctx.lineTo(206, 172);
      ctx.quadraticCurveTo(212, 210, 222, 234);
      ctx.quadraticCurveTo(182, 246, 142, 230);
      ctx.quadraticCurveTo(150, 200, 148, 162);
      ctx.closePath();
      ctx.fill();
      const gJawSh = ctx.createRadialGradient(184, 186, 6, 184, 194, 42);
      gJawSh.addColorStop(0, "rgba(0,0,0,0.82)");
      gJawSh.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = gJawSh;
      ctx.beginPath();
      ctx.ellipse(184, 194, 38, 20, 0.15, 0, Math.PI * 2);
      ctx.fill();
      const gFace = ctx.createRadialGradient(158, 112, 10, 182, 128, 86);
      gFace.addColorStop(0, "#FFFFFF");
      gFace.addColorStop(0.42, "#DCDCDC");
      gFace.addColorStop(0.75, "#686868");
      gFace.addColorStop(1, "#181818");
      ctx.fillStyle = gFace;
      ctx.beginPath();
      ctx.moveTo(142, 82);
      ctx.bezierCurveTo(156, 56, 204, 58, 220, 88);
      ctx.bezierCurveTo(226, 98, 226, 112, 224, 120);
      ctx.lineTo(237, 142);
      ctx.quadraticCurveTo(234, 149, 222, 149);
      ctx.lineTo(226, 159);
      ctx.quadraticCurveTo(221, 164, 224, 169);
      ctx.quadraticCurveTo(224, 184, 204, 192);
      ctx.bezierCurveTo(176, 198, 146, 182, 138, 154);
      ctx.bezierCurveTo(132, 128, 134, 100, 142, 82);
      ctx.closePath();
      ctx.fill();
      const gEye = ctx.createRadialGradient(212, 123, 2, 210, 125, 19);
      gEye.addColorStop(0, "rgba(0,0,0,0.88)");
      gEye.addColorStop(0.65, "rgba(0,0,0,0.45)");
      gEye.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = gEye;
      ctx.beginPath();
      ctx.ellipse(210, 125, 18, 11, -0.1, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.92)";
      ctx.lineWidth = 3.2;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(192, 113);
      ctx.quadraticCurveTo(212, 109, 225, 116);
      ctx.stroke();
      ctx.strokeStyle = "rgba(255,255,255,0.95)";
      ctx.lineWidth = 2.6;
      ctx.beginPath();
      ctx.moveTo(223, 119);
      ctx.lineTo(234, 141);
      ctx.stroke();
      const gCheek = ctx.createRadialGradient(192, 142, 3, 192, 144, 24);
      gCheek.addColorStop(0, "rgba(255,255,255,0.75)");
      gCheek.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = gCheek;
      ctx.beginPath();
      ctx.arc(192, 144, 24, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(0,0,0,0.72)";
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.moveTo(212, 162);
      ctx.quadraticCurveTo(219, 163, 224, 161);
      ctx.stroke();
      ctx.strokeStyle = "rgba(0,0,0,0.45)";
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(176, 170);
      ctx.quadraticCurveTo(196, 186, 214, 182);
      ctx.stroke();
      const locks: [number, number, number][] = [
        [140, 74, 24], [164, 58, 25], [192, 54, 24], [216, 66, 20], [228, 82, 15],
        [126, 94, 23], [146, 86, 21], [174, 76, 22], [198, 78, 19],
        [118, 118, 22], [136, 112, 20], [156, 102, 18], [178, 94, 16],
        [122, 144, 20], [140, 136, 18], [156, 126, 15],
        [132, 166, 17], [146, 158, 15],
      ];
      locks.forEach((lk, li) => {
        const [lx, ly, lr] = lk;
        ctx.fillStyle = "rgba(8,8,8,0.78)";
        ctx.beginPath();
        ctx.arc(lx + 4, ly + 5, lr, 0, Math.PI * 2);
        ctx.fill();
        const gL = ctx.createRadialGradient(lx - lr * 0.35, ly - lr * 0.38, lr * 0.1, lx, ly, lr);
        const lit = li < 11 ? 255 : 218;
        gL.addColorStop(0, `rgb(${lit},${lit},${lit})`);
        gL.addColorStop(0.52, "rgb(148,148,148)");
        gL.addColorStop(0.85, "rgb(42,42,42)");
        gL.addColorStop(1, "rgb(14,14,14)");
        ctx.fillStyle = gL;
        ctx.beginPath();
        ctx.arc(lx, ly, lr, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "rgba(0,0,0,0.48)";
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.arc(lx + 1, ly + 1, lr * 0.56, 0.3, 4.1);
        ctx.stroke();
      });
    } else if (figIdx === 1) {
      const gStem = ctx.createLinearGradient(168, 0, 192, 0);
      gStem.addColorStop(0, "#FFFFFF");
      gStem.addColorStop(0.55, "#7A7A7A");
      gStem.addColorStop(1, "#1A1A1A");
      ctx.fillStyle = gStem;
      ctx.fillRect(170, 266, 20, 70);
      const rings = [
        { rx: 112, ry: 112, rot: 0, w: 15, c1: "#FFFFFF", c2: "#3A3A3A" },
        { rx: 110, ry: 44, rot: -0.46, w: 13, c1: "#F5F5F5", c2: "#2C2C2C" },
        { rx: 108, ry: 42, rot: 0.52, w: 12, c1: "#E6E6E6", c2: "#242424" },
      ];
      rings.forEach((rg) => {
        ctx.save();
        ctx.translate(180, 182);
        ctx.rotate(rg.rot);
        const gr = ctx.createLinearGradient(-rg.rx, -rg.ry, rg.rx, rg.ry);
        gr.addColorStop(0, rg.c1);
        gr.addColorStop(0.45, "#A0A0A0");
        gr.addColorStop(1, rg.c2);
        ctx.strokeStyle = gr;
        ctx.lineWidth = rg.w;
        ctx.beginPath();
        ctx.ellipse(0, 0, rg.rx, rg.ry, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.strokeStyle = "rgba(0,0,0,0.55)";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.ellipse(0, 0, rg.rx - rg.w * 0.38, rg.ry - rg.w * 0.38, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      });
      const facets: { pts: [number, number][]; col: string }[] = [
        { pts: [[180, 118], [134, 182], [180, 196]], col: "#FFFFFF" },
        { pts: [[180, 118], [180, 196], [226, 182]], col: "#A8A8A8" },
        { pts: [[134, 182], [180, 246], [180, 196]], col: "#787878" },
        { pts: [[226, 182], [180, 196], [180, 246]], col: "#282828" },
      ];
      facets.forEach((fc) => {
        ctx.fillStyle = fc.col;
        ctx.beginPath();
        ctx.moveTo(fc.pts[0][0], fc.pts[0][1]);
        ctx.lineTo(fc.pts[1][0], fc.pts[1][1]);
        ctx.lineTo(fc.pts[2][0], fc.pts[2][1]);
        ctx.closePath();
        ctx.fill();
      });
      [[88, 128], [274, 148], [198, 72]].forEach((pt) => {
        const gs = ctx.createRadialGradient(pt[0] - 6, pt[1] - 6, 2, pt[0], pt[1], 19);
        gs.addColorStop(0, "#FFFFFF");
        gs.addColorStop(0.55, "#9A9A9A");
        gs.addColorStop(1, "#181818");
        ctx.fillStyle = gs;
        ctx.beginPath();
        ctx.arc(pt[0], pt[1], 18, 0, Math.PI * 2);
        ctx.fill();
      });
    } else {
      const gMount = ctx.createLinearGradient(164, 0, 196, 0);
      gMount.addColorStop(0, "#FFFFFF");
      gMount.addColorStop(0.6, "#767676");
      gMount.addColorStop(1, "#1A1A1A");
      ctx.fillStyle = gMount;
      ctx.fillRect(166, 276, 28, 60);
      function octPath(cx: number, cy: number, r: number) {
        ctx.beginPath();
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
          const x = cx + Math.cos(a) * r;
          const y = cy + Math.sin(a) * r;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.closePath();
      }
      const gOct = ctx.createLinearGradient(70, 74, 290, 290);
      gOct.addColorStop(0, "#FFFFFF");
      gOct.addColorStop(0.42, "#C8C8C8");
      gOct.addColorStop(0.75, "#4A4A4A");
      gOct.addColorStop(1, "#141414");
      ctx.fillStyle = gOct;
      octPath(180, 182, 114);
      ctx.fill();
      const gCav = ctx.createLinearGradient(100, 102, 260, 262);
      gCav.addColorStop(0, "#1C1C1C");
      gCav.addColorStop(0.5, "#5E5E5E");
      gCav.addColorStop(1, "#E8E8E8");
      ctx.fillStyle = gCav;
      octPath(180, 182, 90);
      ctx.fill();
      for (let rb = 0; rb < 8; rb++) {
        const ang = (rb / 8) * Math.PI * 2;
        ctx.save();
        ctx.translate(180, 182);
        ctx.rotate(ang);
        const gRib = ctx.createLinearGradient(28, -8, 86, 8);
        gRib.addColorStop(0, "#FFFFFF");
        gRib.addColorStop(0.6, "#8E8E8E");
        gRib.addColorStop(1, "#222222");
        ctx.fillStyle = gRib;
        ctx.fillRect(30, -6.5, 56, 13);
        ctx.restore();
      }
      ctx.strokeStyle = "#FFFFFF";
      ctx.lineWidth = 10;
      ctx.beginPath();
      ctx.arc(180, 182, 54, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = "#242424";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(180, 182, 48, 0, Math.PI * 2);
      ctx.stroke();
      const gHub = ctx.createRadialGradient(168, 170, 4, 180, 182, 34);
      gHub.addColorStop(0, "#FFFFFF");
      gHub.addColorStop(0.52, "#A2A2A2");
      gHub.addColorStop(1, "#161616");
      ctx.fillStyle = gHub;
      ctx.beginPath();
      ctx.arc(180, 182, 33, 0, Math.PI * 2);
      ctx.fill();
    }
    const img = ctx.getImageData(0, 0, MW, MH).data;
    const lum = new Float32Array(MW * MH);
    const alp = new Float32Array(MW * MH);
    for (let p = 0; p < MW * MH; p++) {
      alp[p] = img[p * 4 + 3] / 255;
      lum[p] = img[p * 4] / 255;
    }
    return { canvas: c, lum, alp };
  }

  const maps = [buildSculptureMap(0), buildSculptureMap(1), buildSculptureMap(2)];
  let figA = 0;
  let figB = 0;
  let morphing = false;
  let morphStart = 0;
  const morphDur = 1500;
  let styleMode: StyleMode = "marble";
  let autoTimer = performance.now();
  const holdMs = 6000;
  let pmx = 0.5;
  let pmy = 0.5;
  let tmx = 0.5;
  let tmy = 0.5;
  let inside = false;
  let hoverAmt = 0;
  let dW = 600;
  let dH = 600;
  let sW = 500;
  let sH = 540;
  let raf = 0;
  let destroyed = false;

  const dust: { x: number; y: number; vx: number; vy: number; sz: number; life: number; glyph: string | null; hot: boolean }[] = [];
  for (let i = 0; i < 64; i++) {
    dust.push({
      x: 0.52 + Math.random() * 0.42,
      y: 0.14 + Math.random() * 0.72,
      vx: 0.0005 + Math.random() * 0.0014,
      vy: (Math.random() - 0.5) * 0.0004,
      sz: 2 + Math.floor(Math.random() * 3.5),
      life: Math.random(),
      glyph: Math.random() > 0.55 ? GLYPHS[Math.floor(Math.random() * GLYPHS.length)] : null,
      hot: Math.random() > 0.9,
    });
  }
  const seeds: number[] = [];
  for (let k = 0; k < 2048; k++) seeds.push(Math.abs(Math.sin(k * 12.9898 + 78.233) * 43758.5453) % 1);

  function syncCaption() {
    const meta = FIG_META[figB];
    captionEl.textContent = `// ${meta.code} · ${meta.name} · hover to decrypt · click to morph`;
  }

  function triggerMorph(nextFig?: number, nextStyle?: StyleMode) {
    const now = performance.now();
    if (morphing) figA = figB;
    figB = typeof nextFig === "number" ? ((nextFig + 3) % 3) : ((figB + 1) % 3);
    if (nextStyle) styleMode = nextStyle;
    else styleMode = STYLES[(STYLES.indexOf(styleMode) + 1) % STYLES.length];
    morphing = true;
    morphStart = now;
    autoTimer = now;
    syncCaption();
    onMorph(figB, styleMode);
  }

  function onMouseMove(e: MouseEvent) {
    const r = rightBox.getBoundingClientRect();
    tmx = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    tmy = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
    inside = true;
  }
  function onMouseLeave() {
    inside = false;
    tmx = 0.5;
    tmy = 0.5;
  }
  function onClick(e: MouseEvent) {
    if ((e.target as HTMLElement).closest("button")) return;
    triggerMorph();
  }
  function resize() {
    const dr = dCanvas.getBoundingClientRect();
    dW = Math.max(240, Math.floor(dr.width));
    dH = Math.max(360, Math.floor(dr.height));
    dCanvas.width = dW * dpr;
    dCanvas.height = dH * dpr;
    dCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const sr = rightBox.getBoundingClientRect();
    sW = Math.max(280, Math.floor(sr.width));
    sH = Math.max(380, Math.floor(sr.height));
    sCanvas.width = sW * dpr;
    sCanvas.height = sH * dpr;
    sCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  const tintCanvas = document.createElement("canvas");
  tintCanvas.width = MW;
  tintCanvas.height = MH;
  const tintCtx = tintCanvas.getContext("2d");

  function drawHero(now: number) {
    if (destroyed) return;
    const t = now * 0.001;
    pmx += (tmx - pmx) * 0.1;
    pmy += (tmy - pmy) * 0.1;
    hoverAmt += ((inside ? 1 : 0) - hoverAmt) * 0.12;
    let mProg = 0;
    if (morphing) {
      mProg = (now - morphStart) / morphDur;
      if (mProg >= 1) {
        mProg = 0;
        morphing = false;
        figA = figB;
        autoTimer = now;
      }
    } else if (now - autoTimer > holdMs) {
      triggerMorph();
    }
    const mWave = Math.sin(mProg * Math.PI);
    const activeMap = mProg > 0.5 ? maps[figB] : maps[figA];
    const isLight = document.documentElement.getAttribute("data-theme") === "light";

    dCtx.clearRect(0, 0, dW, dH);
    const pitch = 15;
    const sq = 10;
    const cols = Math.ceil(dW / pitch);
    const rows = Math.ceil(dH / pitch);
    const dPtrX = pmx * dW * 0.85 + dW * 0.1;
    const dPtrY = pmy * dH;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = c * pitch;
        const y = r * pitch;
        const nx = x / dW;
        const fade = Math.max(0, Math.min(1, (nx - 0.04) / 0.34));
        if (fade <= 0.01) continue;
        const sd = seeds[(r * 43 + c * 17) % seeds.length];
        const dp = inside ? Math.hypot(x - dPtrX, y - dPtrY) : 999;
        const prox = dp < 120 ? 1 - dp / 120 : 0;
        if (sd > 0.36 || prox > 0.25) {
          const pulse = 0.5 + 0.5 * Math.sin(t * 0.85 + c * 0.3 + r * 0.22);
          const al = (0.035 + sd * 0.085 + pulse * 0.03 + prox * 0.16) * fade;
          dCtx.fillStyle = isLight
            ? `rgba(20,20,20,${al.toFixed(3)})`
            : `rgba(235,234,228,${al.toFixed(3)})`;
          dCtx.fillRect(x, y, sq, sq);
        }
      }
    }
    const bx = Math.floor((dW * 0.2) / pitch) * pitch;
    const by = Math.floor((dH * 0.74) / pitch) * pitch;
    dCtx.save();
    dCtx.shadowColor = "rgba(255, 87, 34, 0.88)";
    dCtx.shadowBlur = 14;
    dCtx.fillStyle = "#FF5722";
    dCtx.fillRect(bx, by, sq, sq);
    dCtx.restore();

    sCtx.clearRect(0, 0, sW, sH);
    sCtx.save();
    sCtx.setLineDash([5, 7]);
    sCtx.strokeStyle = isLight ? "rgba(20,20,20,0.16)" : "rgba(255,255,255,0.11)";
    sCtx.lineWidth = 1;
    sCtx.beginPath();
    sCtx.moveTo(sW * 0.5, 22);
    sCtx.lineTo(sW * 0.5, sH - 36);
    sCtx.stroke();
    sCtx.restore();

    const scale = Math.min((sW * 0.82) / MW, (sH * 0.86) / MH);
    const dw = MW * scale;
    const dh = MH * scale;
    const ox = (sW - dw) * 0.5 + (pmx - 0.5) * 18;
    const oy = (sH - dh) * 0.48 + (pmy - 0.5) * 12 + Math.sin(t * 1.15) * 4;
    const ptrX = pmx * sW;
    const ptrY = pmy * sH;
    const brushR = 88 * hoverAmt;
    const showAsciiFull = styleMode === "ascii" || mWave > 0.38;
    const showEngrave = styleMode === "engrave" && !showAsciiFull;

    if (!showAsciiFull && !showEngrave) {
      sCtx.save();
      if (isLight && tintCtx) {
        tintCtx.clearRect(0, 0, MW, MH);
        tintCtx.drawImage(activeMap.canvas, 0, 0);
        sCtx.filter = "contrast(1.06) brightness(0.92)";
        sCtx.drawImage(tintCanvas, ox, oy, dw, dh);
        sCtx.filter = "none";
      } else {
        sCtx.drawImage(activeMap.canvas, ox, oy, dw, dh);
      }
      sCtx.restore();
    }

    if (showEngrave) {
      const inkCol = isLight ? "#141414" : "#F3F2EE";
      const bgFill = isLight ? "#D4D3CE" : "#0B0B0C";
      sCtx.save();
      sCtx.globalAlpha = 0.86;
      sCtx.drawImage(activeMap.canvas, ox, oy, dw, dh);
      sCtx.globalCompositeOperation = "source-atop";
      sCtx.fillStyle = bgFill;
      sCtx.fillRect(ox, oy, dw, dh);
      sCtx.restore();
      sCtx.save();
      sCtx.strokeStyle = inkCol;
      sCtx.lineCap = "round";
      const lineStep = 5.2;
      const segStep = 4.0;
      const diagSpan = dw + dh;
      for (let d = -dh; d < diagSpan; d += lineStep) {
        for (let p = 0; p < dh; p += segStep) {
          const sx = ox + d - p;
          const sy = oy + p;
          if (sx < ox || sx >= ox + dw || sy < oy || sy >= oy + dh) continue;
          const mx = Math.floor(((sx - ox) / dw) * MW);
          const my = Math.floor(((sy - oy) / dh) * MH);
          const idx = my * MW + mx;
          const al = activeMap.alp[idx];
          if (al < 0.25) continue;
          const lm = activeMap.lum[idx];
          const w = isLight ? 0.4 + (1 - lm) * 2.7 : 0.35 + lm * 2.65;
          if (w < 0.52) continue;
          sCtx.lineWidth = w;
          sCtx.beginPath();
          sCtx.moveTo(sx, sy);
          sCtx.lineTo(sx - segStep * 0.92, sy + segStep * 0.92);
          sCtx.stroke();
        }
      }
      sCtx.restore();
    }

    if (showAsciiFull || hoverAmt > 0.08) {
      const rowStep = showAsciiFull ? 6.5 : 7.5;
      const colStep = showAsciiFull ? 7.5 : 8.5;
      const shearAmp = showAsciiFull ? 10 + mWave * 34 : hoverAmt * 18;
      if (!showAsciiFull && brushR > 8) {
        sCtx.save();
        sCtx.beginPath();
        sCtx.arc(ptrX, ptrY, brushR * 0.92, 0, Math.PI * 2);
        sCtx.clip();
        sCtx.fillStyle = isLight ? "rgba(228,227,223,0.88)" : "rgba(11,11,12,0.88)";
        sCtx.fillRect(ptrX - brushR, ptrY - brushR, brushR * 2, brushR * 2);
        sCtx.restore();
      }
      sCtx.save();
      sCtx.font = '500 8.5px "JetBrains Mono", monospace';
      sCtx.textBaseline = "middle";
      const asciiChars = [".", ":", "-", "=", "+", "*", "#", "%", "0", "x", "9", "a"];
      const tickSlot = Math.floor(t * 10);
      for (let ry = oy; ry < oy + dh; ry += rowStep) {
        const my = Math.min(MH - 1, Math.max(0, Math.floor(((ry - oy) / dh) * MH)));
        const rowJitter = (seeds[(my * 7 + tickSlot) % seeds.length] - 0.25) * shearAmp;
        for (let rx = ox; rx < ox + dw; rx += colStep) {
          if (!showAsciiFull) {
            const distB = Math.hypot(rx - ptrX, ry - ptrY);
            if (distB > brushR) continue;
          }
          const mx = Math.min(MW - 1, Math.max(0, Math.floor(((rx - ox) / dw) * MW)));
          const id = my * MW + mx;
          if (activeMap.alp[id] < 0.3) continue;
          const lm = activeMap.lum[id];
          const nxLocal = (rx - ox) / dw;
          if (mWave > 0.2 && nxLocal > 0.62 && seeds[(id + tickSlot) % seeds.length] < mWave * 0.72) continue;
          const gx = rx + rowJitter * (0.3 + nxLocal * 0.9);
          const ci = Math.min(asciiChars.length - 1, Math.floor(lm * asciiChars.length));
          const isSpark = (mWave > 0.3 || !showAsciiFull) && seeds[(mx * 19 + my + tickSlot) % seeds.length] > 0.965;
          if (isSpark) {
            sCtx.fillStyle = "#FF5722";
          } else if (isLight) {
            sCtx.fillStyle = `rgba(20,20,20,${(0.28 + (1 - lm) * 0.72).toFixed(2)})`;
          } else {
            sCtx.fillStyle = `rgba(243,242,238,${(0.22 + lm * 0.78).toFixed(2)})`;
          }
          sCtx.fillText(asciiChars[ci], gx, ry);
        }
      }
      sCtx.restore();
    }

    sCtx.save();
    sCtx.font = '500 8.5px "JetBrains Mono", monospace';
    dust.forEach((pt) => {
      pt.x += pt.vx * (1 + mWave * 2.8);
      pt.y += pt.vy;
      pt.life -= 0.0045;
      if (pt.life <= 0 || pt.x > 0.98) {
        pt.x = 0.56 + Math.random() * 0.16;
        pt.y = 0.18 + Math.random() * 0.62;
        pt.life = 0.8 + Math.random() * 0.4;
      }
      const al = Math.sin(Math.min(1, pt.life) * Math.PI) * (0.45 + mWave * 0.45);
      if (al <= 0.02) return;
      sCtx.fillStyle = pt.hot
        ? `rgba(255, 87, 34, ${Math.min(1, al * 1.4).toFixed(2)})`
        : isLight
          ? `rgba(20,20,20,${al.toFixed(2)})`
          : `rgba(243,242,238,${al.toFixed(2)})`;
      if (pt.glyph && (showAsciiFull || mWave > 0.18)) {
        sCtx.fillText(pt.glyph, pt.x * sW, pt.y * sH);
      } else {
        sCtx.fillRect(pt.x * sW, pt.y * sH, pt.sz, pt.sz);
      }
    });
    const pinX = ox + dw * 0.51;
    const pinY = oy + dh * 0.764;
    const pr = 7.5 + Math.sin(t * 2.6) * 1.3;
    sCtx.strokeStyle = "rgba(255, 87, 34, 0.82)";
    sCtx.lineWidth = 1.2;
    sCtx.beginPath();
    sCtx.arc(pinX, pinY, pr, 0, Math.PI * 2);
    sCtx.stroke();
    sCtx.shadowColor = "rgba(255, 87, 34, 0.9)";
    sCtx.shadowBlur = 11;
    sCtx.fillStyle = "#FF5722";
    sCtx.beginPath();
    sCtx.arc(pinX, pinY, 3.3, 0, Math.PI * 2);
    sCtx.fill();
    sCtx.restore();

    // Pause the loop while the hero is off-screen: the dither + sculpture
    // passes cost ~1.6k–29k ops/frame and there is nothing to show.
    // Only schedule the next frame while visible; the observer restarts
    // the loop when the hero scrolls back into view.
    if (visible) raf = requestAnimationFrame(drawHero);
  }

  // Visibility gate for the rAF loop (IntersectionObserver is absent in
  // jsdom/test runtimes — the loop then simply runs unpaused, as before).
  let visible = true;
  let observer: IntersectionObserver | null = null;
  const heroSection = dCanvas.closest("section");
  if (heroSection && typeof IntersectionObserver !== "undefined") {
    observer = new IntersectionObserver(
      (entries) => {
        const nowVisible = entries[0] ? entries[0].isIntersecting : true;
        if (nowVisible === visible) return;
        visible = nowVisible;
        if (visible && !destroyed) {
          autoTimer = performance.now();
          cancelAnimationFrame(raf);
          raf = requestAnimationFrame(drawHero);
        } else {
          cancelAnimationFrame(raf);
        }
      },
      { threshold: 0 },
    );
    observer.observe(heroSection);
  }

  rightBox.addEventListener("mousemove", onMouseMove, { passive: true });
  rightBox.addEventListener("mouseleave", onMouseLeave);
  rightBox.addEventListener("click", onClick);
  window.addEventListener("resize", resize);
  resize();
  syncCaption();
  raf = requestAnimationFrame(drawHero);

  return {
    setStyle: (s: StyleMode) => {
      styleMode = s;
      autoTimer = performance.now();
    },
    setFig: (i: number) => {
      if (i === figB && !morphing) return;
      triggerMorph(i, styleMode);
    },
    destroy: () => {
      destroyed = true;
      cancelAnimationFrame(raf);
      observer?.disconnect();
      rightBox.removeEventListener("mousemove", onMouseMove);
      rightBox.removeEventListener("mouseleave", onMouseLeave);
      rightBox.removeEventListener("click", onClick);
      window.removeEventListener("resize", resize);
    },
  };
}

export function Hero() {
  const clock = useUtcClock();
  const health = useHealth();
  const [styleMode, setStyleMode] = useState<StyleMode>("marble");
  const [fig, setFig] = useState(0);
  const ditherRef = useRef<HTMLCanvasElement>(null);
  const sculptureRef = useRef<HTMLCanvasElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const captionRef = useRef<HTMLSpanElement>(null);
  const engineRef = useRef<EngineApi | null>(null);

  useEffect(() => {
    if (!ditherRef.current || !sculptureRef.current || !rightRef.current || !captionRef.current) return;
    const engine = createHeroEngine(
      ditherRef.current,
      sculptureRef.current,
      rightRef.current,
      captionRef.current,
      (nextFig, nextStyle) => {
        setFig(nextFig);
        setStyleMode(nextStyle);
      },
    );
    engineRef.current = engine;
    return () => {
      engine.destroy();
      engineRef.current = null;
    };
  }, []);

  function pickStyle(s: StyleMode) {
    setStyleMode(s);
    engineRef.current?.setStyle(s);
  }
  function pickFig(i: number) {
    engineRef.current?.setFig(i);
  }

  return (
    <section id="top" className="hero-wrap">
      <canvas id="hero-dither" ref={ditherRef} aria-hidden="true" />
      <div className="container">
        <div className="hero-grid">
          <div className="hero-left">
            <div className="hero-status">
              <span className="status-dot" />
              <span>sepolia diamond {DIAMOND_SHORT}</span>
              <span style={{ color: "var(--text)", fontWeight: 500 }}>{clock}</span>
            </div>
            <h1 className="hero-title">
              <span className="l1">A zero-LLM receipt</span>
              <span className="l2">and verification</span>
              <span className="l2">oracle.</span>
            </h1>
            <p className="hero-sub">
              Deterministic intelligence for Telegraph Season II. Five keyless intents with raw SHA-256 receipts,
              served Always-Warm on Render with strict fail-closed refusals.
            </p>
            <div className="hero-cta-row">
              <a href="#probe" className="btn-solid-accent">
                Start a probe
              </a>
            </div>
            <div className="hero-avail">
              <span className="radar-dot" aria-hidden="true" />
              <div>
                <div className="mono" style={{ fontSize: 11.5, color: "var(--muted)", marginBottom: 2 }}>
                  // availability
                </div>
                <div style={{ fontSize: 13.5, color: "var(--text)" }}>
                  Always-Warm on Render · {BOND_DISPLAY.replace(" Test USDC Bond", " Bond")}
                </div>
                <div className="mono" style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 4 }}>
                  {health.loading && "GET /health — checking live status…"}
                  {health.error && `GET /health — unreachable: ${health.error.message}`}
                  {health.data && `GET /health — ${health.data.status} · uptime ${health.data.uptime_s}s`}
                </div>
              </div>
            </div>
          </div>
          <div
            id="hero-right"
            className="hero-right"
            ref={rightRef}
            title="Hover to decrypt · Click to morph sculpture"
          >
            <canvas id="hero-sculpture" ref={sculptureRef} />
            <div className="hero-micro-bar">
              <span id="hero-caption" ref={captionRef}>
                // fig. a · veritas.bust · hover to decrypt · click to morph
              </span>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <div className="micro-group" role="group" aria-label="Render style">
                  {STYLES.map((s) => (
                    <button
                      key={s}
                      type="button"
                      className={`micro-btn${styleMode === s ? " active" : ""}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        pickStyle(s);
                      }}
                    >
                      {s}
                    </button>
                  ))}
                </div>
                <div className="micro-group" role="group" aria-label="Sculpture figure">
                  {[0, 1, 2].map((i) => (
                    <button
                      key={i}
                      type="button"
                      className={`micro-btn${fig === i ? " active" : ""}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        pickFig(i);
                      }}
                    >
                      fig.{String.fromCharCode(97 + i)}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
