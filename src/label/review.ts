import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { appendJsonl, readJsonOr, readJsonl } from '../jsonl.js';
import { LABELS, type Label } from '../types.js';
import type { Draft } from './draft.js';
import type { SampleItem } from './sample.js';

export interface FinalLabel {
  key: string;
  label: Label;
  note: string;
  draftLabel: Label | null;
  blind: boolean;
  labeledAt: string;
}

export const packetFile = (key: string) => `${key.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`;

export function nextItem(sample: SampleItem[], finals: FinalLabel[]): SampleItem | null {
  const done = new Set(finals.map((f) => f.key));
  return [...sample].sort((a, b) => a.order - b.order).find((s) => !done.has(s.key)) ?? null;
}

async function body(req: IncomingMessage): Promise<string> {
  let s = '';
  for await (const chunk of req) s += chunk;
  return s;
}

export async function startReview(dir: string, port = 4317): Promise<{ url: string; close: () => Promise<void> }> {
  const sample = await readJsonl<SampleItem>(join(dir, 'sample.jsonl'));
  const drafts = new Map((await readJsonl<Draft>(join(dir, 'drafts.jsonl'))).map((d) => [d.key, d]));
  const finalsPath = join(dir, 'final.jsonl');

  const server = createServer(async (req, res) => {
    const send = (status: number, type: string, payload: string) => {
      res.writeHead(status, { 'content-type': type });
      res.end(payload);
    };
    try {
      if (req.method === 'GET' && req.url === '/') return send(200, 'text/html; charset=utf-8', REVIEW_PAGE);
      if (req.method === 'GET' && req.url === '/api/next') {
        const finals = await readJsonl<FinalLabel>(finalsPath);
        const item = nextItem(sample, finals);
        if (!item) return send(200, 'application/json', JSON.stringify({ done: true, progress: { done: finals.length, total: sample.length } }));
        const packet = await readJsonOr(join(dir, 'packets', packetFile(item.key)), null);
        const draft = item.blind ? null : (drafts.get(item.key) ?? null);
        const { key, family, finding, order, blind } = item;
        return send(200, 'application/json', JSON.stringify({ item: { key, family, finding, order, blind }, packet, draft, progress: { done: finals.length, total: sample.length } }));
      }
      if (req.method === 'POST' && req.url === '/api/label') {
        const j = JSON.parse(await body(req)) as { key?: string; label?: string; note?: string };
        const item = sample.find((s) => s.key === j.key);
        if (!item || !LABELS.includes(j.label as Label)) return send(400, 'application/json', '{"error":"bad key or label"}');
        const final: FinalLabel = {
          key: item.key, label: j.label as Label, note: j.note ?? '', draftLabel: drafts.get(item.key)?.label ?? null,
          blind: item.blind, labeledAt: new Date().toISOString(),
        };
        await appendJsonl(finalsPath, final);
        return send(200, 'application/json', '{"ok":true}');
      }
      send(404, 'text/plain', 'not found');
    } catch (e) {
      send(500, 'text/plain', String(e));
    }
  });
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
  const { port: actual } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${actual}`, close: () => new Promise((r) => server.close(() => r())) };
}

export const REVIEW_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>trustbut-index review</title>
<style>
:root{--bg:#fff;--fg:#1a1a1a;--muted:#666;--line:#ddd;--code:#f6f6f6;--accent:#2457d6}
@media (prefers-color-scheme:dark){:root{--bg:#141414;--fg:#eee;--muted:#aaa;--line:#333;--code:#1e1e1e;--accent:#7ea2ff}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
main{max-width:980px;margin:0 auto;padding:16px}
pre{background:var(--code);padding:12px;overflow:auto;border-radius:6px;font-size:13px}
.bar{display:flex;gap:8px;flex-wrap:wrap;position:sticky;bottom:0;background:var(--bg);padding:12px 0;border-top:1px solid var(--line)}
button{font:inherit;padding:8px 14px;border-radius:6px;border:1px solid var(--line);background:var(--code);color:var(--fg);cursor:pointer}
button.draft{outline:2px solid var(--accent)}
textarea{width:100%;min-height:48px;font:inherit;background:var(--code);color:var(--fg);border:1px solid var(--line)}
.muted{color:var(--muted)}
</style></head><body><main>
<p class="muted" id="progress"></p><div id="item"></div>
<div class="bar" id="bar"></div></main>
<script>
const LABELS=['real','true-but-benign','false','unclear'];
const esc=(s)=>String(s??'').replace(/[&<>]/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
async function load(){
  const r=await (await fetch('/api/next')).json();
  document.getElementById('progress').textContent=r.progress.done+' / '+r.progress.total+' labeled';
  const bar=document.getElementById('bar');
  if(r.done){document.getElementById('item').innerHTML='<h1>All findings labeled.</h1>';bar.innerHTML='';return;}
  const p=r.packet||{};const d=r.draft;
  document.getElementById('item').innerHTML=
    '<h1>'+esc(r.item.family)+': '+esc(p.finding?.title??r.item.finding.title)+'</h1>'+
    '<p class="muted">'+(r.item.blind?'Blind calibration item: no draft shown.':d?('Draft: <b>'+esc(d.label)+'</b> ('+esc(d.confidence)+'). '+esc(d.rationale)):'No draft for this item.')+'</p>'+
    '<h2>Finding</h2><pre>'+esc(JSON.stringify(p.finding,null,2))+'</pre>'+
    '<h2>Before and after</h2><pre>'+esc(p.baseRun)+'</pre>'+
    '<h2>PR</h2><pre>'+esc(p.pr?.title)+'\\n\\n'+esc(p.pr?.body)+'</pre>'+
    (p.diff||[]).map((x)=>'<h3>'+esc(x.file)+'</h3><pre>'+esc(x.patch)+'</pre>').join('')+
    (p.testSource?'<h2>'+esc(p.testSource.file)+' from line '+p.testSource.startLine+'</h2><pre>'+esc(p.testSource.text)+'</pre>':'')+
    '<h2>Note (optional)</h2><textarea id="note"></textarea>';
  bar.innerHTML=LABELS.map((l)=>'<button data-l="'+l+'" class="'+(d&&d.label===l?'draft':'')+'">'+l+'</button>').join('');
  bar.querySelectorAll('button').forEach((b)=>b.onclick=async()=>{
    await fetch('/api/label',{method:'POST',body:JSON.stringify({key:r.item.key,label:b.dataset.l,note:document.getElementById('note').value})});
    window.scrollTo(0,0);load();
  });
}
load();
</script></body></html>`;
