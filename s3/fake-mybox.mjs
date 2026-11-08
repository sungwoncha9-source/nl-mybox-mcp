// S3 시험 전용 가짜 MYBOX (실제 MYBOX와 무관). 127.0.0.1에만 묶인다. 제어 문 /__ctl/* 로 폴더 이동·집계.
import http from 'node:http'; import crypto from 'node:crypto';
export function startFake() {
  const T = { ROOT: null, OUT: 'ROOT', ALLOW: 'ROOT', SUB: 'ALLOW', MOVER: 'OUT', D1: 'ALLOW', D2: 'D1', D3: 'D2', D4: 'D3', D5: 'D4' };
  const files = {}; const st = { uploads: 0, posts: 0, resGets: 0, listGets: 0, arm: null, readsOf: {} };
  const srv = http.createServer((req, res) => { const ch = []; req.on('data', d => ch.push(d)); req.on('end', () => {
    const body = Buffer.concat(ch); const u = new URL(req.url, 'http://x'); const json = (o, s = 200) => { res.statusCode = s; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); }; let m;
    if (u.pathname.startsWith('/__ctl/')) {
      const b = body.length ? JSON.parse(body) : {};
      if (u.pathname === '/__ctl/move') { T[b.id] = b.parent; return json({ ok: true }); }
      if (u.pathname === '/__ctl/arm') { st.arm = b.id ? { id: b.id, parent: b.parent, after: b.after || 1, seen: 0 } : null; return json({ ok: true }); }
      if (u.pathname === '/__ctl/stats') return json({ uploads: st.uploads, posts: st.posts, resGets: st.resGets, listGets: st.listGets, files: Object.keys(files).length, readsOf: st.readsOf, tree: T });
      if (u.pathname === '/__ctl/reset') { st.uploads = st.posts = st.resGets = st.listGets = 0; st.readsOf = {}; st.arm = null; for (const k of Object.keys(files)) { delete files[k]; delete T[k]; } for (const k of Object.keys(T)) if (/^(NEW|UP)/.test(k)) delete T[k]; Object.assign(T, { OUT: 'ROOT', ALLOW: 'ROOT', SUB: 'ALLOW', MOVER: 'OUT' }); return json({ ok: true }); }
      return json({ e: 'nf' }, 404);
    }
    if (req.method === 'GET' && (m = u.pathname.match(/^\/v1\/drive\/resources\/([^/]+)$/))) { const id = decodeURIComponent(m[1]); st.resGets++; st.readsOf[id] = (st.readsOf[id] || 0) + 1; if (!(id in T)) return json({ e: 'nf' }, 404); const out = { resourceId: id, parentId: T[id] };
      if (st.arm && st.arm.id === id && ++st.arm.seen === st.arm.after) { T[id] = st.arm.parent; st.arm = null; } return json(out); }
    if (req.method === 'GET' && (m = u.pathname.match(/^\/v1\/drive\/folders\/([^/]+)\/resources$/))) { st.listGets++; return json({ resources: Object.keys(T).filter(k => T[k] === m[1]).map(k => ({ resourceId: k, name: files[k]?.name || k, size: files[k]?.size })), responseMetaData: {} }); }
    if (req.method === 'POST') st.posts++;
    if (req.method === 'POST' && u.pathname === '/v1/drive/folders') { const b = JSON.parse(body); const id = 'NEW' + crypto.randomUUID().slice(0, 6); T[id] = b.parentId; return json({ resourceId: id }); }
    if (req.method === 'POST' && u.pathname === '/v1/drive/files') { const b = JSON.parse(body); const id = 'UP' + crypto.randomUUID().slice(0, 6); files[id] = { name: b.fileName, parent: b.parentId }; return json({ uploadUrl: 'http://127.0.0.1:' + srv.address().port + '/upload/' + id }); }
    if (req.method === 'POST' && u.pathname.startsWith('/upload/')) { const id = u.pathname.split('/')[2]; if (!files[id]) return json({ e: 'nf' }, 404); st.uploads++; const s = body.indexOf('\r\n\r\n') + 4, e = body.lastIndexOf('\r\n--'); files[id].size = e - s; T[id] = files[id].parent; res.end('ok'); return; }
    if (req.method === 'POST' && (m = u.pathname.match(/^\/v1\/drive\/resources\/([^/]+)\/(copy|move)$/))) { const b = JSON.parse(body); if (m[2] === 'move') T[m[1]] = b.parentId; else T[m[1] + '_c' + crypto.randomUUID().slice(0, 4)] = b.parentId; return json({ ok: true, resourceId: m[1] }); }
    json({ e: 'nf ' + u.pathname }, 404);
  }); });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ srv, port: srv.address().port })));
}
