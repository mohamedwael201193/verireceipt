// Transport normalization only, never a tolerance or raw numeric fallback.
// A decimal string and a finite JSON number may represent exactly the same
// rational value. Exponent notation, whitespace and nonfinite values fail.
export function exactNumericEqual(a:unknown,b:unknown):boolean {
 const parse=(x:unknown)=>{
  if(typeof x!=='string'&&typeof x!=='number')return null;
  if(typeof x==='number'&&!Number.isFinite(x))return null;
  const s=String(x);if(s.length>120||! /^-?(0|[1-9]\d*)(\.\d+)?$/.test(s))return null;
  const [whole,fraction='']=s.split('.');return {n:BigInt(whole+fraction),d:10n**BigInt(fraction.length)};
 };
 const x=parse(a),y=parse(b);return !!x&&!!y&&x.n*y.d===y.n*x.d;
}
