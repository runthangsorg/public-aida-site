// Threads of light from Aida into a small structure of blocks. The paths
// span two laid-out elements, so their geometry is computed from the DOM
// (transform-immune offsets) and refreshed on resize; everything that moves
// along them is a CSS animation, so nothing here runs per frame.

/** Columns the threads land on, by layout: side by side, or her above the structure. */
const LANDING = { wide: [7, 5, 3], narrow: [7, 6, 5] };

interface Point {
  x: number;
  y: number;
}

/** Position of `el` inside `ancestor`, ignoring CSS transforms. */
function offsetWithin(el: HTMLElement, ancestor: HTMLElement): Point {
  let x = 0;
  let y = 0;
  let node: HTMLElement | null = el;
  while (node && node !== ancestor) {
    x += node.offsetLeft;
    y += node.offsetTop;
    node = node.offsetParent instanceof HTMLElement ? node.offsetParent : null;
  }
  return { x, y };
}

const f = (n: number): string => n.toFixed(1);

function bezier(a: Point, c1: Point, c2: Point, b: Point): string {
  return `M${f(a.x)} ${f(a.y)}C${f(c1.x)} ${f(c1.y)} ${f(c2.x)} ${f(c2.y)} ${f(b.x)} ${f(b.y)}`;
}

const children = (el: Element): HTMLElement[] =>
  Array.from(el.children).filter((c): c is HTMLElement => c instanceof HTMLElement);

/**
 * Sets each tile's lighting delay (`--d`) from its distance to the nearest
 * landing column and its depth below the top of its column, marks the tiles
 * the threads land on, and returns those landing tiles in thread order.
 */
export function prepareTiles(structure: HTMLElement, narrow: boolean): HTMLElement[] {
  const landingColumns = narrow ? LANDING.narrow : LANDING.wide;
  const columns = children(structure);
  const landing: HTMLElement[] = [];
  columns.forEach((column, c) => {
    const tiles = children(column);
    const nearest = Math.min(...landingColumns.map((lc) => Math.abs(lc - c)));
    tiles.forEach((tile, r) => {
      const fromTop = tiles.length - 1 - r;
      tile.classList.remove("is-landing");
      tile.style.setProperty("--d", `${(nearest * 55 + fromTop * 40).toString()}ms`);
    });
  });
  landingColumns.forEach((c, i) => {
    const top = columns[c]?.lastElementChild;
    if (top instanceof HTMLElement) {
      top.classList.add("is-landing");
      top.style.setProperty("--i", i.toString());
      landing.push(top);
    }
  });
  return landing;
}

export interface ThreadsMount {
  stage: HTMLElement;
  svg: SVGSVGElement;
  from: HTMLElement;
  structure: HTMLElement;
}

export function mountThreads(m: ThreadsMount): () => void {
  const paths = Array.from(m.svg.querySelectorAll<SVGPathElement>("path"));
  let mode: boolean | undefined;

  const update = (): void => {
    const w = m.stage.clientWidth;
    const h = m.stage.clientHeight;
    m.svg.setAttribute("viewBox", `0 0 ${w.toString()} ${h.toString()}`);

    const p = offsetWithin(m.from, m.stage);
    const pw = m.from.offsetWidth;
    const ph = m.from.offsetHeight;
    const s = offsetWithin(m.structure, m.stage);
    // Narrow layout: she sits above the structure, so the threads fall down
    // the right-hand margin rather than across the copy.
    const narrow = s.y >= p.y + ph - 1;

    // Read every position first, then write, so layout is never forced twice.
    const columns = children(m.structure);
    const ends: Point[] = (narrow ? LANDING.narrow : LANDING.wide).flatMap((c) => {
      const top = columns[c]?.lastElementChild;
      if (!(top instanceof HTMLElement)) return [];
      const t = offsetWithin(top, m.stage);
      return [{ x: t.x + top.offsetWidth / 2, y: t.y }];
    });
    if (narrow !== mode) {
      mode = narrow;
      prepareTiles(m.structure, narrow);
    }

    ends.forEach((end, i) => {
      let d: string;
      if (narrow) {
        const start: Point = { x: p.x + pw * (0.74 + i * 0.05), y: p.y + ph * (0.5 + i * 0.05) };
        const rail = w - 6 - i * 7;
        d = bezier(
          start,
          { x: rail, y: start.y + 90 },
          { x: rail - 30 - i * 12, y: end.y - 70 },
          end,
        );
      } else {
        // Fan out from her side, emerging from behind her hair.
        const start: Point = {
          x: p.x + pw * (0.32 - i * 0.04),
          y: p.y + ph * (0.5 + i * 0.07),
        };
        const dx = start.x - end.x;
        d = bezier(
          start,
          { x: start.x - dx * 0.4, y: start.y + 30 + i * 10 },
          { x: end.x + 120 + i * 40, y: end.y - 20 },
          end,
        );
      }
      for (const path of paths) {
        if (Number(path.dataset.thread) === i) path.setAttribute("d", d);
      }
    });
  };

  update();
  const observer = new ResizeObserver(update);
  observer.observe(m.stage);
  return () => {
    observer.disconnect();
  };
}
