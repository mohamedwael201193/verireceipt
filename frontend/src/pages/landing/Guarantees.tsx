// Guarantees — "Four pillars. Nine guarantees."
//
// The hairline isometric schematics are procedural canvas art ported
// as-is (shared rAF loop, cursor-following focal point, idle drift).
// The copy is fixed marketing text (DESIGN-SPEC §7, verbatim).
// The filter bar is pure UI filtering — no data.
import { useEffect, useRef, useState } from "react";
import { PLATES, type Plate } from "./data";

type Filter = "all" | Plate["cat"];

const C30 = 0.8660254;
const S30 = 0.5;

interface Pt {
  x: number;
  y: number;
}

function iso(x: number, y: number, z: number, cx: number, cy: number): Pt {
  return { x: cx + (x - y) * C30, y: cy + (x + y) * S30 - z };
}

interface PlateState {
  id: string;
  el: HTMLElement;
  cvs: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  w: number;
  h: number;
  px: number;
  py: number;
  tx: number;
  ty: number;
  hover: boolean;
}

export function Guarantees() {
  const [filter, setFilter] = useState<Filter>("all");
  const gridRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const plates: PlateState[] = [];
    grid.querySelectorAll<HTMLElement>(".hl-plate").forEach((el) => {
      const cvs = el.querySelector("canvas");
      const ctx = cvs?.getContext("2d");
      if (!cvs || !ctx) return;
      const hx = el.querySelector<HTMLElement>(".hl-hx");
      const hy = el.querySelector<HTMLElement>(".hl-hy");
      const pin = el.querySelector<HTMLElement>(".hl-pin");
      const xy = el.querySelector<HTMLElement>(".hl-xy");
      const item: PlateState = {
        id: el.getAttribute("data-id") ?? "",
        el,
        cvs,
        ctx,
        w: 300,
        h: 228,
        px: 0.5,
        py: 0.5,
        tx: 0.5,
        ty: 0.5,
        hover: false,
      };
      el.parentElement?.addEventListener("mousemove", (e: MouseEvent) => {
        const r = el.getBoundingClientRect();
        const lx = Math.max(0, Math.min(r.width, e.clientX - r.left));
        const ly = Math.max(0, Math.min(r.height, e.clientY - r.top));
        item.tx = lx / r.width;
        item.ty = ly / r.height;
        item.hover = true;
        if (hx) hx.style.top = `${ly}px`;
        if (hy) hy.style.left = `${lx}px`;
        if (pin) {
          pin.style.left = `${lx}px`;
          pin.style.top = `${ly}px`;
        }
        if (xy) xy.textContent = `x ${String(Math.round(lx)).padStart(3, "0")} · y ${String(Math.round(ly)).padStart(3, "0")}`;
      });
      el.parentElement?.addEventListener("mouseleave", () => {
        item.hover = false;
        item.tx = 0.5;
        item.ty = 0.5;
      });
      plates.push(item);
    });

    function resizeAll() {
      plates.forEach((p) => {
        const r = p.el.getBoundingClientRect();
        if (r.width < 10) return;
        p.w = r.width;
        p.h = r.height;
        p.cvs.width = Math.round(p.w * dpr);
        p.cvs.height = Math.round(p.h * dpr);
        p.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      });
    }
    resizeAll();
    window.addEventListener("resize", resizeAll);

    function isoBox(
      ctx: CanvasRenderingContext2D,
      cx: number,
      cy: number,
      x: number,
      y: number,
      z: number,
      dx: number,
      dy: number,
      dz: number,
      fill: string,
      stroke: string,
      lw?: number,
    ) {
      const p100 = iso(x + dx, y, z, cx, cy);
      const p110 = iso(x + dx, y + dy, z, cx, cy);
      const p010 = iso(x, y + dy, z, cx, cy);
      const p001 = iso(x, y, z + dz, cx, cy);
      const p101 = iso(x + dx, y, z + dz, cx, cy);
      const p111 = iso(x + dx, y + dy, z + dz, cx, cy);
      const p011 = iso(x, y + dy, z + dz, cx, cy);
      ctx.fillStyle = fill;
      ctx.strokeStyle = stroke;
      ctx.lineWidth = lw ?? 0.9;
      ctx.beginPath();
      ctx.moveTo(p010.x, p010.y);
      ctx.lineTo(p110.x, p110.y);
      ctx.lineTo(p111.x, p111.y);
      ctx.lineTo(p011.x, p011.y);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(p100.x, p100.y);
      ctx.lineTo(p110.x, p110.y);
      ctx.lineTo(p111.x, p111.y);
      ctx.lineTo(p101.x, p101.y);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(p001.x, p001.y);
      ctx.lineTo(p101.x, p101.y);
      ctx.lineTo(p111.x, p111.y);
      ctx.lineTo(p011.x, p011.y);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }

    function isoQuad(
      ctx: CanvasRenderingContext2D,
      cx: number,
      cy: number,
      x: number,
      y: number,
      z: number,
      dx: number,
      dy: number,
      fill: string,
      stroke: string,
      lw?: number,
    ) {
      const a = iso(x, y, z, cx, cy);
      const b = iso(x + dx, y, z, cx, cy);
      const c = iso(x + dx, y + dy, z, cx, cy);
      const d = iso(x, y + dy, z, cx, cy);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.lineTo(c.x, c.y);
      ctx.lineTo(d.x, d.y);
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.strokeStyle = stroke;
      ctx.lineWidth = lw ?? 0.9;
      ctx.stroke();
    }

    let raf = 0;
    let destroyed = false;
    function tick(ts: number) {
      if (destroyed) return;
      const t = ts * 0.001;
      const cs = getComputedStyle(document.documentElement);
      const stroke = cs.getPropertyValue("--hl-stroke").trim() || "rgba(243,242,238,0.68)";
      const dim = cs.getPropertyValue("--hl-dim").trim() || "rgba(243,242,238,0.20)";
      const fill = cs.getPropertyValue("--plate").trim() || "#0E0E10";
      const acc = "#FF5722";

      plates.forEach((p, idx) => {
        const ax = p.hover ? p.tx : 0.5 + Math.sin(t * 0.7 + idx) * 0.28;
        const ay = p.hover ? p.ty : 0.5 + Math.cos(t * 0.58 + idx * 0.8) * 0.26;
        p.px += (ax - p.px) * 0.12;
        p.py += (ay - p.py) * 0.12;
        const ctx = p.ctx;
        const cx = p.w * 0.5;
        const cy = p.h * 0.54;
        ctx.clearRect(0, 0, p.w, p.h);

        if (p.id === "quorum") {
          const hub = iso(0, 0, 14, cx, cy);
          let best = 0;
          let bd = 9999;
          const ns: { sx: number; sy: number; pt: Pt }[] = [];
          for (let i = 0; i < 3; i++) {
            const a = (i / 3) * Math.PI * 2 - 0.52;
            const sx = Math.cos(a) * 62;
            const sy = Math.sin(a) * 62;
            const pt = iso(sx, sy, 0, cx, cy);
            const d = Math.hypot(pt.x - p.px * p.w, pt.y - p.py * p.h);
            if (d < bd) {
              bd = d;
              best = i;
            }
            ns.push({ sx, sy, pt });
          }
          ns.forEach((n, i) => {
            const act = i === best;
            ctx.beginPath();
            ctx.setLineDash(act ? [] : [3, 4]);
            ctx.strokeStyle = act ? acc : dim;
            ctx.lineWidth = act ? 1.4 : 0.9;
            ctx.moveTo(hub.x, hub.y);
            ctx.lineTo(n.pt.x, n.pt.y - (act ? 26 : 12));
            ctx.stroke();
            ctx.setLineDash([]);
            isoBox(ctx, cx, cy, n.sx - 12, n.sy - 12, 0, 24, 24, act ? 32 : 14, fill, act ? acc : stroke, act ? 1.2 : 0.9);
          });
          isoBox(ctx, cx, cy, -16, -16, 0, 32, 32, 18, fill, stroke, 1.05);
        } else if (p.id === "receipt") {
          const gap = 14 + p.px * 24;
          const hiL = Math.min(3, Math.max(0, Math.floor((1 - p.py) * 4)));
          for (let k = 0; k < 4; k++) {
            isoQuad(ctx, cx, cy + 16, -34, -34, (k - 1.5) * gap, 68, 68, fill, k === hiL ? acc : stroke, k === hiL ? 1.2 : 0.9);
          }
        } else if (p.id === "vault") {
          const rot = (p.px - 0.5) * 2.6 + t * 0.35;
          const ext = 10 + (1 - p.py) * 22;
          ctx.save();
          ctx.translate(cx, cy - 4);
          ctx.scale(1, 0.58);
          ctx.beginPath();
          ctx.arc(0, 0, 62, 0, Math.PI * 2);
          ctx.fillStyle = fill;
          ctx.fill();
          ctx.strokeStyle = stroke;
          ctx.lineWidth = 1.05;
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(0, 0, 40, 0, Math.PI * 2);
          ctx.strokeStyle = dim;
          ctx.stroke();
          for (let b = 0; b < 3; b++) {
            const ba = rot + (b * Math.PI * 2) / 3;
            ctx.beginPath();
            ctx.strokeStyle = b === 0 ? acc : stroke;
            ctx.lineWidth = 2.4;
            ctx.moveTo(Math.cos(ba) * 16, Math.sin(ba) * 16);
            ctx.lineTo(Math.cos(ba) * (42 + ext), Math.sin(ba) * (42 + ext));
            ctx.stroke();
          }
          ctx.beginPath();
          ctx.arc(0, 0, 8.5, 0, Math.PI * 2);
          ctx.fillStyle = acc;
          ctx.fill();
          ctx.restore();
        } else if (p.id === "cabinet") {
          const ar = Math.min(9, Math.max(0, Math.floor(p.py * 10)));
          for (let r = 0; r < 10; r++) {
            const dd = Math.abs(r - ar);
            const slide = dd === 0 ? 28 : dd === 1 ? 11 : 0;
            isoBox(ctx, cx, cy, -36 + slide, -24, (4.5 - r) * 10, 72, 48, 5, fill, dd === 0 ? acc : stroke, dd === 0 ? 1.2 : 0.85);
          }
        } else if (p.id === "terrain") {
          for (let gx = -2; gx <= 2; gx++) {
            for (let gy = -2; gy <= 2; gy++) {
              const d2 = Math.hypot((gx + 2) / 4 - p.px, (gy + 2) / 4 - p.py);
              const h = Math.max(5, 38 * Math.exp(-d2 * d2 * 5.2) + 4);
              isoBox(ctx, cx, cy + 12, gx * 19 - 7, gy * 19 - 7, 0, 14, 14, h, fill, d2 < 0.25 ? acc : stroke, d2 < 0.25 ? 1.15 : 0.8);
            }
          }
        } else if (p.id === "format") {
          const al = p.py;
          for (let f = 0; f < 10; f++) {
            const jit = Math.sin(f * 2.15) * 32 * (1 - al);
            const len = 42 + (f % 3) * 14 * (1 - al) + 26 * al;
            isoBox(ctx, cx, cy, -len * 0.5 + jit, -11, (4.5 - f) * 9.5, len, 20, 4.5, fill, al > 0.72 && f === 0 ? acc : stroke, 0.9);
          }
        } else if (p.id === "riffle") {
          const hi = Math.min(7, Math.max(0, Math.floor(p.px * 8)));
          for (let c = 0; c < 8; c++) {
            const dc = Math.abs(c - hi);
            const lift = dc === 0 ? 28 : dc === 1 ? 11 : 0;
            isoBox(ctx, cx, cy + 16, (c - 3.5) * 14 - 3, -28, lift, 6, 56, 38, fill, dc === 0 ? acc : stroke, dc === 0 ? 1.2 : 0.85);
          }
        } else if (p.id === "sieve") {
          const sp = 18 + p.py * 24;
          for (let sv = 0; sv < 3; sv++) {
            const zs = (sv - 1) * sp;
            isoQuad(ctx, cx, cy + 6, -38, -38, zs, 76, 76, fill, sv === 1 ? acc : stroke, sv === 1 ? 1.15 : 0.9);
            ctx.strokeStyle = sv === 1 ? "rgba(255,87,34,0.45)" : dim;
            ctx.lineWidth = 0.7;
            for (let g = -22; g <= 22; g += 15) {
              const a1 = iso(g, -38, zs, cx, cy + 6);
              const a2 = iso(g, 38, zs, cx, cy + 6);
              const b1 = iso(-38, g, zs, cx, cy + 6);
              const b2 = iso(38, g, zs, cx, cy + 6);
              ctx.beginPath();
              ctx.moveTo(a1.x, a1.y);
              ctx.lineTo(a2.x, a2.y);
              ctx.moveTo(b1.x, b1.y);
              ctx.lineTo(b2.x, b2.y);
              ctx.stroke();
            }
          }
        } else if (p.id === "settle") {
          const sn = p.hover ? 1 : 0.5 + 0.5 * Math.sin(t * 0.9);
          const cen = iso(0, 0, 12, cx, cy);
          for (let s = 0; s < 6; s++) {
            const an = (s / 6) * Math.PI * 2 + t * 0.5 * (1 - sn);
            const ox = Math.cos(an) * 60;
            const oy = Math.sin(an) * 60;
            const tx2 = ((s % 3) - 1) * 44;
            const ty2 = s < 3 ? -38 : 38;
            const fx = ox + (tx2 - ox) * sn;
            const fy = oy + (ty2 - oy) * sn;
            const pt2 = iso(fx, fy, 4, cx, cy);
            ctx.beginPath();
            ctx.strokeStyle = sn > 0.65 ? acc : dim;
            ctx.lineWidth = 0.9;
            ctx.moveTo(cen.x, cen.y);
            ctx.lineTo(pt2.x, pt2.y);
            ctx.stroke();
            isoBox(ctx, cx, cy, fx - 9, fy - 9, 0, 18, 18, 8, fill, stroke, 0.9);
          }
          isoBox(ctx, cx, cy, -13, -13, 6, 26, 26, 12, fill, acc, 1.2);
        }
      });
      raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    return () => {
      destroyed = true;
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resizeAll);
    };
  }, []);

  const counts: Record<string, number> = { accuracy: 3, reliability: 3, verification: 2, consumption: 1 };

  function toggleFilter(f: Plate["cat"]) {
    setFilter((cur) => (cur === f ? "all" : f));
  }

  return (
    <section id="guarantees" className="sec-pad">
      <div className="sec-top-row reveal">
        <div>
          <div className="kicker">// guarantees</div>
          <h2 className="sec-h2">
            Four pillars.
            <br />
            <span className="it">Nine guarantees.</span>
          </h2>
        </div>
        <p style={{ fontSize: 14.5, color: "var(--muted)", maxWidth: 390 }}>
          Zero-LLM determinism from ingestion to settlement. Hover any hairline schematic to inspect coordinates,
          quorum springs, and fail-closed gates.
        </p>
      </div>

      <div id="hl-filters" className="filter-bar">
        {(["accuracy", "reliability", "verification", "consumption"] as const).map((f) => (
          <button
            key={f}
            type="button"
            className={`f-tab${filter === f ? " active" : ""}`}
            onClick={() => toggleFilter(f)}
            aria-pressed={filter === f}
          >
            <span style={{ fontWeight: 500 }}>
              {f[0].toUpperCase() + f.slice(1)}{" "}
              <span className="mono" style={{ color: "var(--accent)", marginLeft: 4 }}>
                →
              </span>
            </span>
            <span className="mono" style={{ fontSize: 11.5 }}>
              {counts[f]}
            </span>
          </button>
        ))}
      </div>

      <div id="hl-grid" className="hl-grid" ref={gridRef}>
        {PLATES.map((p) => (
          <article
            key={p.id}
            className={`hl-card${filter !== "all" && p.cat !== filter ? " dimmed" : ""}`}
            data-cat={p.cat}
          >
            <div className="hl-plate" data-id={p.id}>
              <canvas />
              <div className="hl-hud">
                <div className="hl-hx" />
                <div className="hl-hy" />
                <div className="hl-pin" />
                <div className="hl-xy">x 000 · y 000</div>
                <div className="hl-hover-tag">{p.tag}</div>
              </div>
              <div className="hl-fig">{p.fig}</div>
            </div>
            <div className="hl-info">
              <div className="mono" style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginBottom: 7 }}>
                <span style={{ color: "var(--accent)" }}>{p.num}</span>
                <span style={{ color: "var(--muted)" }}>// {p.cat}</span>
              </div>
              <h3 style={{ fontSize: 16, fontWeight: 500, marginBottom: 6 }}>{p.title}</h3>
              <p style={{ fontSize: 13, color: "var(--muted)", lineHeight: 1.52 }}>{p.desc}</p>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
