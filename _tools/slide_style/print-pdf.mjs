// htmlslide-craft version: 27
// Usage: node print-pdf.mjs <入力.html> <出力.pdf> [必須フォントの接頭辞]
//   例) node print-pdf.mjs deck.html deck.pdf            → NotoSansJP を必須とする(既定)
//       node print-pdf.mjs doc.html  doc.pdf   IBMPlex   → IBMPlex を必須とする
//
// なぜ素の `--print-to-pdf` を使わないか:
//   (1) Webフォントのダウンロード完了を待たずに印字するため、フォントが載らないまま
//       出力されることがある(実測: 素の方式は4回中3回で webfont が埋め込まれなかった)。
//       本スクリプトは document.fonts.ready を実際に await してから印字する。
//   (2) 素の `--print-to-pdf` は PDF を書き出した後もプロセスが終了しない(実測: 書き出しは
//       6秒で完了するのに45秒後も生存)。エージェント運用ではセッションが止まる。
//       本スクリプトは CDP 経由で印字し、finally で必ず Chrome を kill する。
//
// 検証の考え方: 「想定外のフォントが無いこと」ではなく「**載せたい Webフォントが実際に
//   埋め込まれたこと**」を確認する。CJK をローカルフォント(ヒラギノ等)に落とす設計の
//   ドキュメントでも誤検知しないため。
// 追加パッケージのインストールは不要(Node組込みの fetch/WebSocket/zlib のみで動く)。
import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { inflateSync } from 'node:zlib';

const [, , inputPath, outputPath, requiredFontArg] = process.argv;
if (!inputPath || !outputPath) {
  console.error('Usage: node print-pdf.mjs <入力.html> <出力.pdf> [必須フォントの接頭辞]');
  process.exit(1);
}
const REQUIRED_FONT = requiredFontArg || 'NotoSansJP';
const fileUrl = 'file://' + resolve(inputPath);
const PORT = 9600 + Math.floor(Math.random() * 400);
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  // '--headless'(旧モード)はChrome 151等の新しいバージョンでCDPデバッグポートを
  // 開かないことが実測で確認された(プロセスは起動するがポートがConnection Refusedのまま)。
  // '--headless=new'を明示する。
  '--headless=new', '--disable-gpu', `--remote-debugging-port=${PORT}`,
  '--window-size=1280,900', '--hide-scrollbars', '--user-data-dir=/tmp/pdf-print-profile-' + PORT
], { stdio: 'ignore' });

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

// 固定 sleep での待ち合わせは起動が遅れた回に失敗する(実測で複数回 ECONNREFUSED)。
// デバッグポートが開くまでポーリングする。
async function waitForPort(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return;
    } catch (e) { lastErr = e; }
    await wait(250);
  }
  throw new Error(`CDP port ${port} が ${timeoutMs}ms 以内に開きませんでした: ${lastErr}`);
}

// 出力PDFに実際に埋め込まれたフォント名を抽出する。PDFのフォント名は
// 圧縮されていないオブジェクト辞書(/BaseFont 等)にそのまま出ることが多いが、
// コンテンツストリームが FlateDecode で圧縮されている場合もあるため両方を見る。
function extractEmbeddedFontNames(pdfBytes) {
  const found = new Set();
  const pattern = /NotoSansJP[A-Za-z]*|IBMPlex[A-Za-z]*|Hiragino[A-Za-z]*|Hira[A-Za-z]*|Times[A-Za-z]*|Helvetica[A-Za-z]*|Arial[A-Za-z]*/g;
  const scan = (buf) => {
    for (const m of buf.toString('latin1').matchAll(pattern)) found.add(m[0]);
  };
  scan(pdfBytes);
  const streamRe = /stream\r?\n([\s\S]*?)endstream/g;
  let m;
  while ((m = streamRe.exec(pdfBytes.toString('latin1'))) !== null) {
    try {
      scan(inflateSync(Buffer.from(m[1], 'latin1')));
    } catch {
      // 非圧縮 or 非FlateDecodeのストリームはスキップ(画像等)
    }
  }
  return [...found];
}

