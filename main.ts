// RIDE-AND-DIP — bot trading cbBTC/USDC di replay 1-menit (agent-fun/bars-replay/v1).
//
// Cara kerja protokol: harness mengirim satu baris `hello` sekali, lalu satu `batch`
// JSON per menit (satu bar CBBTC + fills dari orders sebelumnya + account), lalu `done`.
// Bot menjawab setiap `batch` dengan tepat satu reply yang meng-echo `seq`-nya dan
// membawa `orders` yang diputuskan atas bar itu. Order yang diputuskan pada batch
// bar k terisi di OPEN bar k+1, jadi semua keputusan di sini memakai close bar yang
// baru saja tutup dan riwayat close sebelumnya — tidak pernah memakai harga masa depan.
//
// Strategi (dirancang dari nol untuk data 1-menit ini, bukan moving-average polos):
// data 1-menit cbBTC bergerak dalam rentang yang sempit (pergerakan tipikal hanya
// ~5 bps/menit) sementara satu round trip makan ~30 bps fee+slippage+impact, jadi
// scalping tiap menit pasti kalah oleh biaya. Edge yang diambil ada dua, keduanya
// jarang dan sabar:
//
//  1. TREND RIDER (mode utama): masuk long penuh hanya saat rezim naik terkonfirmasi
//     DUA lapis — SMA-60 di atas SMA-120 dengan band histeresis 10 bps DAN close
//     menembus high 20 bar terakhir (Donchian breakout). Keluar hanya saat rezim
//     berbalik (SMA-60 jatuh di bawah SMA-120 dikurangi band) atau trailing stop
//     250 bps dari peak. Setelah keluar, ada cooldown 240 bar sebelum boleh masuk
//     lagi: ini yang mencegah whipsaw di fase sideways, tempat sebagian besar bot
//     trend-following kehabisan uang karena bolak-balik.
//  2. OVERSOLD SCALP (mode asuransi, hanya saat TIDAK uptrend): beli setengah posisi
//     saat harga jatuh sangat jauh di bawah mean 60 bar (z-score < -2,5 DAN deviasi
//     < -50 bps — dua syarat sekaligus, supaya noise saat volatilitas rendah tidak
//     memicu entry), keluar cepat di TP +40 / SL -40 bps, saat z-score kembali ke 0,
//     atau setelah 180 bar. Mode ini menjaga bot tetap punya >= 1 trade dan tetap
//     bisa menangkap pantulan bila jendela race ternyata turun terus.
//
// Ukuran posisi dibatasi juga oleh depth pool (c_depth close terakhir): notional
// dipangkas supaya price impact sendiri tetap <= ~20 bps.
//
// Deterministik penuh: tidak ada Math.random, tidak ada jam dinding, tidak ada file
// di luar repo; semua state berasal dari hello/batch yang diterima. Seed dari hello
// tidak dipakai karena strategi tidak butuh acak sama sekali.

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch, OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// --- parameter strategi (dikalibrasi di dev window 1440 bar, lalu diuji juga pada
// --- seri harga yang dibalik dan pada paruh sideways saja agar tidak overfit) ---
const FAST_W = 60; // jendela SMA cepat (menit)
const SLOW_W = 120; // jendela SMA lambat (menit)
const BAND_BPS = 10; // band histeresis rezim, dalam bps
const BREAKOUT_N = 20; // Donchian: close harus di atas high N bar terakhir
const TRAIL_BPS = 250; // trailing stop dari peak sejak entry, dalam bps
const COOLDOWN_BARS = 240; // jeda setelah keluar sebelum boleh masuk lagi
const SCALP_Z = -2.5; // z-score entry scalp (vs mean FAST_W)
const SCALP_DEV_BPS = -50; // deviasi harga dari mean FAST_W, dalam bps
const SCALP_TP_BPS = 40;
const SCALP_SL_BPS = -40;
const SCALP_SIZE_PCT = 50; // persen kas untuk scalp
const SCALP_MAX_HOLD = 180; // bar
const MAX_SLIPPAGE_BPS = 300; // batas gerak open berikut vs close terakhir
const MAX_IMPACT_BPS = 20; // batas impact sendiri, dari depth close terakhir
const MIN_NOTIONAL = 1_000_000n; // 1 USDC, dalam quote units

