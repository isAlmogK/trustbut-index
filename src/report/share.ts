import { Resvg } from '@resvg/resvg-js';

export function renderPng(svg: string): Buffer {
  return Buffer.from(new Resvg(svg, { fitTo: { mode: 'width', value: 1200 } }).render().asPng());
}
