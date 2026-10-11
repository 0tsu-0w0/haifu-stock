// グラフを画像(PNG)として保存する(F-1109)。グラフの SVG に、画面で効いている色や文字の指定を書き込んでから、
// 見出しと凡例を添えて画像にする。スマホでは共有の画面(「画像を保存」を選べる)を使う

const STYLE_PROPS = [
  'fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-dasharray', 'stroke-linecap', 'stroke-linejoin', 'stroke-opacity',
  'opacity', 'font-size', 'font-family', 'font-weight', 'text-anchor', 'dominant-baseline', 'visibility', 'display',
];
const SCALE = 3;

function inlineStyles(src: Element, dst: Element) {
  const cs = getComputedStyle(src);
  dst.setAttribute('style', STYLE_PROPS.map((p) => `${p}:${cs.getPropertyValue(p)}`).join(';'));
  const a = src.children, b = dst.children;
  for (let i = 0; i < a.length; i++) inlineStyles(a[i], b[i]);
}

async function toBlob(figure: HTMLElement): Promise<Blob> {
  // グラフ本体(見出しのボタンのアイコンも svg なので、role で見分ける)
  const svg = figure.querySelector<SVGSVGElement>('svg[role="img"]');
  if (!svg) throw new Error('グラフが見つかりません');
  const clone = svg.cloneNode(true) as SVGSVGElement;
  inlineStyles(svg, clone);
  const vb = svg.viewBox.baseVal;
  const w = vb.width, h = vb.height;
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('width', String(w * SCALE));
  clone.setAttribute('height', String(h * SCALE));
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(clone))}`;
  await img.decode();

  const root = getComputedStyle(document.documentElement);
  const color = (v: string, fallback: string) => root.getPropertyValue(v).trim() || fallback;
  const title = figure.querySelector('.chart-title')?.textContent ?? '';
  const legend = [...figure.querySelectorAll('.legend > span')].map((el) => ({
    label: el.textContent ?? '',
    color: getComputedStyle(el.querySelector('i') ?? el).backgroundColor,
  }));
  const pad = 14 * SCALE;
  const head = (title ? 26 : 0) * SCALE + (legend.length ? 20 : 0) * SCALE;
  const canvas = document.createElement('canvas');
  canvas.width = w * SCALE + pad * 2;
  canvas.height = h * SCALE + head + pad * 2;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('画像を作れませんでした');
  ctx.fillStyle = color('--surface', '#fff');
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const font = getComputedStyle(document.body).fontFamily;
  let y = pad;
  if (title) {
    ctx.fillStyle = color('--ink', '#000');
    ctx.font = `700 ${15 * SCALE}px ${font}`;
    ctx.textBaseline = 'top';
    ctx.fillText(title, pad, y);
    y += 26 * SCALE;
  }
  if (legend.length) {
    let x = pad;
    ctx.font = `${12 * SCALE}px ${font}`;
    ctx.textBaseline = 'middle';
    for (const l of legend) {
      ctx.fillStyle = l.color;
      ctx.fillRect(x, y + 8 * SCALE, 16 * SCALE, 3 * SCALE);
      x += 22 * SCALE;
      ctx.fillStyle = color('--ink-2', '#555');
      ctx.fillText(l.label, x, y + 9 * SCALE);
      x += ctx.measureText(l.label).width + 14 * SCALE;
    }
    y += 20 * SCALE;
  }
  ctx.drawImage(img, pad, y);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('画像を作れませんでした'))), 'image/png'));
}

/** グラフを PNG にして保存する。共有できる端末(スマホ)では共有の画面を開く */
export async function saveChartImage(figure: HTMLElement, filename: string): Promise<'shared' | 'downloaded'> {
  const blob = await toBlob(figure);
  const file = new File([blob], filename, { type: 'image/png' });
  const touch = window.matchMedia('(pointer: coarse)').matches;
  if (touch && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: filename });
      return 'shared';
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return 'shared';
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return 'downloaded';
}