// --- helper indikator (angka polos; semua operasi deterministik, tanpa acak) ---
function meanOf(xs: readonly number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

function sdOf(xs: readonly number[], m: number): number {
  let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return Math.sqrt(s / xs.length);
}

function maxOf(xs: readonly number[]): number {
  let m = -Infinity;
  for (const x of xs) if (x > m) m = x;
  return m;
}

// --- state strategi (hanya dari batch yang diterima, tidak ada sumber lain) ---
type Mode = 'trend' | 'scalp';
let hist: number[] = []; // close-close bar sebelumnya, dalam raw price units
let mode: Mode | null = null; // mode posisi yang sedang dipegang
let entryPrice = 0; // harga fill saat posisi dibuka (raw price units)
let peakPrice = 0; // close tertinggi sejak entry (raw price units)
let entrySeq = -1; // seq batch saat fill buy dilaporkan
let lastExitSeq = -1; // seq batch saat fill sell dilaporkan
let pendingMode: Mode | null = null; // mode buy yang menunggu fill di batch berikut

// Notional beli terbesar yang impact-nya tetap di bawah batas, dari depth close
// terakhir (state.depthAt): impact ~= notional / depth, jadi cap = depth * batas.
function depthCap(state: BarsState): bigint {
  const depth = state.depthAt(SYMBOL);
  if (depth === null || depth.length === 0 || depth[0] === 0n) return 0n;
  return (depth[0] * BigInt(MAX_IMPACT_BPS)) / 10_000n;
}

function buySize(state: BarsState, pct: number): bigint {
  let size = (state.cash * BigInt(pct)) / 100n;
  const room = state.weightRoom(SYMBOL);
  if (size > room) size = room;
  const cap = depthCap(state);
  if (cap > 0n && size > cap) size = cap;
  return size;
}

function onBatch(state: BarsState, batch: Batch): OrderInput[] {
  // Lipat fills dari batch ini dulu: harga entry dan waktu keluar yang sebenarnya
  // hanya diketahui dari fill, bukan dari keputusan.
  for (const f of batch.fills) {
    if (f.symbol !== SYMBOL || f.status !== 'filled') continue;
    if (f.side === 'buy') {
      // Fill buy: mode-nya adalah mode yang sedang menunggu; bila tidak ada yang
      // menunggu (seharusnya tak terjadi), adopsi sebagai trend agar posisi yang
      // sudah terlanjur dipegang tetap punya aturan keluar yang jelas.
      mode = pendingMode ?? 'trend';
      pendingMode = null;
      entryPrice = Number(BigInt(f.price));
      peakPrice = entryPrice;
      entrySeq = state.seq;
    } else if (f.side === 'sell') {
      mode = null;
      lastExitSeq = state.seq;
    }
  }

  const bar = batch.bars.find((b) => b.symbol === SYMBOL);
  if (bar === undefined) return []; // CBBTC absen di menit ini: jangan putuskan apa-apa
  const c = Number(BigInt(bar.c));

  // Selama warmup (bila ada) hanya bangun riwayat, tidak pernah order.
  if (state.warmingUp) {
    hist.push(c);
    return [];
  }

  // Butuh SLOW_W close sebelumnya sebelum indikator pertama bisa dihitung.
  if (hist.length < SLOW_W) {
    hist.push(c);
    return [];
  }

  const fast = meanOf(hist.slice(-FAST_W));
  const slow = meanOf(hist.slice(-SLOW_W));
  const up = fast > slow * (1 + BAND_BPS / 10_000);
  const down = fast < slow * (1 - BAND_BPS / 10_000);
  const pos = state.positions.get(SYMBOL);
  const qty = pos === undefined ? 0n : pos.qty;

  // Pengaman: posisi yang dipegang tanpa mode yang diketahui (misalnya fill buy
  // yang lolos dari pencatatan) diadopsi sebagai trend di close saat ini, supaya
  // aturan keluar tetap jalan dan entryPrice tidak pernah 0.
  if (qty > 0n && mode === null) {
    mode = 'trend';
    entryPrice = c;
    peakPrice = c;
    entrySeq = state.seq;
  }

  let orders: OrderInput[] = [];

  if (qty > 0n && mode !== null) {
    // --- sedang memegang posisi: cek aturan keluar atas close bar ini ---
    if (c > peakPrice) peakPrice = c;
    const retBps = ((c / entryPrice) - 1) * 10_000;
    const dropBps = ((peakPrice / c) - 1) * 10_000;
    if (mode === 'trend') {
      // Keluar hanya bila rezim benar-benar berbalik atau trailing stop kena.
      if (down || dropBps >= TRAIL_BPS) {
        orders = [{ side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
    } else {
      // Scalp: keluar cepat — TP/SL, reversion ke mean, atau batas waktu pegang.
      const z = (c - fast) / (sdOf(hist.slice(-FAST_W), fast) || 1);
      if (retBps >= SCALP_TP_BPS || retBps <= SCALP_SL_BPS || z > 0 || state.seq - entrySeq >= SCALP_MAX_HOLD) {
        orders = [{ side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
    }
  } else if (qty === 0n) {
    // --- sedang flat: cek aturan masuk, dengan cooldown pasca-keluar ---
    const cooled = lastExitSeq < 0 || state.seq - lastExitSeq >= COOLDOWN_BARS;
    if (cooled) {
      if (up) {
        // Trend rider: breakout di atas high 20 bar terakhir, saat rezim naik.
        const high = maxOf(hist.slice(-BREAKOUT_N));
        if (c > high) {
          const size = buySize(state, 100);
          if (size >= MIN_NOTIONAL) {
            pendingMode = 'trend';
            orders = [{ side: 'buy', symbol: SYMBOL, notional_quote_units: size, max_slippage_bps: MAX_SLIPPAGE_BPS }];
          }
        }
      } else {
        // Oversold scalp: hanya saat tidak uptrend, dan deviasi harus besar dalam
        // dua ukuran sekaligus (z-score dan bps absolut).
        const sd = sdOf(hist.slice(-FAST_W), fast);
        const z = (c - fast) / (sd || 1);
        const devBps = ((c / fast) - 1) * 10_000;
        if (z < SCALP_Z && devBps < SCALP_DEV_BPS) {
          const size = buySize(state, SCALP_SIZE_PCT);
          if (size >= MIN_NOTIONAL) {
            pendingMode = 'scalp';
            orders = [{ side: 'buy', symbol: SYMBOL, notional_quote_units: size, max_slippage_bps: MAX_SLIPPAGE_BPS }];
          }
        }
      }
    }
  }

  hist.push(c);
  if (hist.length > 2 * SLOW_W) hist.splice(0, hist.length - 2 * SLOW_W);
  return orders;
}

// --- jalankan protokol: shim yang memiliki wire (stdin/stdout NDJSON), satu reply
// --- per batch dengan seq yang sama, dan state (cash, posisi, close, depth) yang
// --- selalu mutakhir sebelum onBatch dipanggil. Posisi yang masih dipegang saat
// --- `done` dijual otomatis oleh harness di close terakhir (flatten).
await runBars({ onBatch });