// document.fonts.ready 待ちが実際に効いたかは、PDFの中身を見るまで確定しない。
// 必須フォントが1つも埋め込まれていなければ、待ちが効かず Webフォント無しで
// 印字された(=画面と別物の見た目)ため、成功として扱わない。
function verifyEmbeddedFonts(outputPath) {
  const names = extractEmbeddedFontNames(readFileSync(outputPath));
  console.log('embedded fonts:', names.length ? names : 'NONE');
  const hasRequired = names.some(n => n.startsWith(REQUIRED_FONT));
  if (!hasRequired) {
    console.error(`NG: 必須フォント ${REQUIRED_FONT} が埋め込まれていません`,
      '(document.fonts.ready 待ちが効かず Webフォント未取得のまま印字された可能性。再実行してください)');
    process.exitCode = 1;
  }
}
function send(ws, method, params = {}) {
  return new Promise((resolve) => {
    const id = Math.floor(Math.random() * 1e9);
    const handler = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id === id) { ws.removeEventListener('message', handler); resolve(msg); }
    };
    ws.addEventListener('message', handler);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

// CDP イベント(id を持たない通知)を待つ。
function once(ws, eventName, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener('message', handler);
      reject(new Error(`${eventName} が ${timeoutMs}ms 以内に来ませんでした`));
    }, timeoutMs);
    const handler = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.method === eventName) {
        clearTimeout(timer);
        ws.removeEventListener('message', handler);
        resolve(msg);
      }
    };
    ws.addEventListener('message', handler);
  });
}

try {
  await waitForPort(PORT);
  // about:blank でタブを作り、Page.navigate + loadEventFired で遷移完了を確実に待つ。
  // `/json/new?<url>` で URL を渡すと、遷移が始まる前に評価が走り得る
  // (about:blank の readyState が既に 'complete' なので待ちが素通りし、
  //  @font-face が1つも登録されていない状態で印字してしまう。実測 0/0 fonts)。
  const listResp = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' });
  const target = await listResp.json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  await send(ws, 'Page.enable');
  const loaded = once(ws, 'Page.loadEventFired');
  await send(ws, 'Page.navigate', { url: fileUrl });
  await loaded;

  // ここが肝: フォントが「実際に読み込まれた」状態にしてから印字する。
  // document.fonts.ready だけでは足りない——ready は *その時点で保留中* の読み込みしか
  // 待たないので、レイアウト前でフォント要求がまだ発火していないと即 resolve してしまう
  // (実測: ready だけの版は docs で4回中2回・slides で2回中1回、Webフォント無しで印字された)。
  // 登録済み @font-face を明示的に load() して要求を強制し、そのうえで ready を待つ。
  const fontWait = await send(ws, 'Runtime.evaluate', {
    awaitPromise: true, returnByValue: true,
    expression: `(async () => {
      if (document.readyState !== 'complete') {
        await new Promise(r => window.addEventListener('load', r, { once: true }));
      }
      const faces = [...document.fonts];
      await Promise.all(faces.map(f => f.status === 'loaded' ? null : f.load().catch(() => null)));
      await document.fonts.ready;
      const loaded = [...document.fonts].filter(f => f.status === 'loaded');
      return { total: faces.length, loaded: loaded.length,
               families: [...new Set(loaded.map(f => f.family))] };
    })()`
  });
  const fw = fontWait.result?.result?.value;
  if (fw) console.log(`fonts loaded: ${fw.loaded}/${fw.total}`, fw.families);

  const pdfResult = await send(ws, 'Page.printToPDF', { printBackground: true, preferCSSPageSize: true });
  writeFileSync(outputPath, Buffer.from(pdfResult.result.data, 'base64'));
  console.log('written:', outputPath);
  verifyEmbeddedFonts(outputPath);
  ws.close();
} finally {
  chrome.kill();
}
