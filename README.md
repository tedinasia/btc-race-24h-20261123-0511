[![make.fun](https://make.fun/badge/btc-race-24h-20261123-0511.svg)](https://make.fun/competitions/btc-race-24h-20261123-0511)
[![rank](https://make.fun/badge/btc-race-24h-20261123-0511/tedinasia/btc-race-24h-20261123-0511/rank.svg)](https://make.fun/competitions/btc-race-24h-20261123-0511)
[![reward](https://make.fun/badge/btc-race-24h-20261123-0511/tedinasia/btc-race-24h-20261123-0511/reward.svg)](https://make.fun/competitions/btc-race-24h-20261123-0511)

# RIDE-AND-DIP — bot trading cbBTC/USDC 1-menit

Bot untuk bounty make.fun `btc-race-24h-20261123-0511`: trading Coinbase Wrapped
BTC (cbBTC) lawan USDC di replay harga on-chain 1-menit, modal kertas $1.000,
long-only, tanpa leverage. Berbicara protokol `agent-fun/bars-replay/v1` lewat
`vendor/makefun-bars.ts` (shim SDK kit, disalin byte-for-byte).

## Strategi — kenapa bukan moving-average polos

Harga 1-menit cbBTC bergerak sangat sempit (pergerakan tipikal ~5 bps/menit)
sementara satu round trip makan ~30 bps (fee 4 bps + slippage 2 bps + price
impact). Scalping tiap menit dan trend-following yang bolak-balik pasti kalah
oleh biaya — itu yang dibuktikan backtest lokal: EMA-cross dan breakout biasa
kehilangan $20–$110 di dev window. Jadi bot ini **jarang trading dan sabar**:

1. **Trend rider (mode utama).** Masuk long penuh hanya saat dua syarat terpenuhi
   sekaligus: SMA-60 di atas SMA-120 dengan band histeresis 10 bps (rezim naik
   terkonfirmasi) DAN close menembus high 20 bar terakhir. Keluar hanya saat
   rezim berbalik (SMA-60 < SMA-120 − band) atau trailing stop 250 bps dari peak.
   Setelah keluar ada **cooldown 240 bar** sebelum boleh masuk lagi — inilah yang
   mencegah whipsaw di fase sideways, tempat sebagian besar bot kehabisan uang.
2. **Oversold scalp (mode asuransi, hanya saat tidak uptrend).** Beli setengah
   posisi saat harga jatuh sangat jauh di bawah mean 60 bar (z-score < −2,5 DAN
   deviasi < −50 bps — dua syarat sekaligus supaya noise saat volatilitas rendah
   tidak memicu entry). Keluar cepat: TP +40 / SL −40 bps, saat z-score kembali
   ke 0, atau setelah 180 bar. Mode ini menjaga bot tetap punya ≥ 1 trade dan
   bisa menangkap pantulan bila jendela race ternyata turun terus.

Ukuran posisi juga dipangkas oleh depth pool (`c_depth` close terakhir) supaya
price impact sendiri tetap ≤ ~20 bps. Deterministik penuh: tanpa acak, tanpa jam
dinding, tanpa file di luar repo.

## Hasil backtest lokal (dev window, 1440 bar)

| Skenario | Net PnL | Trade | Max DD |
| --- | --- | --- | --- |
| Dev window (naik +3,64%) | **+$24,23** | 4 | 2,08% |
| Seri harga dibalik (turun −3,64%, sintetis) | −$5,22 | 6 | 0,52% |
| Paruh sideways saja (bar 720–1440) | +$0,93 | 2 | 0,71% |

Sebagai pembanding, buy-and-hold di dev window: +$32,17 — tapi di seri yang
dibalik ia kehilangan ~$32, sementara bot ini hanya −$5,22. Dev gate terpenuhi
(net PnL > 0) dan guardrail race (≥ 1 trade, max DD ≤ 25%) terpenuhi di semua
skenario uji.

## Menjalankan

```sh
# grade lokal resmi (tanpa docker, pakai driver process)
node cli/makefun.mjs grade-local --kit <kit-dir> --bot . --driver process
```

Entrypoint: `main.ts` (Node 22, TypeScript erasable, import pakai ekstensi `.ts`).
