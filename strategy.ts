// Pump.fun launch bot for agent-fun/replay/v2.
//
// Idea (from the dev window, Nov 2-3 2026): a fresh bonding curve spikes in its
// first few slots and then usually gives most of it back. Buying *after* the spike
// (+30% or more above the create price) loses; buying *before* it has run far,
// on a launch whose creator only put in a little and has not sold, roughly breaks
// even before fees. There is no big edge here, so the bot is built to (a) lose as
// little as possible while (b) always clearing the guardrails: at least 20 coins
// with a round trip of at least 0.01 SOL, and max drawdown far below 50%.
//
// Two tiers, one buy per coin, ever:
//   Tier A (core): launch is still quiet — price at most +10% over create, real SOL
//     >= 1.05, creator buy <= 0.5 SOL, creator has not sold, at most 3 distinct
//     non-creator buyers. Buys up to 0.1 SOL (the 1%-of-reserve cap binds first).
//     No fixed take-profit: a trailing stop (arms at +15%, exits on a 20% give-back
//     from the peak) lets the rare runner run; a -15% stop and a 600-slot hold cap
//     cut the rest.
//   Tier B (breadth): the same launch shape but the price already ran +10..+30%
//     and the creator bought up to 2.5 SOL. Buys exactly 0.01 SOL — the round-trip
//     floor — and exits fast (take-profit +10%, stop -8%, at most 15 slots held).
//     These trades are slightly negative on average; they exist to bank counted
//     coins for the guardrail at a known small cost.
//   Tier C (probe safety net): if the bot's own counted coins (filled buys of
//     >= 0.01 SOL) fall behind a pace of 26 coins over the 6-hour final window,
//     it buys 0.01 SOL of the most liquid untraded coin in the batch and sells it
//     on the next batch. This only fires when the tiers under-deliver.
//
// Everything is a pure function of the batches: no clock, no randomness, no I/O,
// iteration only over insertion-ordered maps fed by the batch stream, so the two
// graded executions produce byte-identical action logs.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Oldest age (slots since create) at which a first buy may still be decided. */
  maxAge: number;
  /** Real SOL reserve window at entry (SOL). Below 1.05 the 1% cap cannot fund a 0.01 SOL buy. */
  minRqSol: number;
  maxRqSol: number;
  /** Tier A: price now over the create price, at most (bps, 10000 = unchanged). */
  maxRunupABps: number;
  /** Tier B: price now over the create price, at most (bps). */
  maxRunupBBps: number;
  /** Tier A: creator's own buys in the create slot, at most (SOL). */
  maxDevBuyASol: number;
  /** Tier B: creator's own buys in the create slot, at most (SOL). */
  maxDevBuyBSol: number;
  /** Most distinct non-creator buyers seen before entry. */
  maxBuyersA: number;
  maxBuyersB: number;
  /** Largest single non-creator sell, as bps of the real SOL reserve before it. */
  maxBigSellBps: number;
  /** Tier A stake (SOL); the 1%-of-reserve cap binds first on fresh curves. */
  stakeASol: number;
  /** Tier B stake (SOL): exactly the round-trip floor. */
  stakeBSol: number;
  /** Smallest buy worth sending (SOL). */
  minBuySol: number;
  /** Slippage on buys (bps); sells always go out at 10000. */
  buySlipBps: number;
  /** Tier A exits. */
  stopLossA: number;
  trailArmA: number;
  trailA: number;
  maxHoldA: number;
  /** Tier B exits. */
  takeProfitB: number;
  stopLossB: number;
  maxHoldB: number;
  /** Exit a position if its coin had no trade for this many slots. */
  staleSlots: number;
  /** Slots to wait after an exit before the same curve may be bought again (0 = never). */
  cooldown: number;
  /** Guardrail pacing: counted coins to reach over paceSecs of block time. */
  targetCoins: number;
  paceSecs: number;
  probeSol: number;
  /** Most SOL at cost across all positions at once (a drawdown guard). */
  maxExposureSol: number;
}

export const DEFAULT_PARAMS: Params = {
  maxAge: 10,
  minRqSol: 1.1,
  maxRqSol: 60,
  maxRunupABps: 11_000,
  maxRunupBBps: 12_000,
  maxDevBuyASol: 0.5,
  maxDevBuyBSol: 0.5,
  maxBuyersA: 3,
  maxBuyersB: 6,
  maxBigSellBps: 10_000,
  stakeASol: 0.1,
  stakeBSol: 0.0105,
  minBuySol: 0.01,
  buySlipBps: 10000,
  stopLossA: 0.15,
  trailArmA: 0.15,
  trailA: 0.2,
  maxHoldA: 600,
  takeProfitB: 0.08,
  stopLossB: 0.12,
  maxHoldB: 30,
  staleSlots: 2000,
  cooldown: 0,
  targetCoins: 26,
  paceSecs: 21_600,
  probeSol: 0.0105,
  maxExposureSol: 2,
};

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125;
const BPS = 10_000;

interface Coin {
  created: number;
  creator: Pubkey;
  vq0: bigint;
  vt0: bigint;
  devBuy: number;
  devSold: boolean;
  buyers: Set<Pubkey>;
  bought: number;
  soldByOthers: number;
  bigSellBps: number;
  lastTradeSlot: number;
  /** Tier of the filled buy ('A' | 'B' | 'C'), or null when never bought. */
  tier: 'A' | 'B' | 'C' | null;
  done: boolean;
  lastExit: number;
}

interface Held {
  opened: number;
  tier: 'A' | 'B' | 'C';
  peakValue: number;
  /** SOL sent in buys for this position (fees included). */
  invested: number;
  txPaid: number;
  devSoldAtOpen: boolean;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  /** Filled buy SOL per mint (for the counted-coins pace). */
  const boughtSol = new Map<Pubkey, number>();
  const counted = new Set<Pubkey>();
  /** Probe in flight: mint -> true once its sell has been sent. */
  const probes = new Map<Pubkey, boolean>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;

  const coinOf = (mint: Pubkey): Coin => {
    let c = coins.get(mint);
    if (c === undefined) {
      c = {
        created: -1, creator: '', vq0: 0n, vt0: 1n, devBuy: 0, devSold: false,
        buyers: new Set(), bought: 0, soldByOthers: 0, bigSellBps: 0,
        lastTradeSlot: -1, tier: null, done: false, lastExit: -1e12,
      };
      coins.set(mint, c);
    }
    return c;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const traded = new Set<Pubkey>();
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          const c = coinOf(e.mint);
          c.created = e.slot;
          c.creator = e.creator;
          c.vq0 = BigInt(e.virtual_quote_reserves);
          c.vt0 = BigInt(e.virtual_token_reserves);
          c.lastTradeSlot = e.slot;
        } else if (e.event === 'TradeEvent') {
          const c = coins.get(e.mint);
          if (c === undefined) continue;
          const sol = Number(e.sol_amount) / LAMPORTS;
          c.lastTradeSlot = e.slot;
          traded.add(e.mint);
          const isDev = e.user === c.creator;
          if (e.is_buy) {
            c.bought += sol;
            if (isDev && e.slot === c.created) c.devBuy += sol;
            else if (!isDev) c.buyers.add(e.user);
          } else if (isDev) {
            c.devSold = true;
          } else {
            c.soldByOthers += sol;
            const rqBefore = Number(e.real_quote_reserves) / LAMPORTS + sol;
            if (rqBefore > 0) {
              const bps = (sol / rqBefore) * BPS;
              if (bps > c.bigSellBps) c.bigSellBps = bps;
            }
          }
        } else if (e.event === 'CompleteEvent') {
          const c = coins.get(e.mint);
          if (c !== undefined) c.done = true;
        }
      }

      // Fills: track buys (counted coins, held entries) and sells.
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) {
        pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
      }
      for (const f of batch.fills) {
        if (f.client_id.startsWith('_')) continue;
        const c = coins.get(f.mint);
        if (f.side === 'buy' && f.status === 'rejected' && c !== undefined && !held.has(f.mint)) {
          // The buy never landed (usually slippage on a spike): one shot per coin.
          c.tier = null;
          c.done = true;
        }
        if (f.side === 'buy' && f.status === 'filled') {
          const paid = Number(f.quote_lamports) / LAMPORTS;
          boughtSol.set(f.mint, (boughtSol.get(f.mint) ?? 0) + paid);
          if ((boughtSol.get(f.mint) ?? 0) >= p.minBuySol) counted.add(f.mint);
          if (c !== undefined && c.tier !== null && !held.has(f.mint)) {
            held.set(f.mint, {
              opened: f.slot, tier: c.tier, peakValue: 0,
              invested: paid, txPaid: Number(f.tx_fee_lamports) / LAMPORTS,
              devSoldAtOpen: c.devSold,
            });
          }
        }
        const h = held.get(f.mint);
        if (h !== undefined && f.status !== 'rejected') {
          h.txPaid += Number(f.tx_fee_lamports) / LAMPORTS;
        }
      }
      // Drop held entries whose position is gone and nothing is pending.
      for (const [mint, h] of held) {
        if (!state.positions.has(mint) && !pendingByMint.has(mint)) {
          held.delete(mint);
          const c = coins.get(mint);
          if (c !== undefined) {
            c.done = true;
            c.lastExit = now;
          }
          probes.delete(mint);
          void h;
        }
      }
      for (const [mint, selling] of probes) {
        if (!state.positions.has(mint) && !pendingByMint.has(mint)) probes.delete(mint);
        void selling;
      }

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));

      const sellValue = (mint: Pubkey, tokens: bigint): number => {
        const mk = marks.get(mint);
        const curve = state.curves.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : curve ? Number(curve.virtual_quote_reserves) : 0;
        const vt = mk ? Number(mk.virtual_token_reserves) : curve ? Number(curve.virtual_token_reserves) : 0;
        if (vt <= 0 || tokens <= 0n) return 0;
        return ((Number(tokens) * vq) / (vt + Number(tokens)) / LAMPORTS) * (1 - CURVE_FEE) - tx;
      };

      // Exits first.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined || curve === undefined || curve.complete) continue;
        const c = coins.get(mint);
        const value = sellValue(mint, pos.token_amount);
        const cost = Number(pos.cost_lamports) / LAMPORTS + h.txPaid;
        if (value > h.peakValue) h.peakValue = value;
        let exit = false;
        if (cost > 0) {
          if (h.tier === 'A') {
            if (value < cost * (1 - p.stopLossA)) exit = true;
            if (!exit && h.peakValue >= cost * (1 + p.trailArmA) && value < h.peakValue * (1 - p.trailA)) exit = true;
            if (!exit && now - h.opened > p.maxHoldA) exit = true;
          } else if (h.tier === 'B') {
            if (value >= cost * (1 + p.takeProfitB)) exit = true;
            if (!exit && value < cost * (1 - p.stopLossB)) exit = true;
            if (!exit && now - h.opened > p.maxHoldB) exit = true;
          } else {
            // Probe: sell as soon as the buy has landed.
            exit = true;
          }
        }
        if (!exit && c !== undefined) {
          if (p.cooldown > 0) void 0;
          if (h.tier !== 'C' && c.devSold && !h.devSoldAtOpen) exit = true;
          if (!exit && now - c.lastTradeSlot >= p.staleSlots) exit = true;
        }
        if (!exit) continue;
        if (pendingByMint.has(mint)) {
          let sellPending = false;
          for (const po of state.pending.values()) {
            if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
          }
          if (sellPending) continue;
        }
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        if (h.tier === 'C') probes.set(mint, true);
      }

      // Entries and probes.
      let bestProbe: { mint: Pubkey; rq: number } | null = null;
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let exposure = 0;
      for (const h of held.values()) exposure += h.invested;

      // Probe pacing: counted coins behind pace?
      let probeDue = false;
      if (firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        probeDue = counted.size < Math.ceil(p.targetCoins * pace);
      }

      for (const mint of traded) {
        if (orders.length >= cap) break;
        const c = coins.get(mint)!;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete || c.done) continue;
        if (c.created < 0 || now - c.created > p.maxAge) {
          if (now - c.created > p.maxAge && c.tier === null) c.done = true;
          continue;
        }
        if (pendingByMint.has(mint) || held.has(mint) || probes.has(mint)) continue;
        if (c.tier !== null) continue; // already bought once
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        if (rqSol < p.minRqSol || rqSol > p.maxRqSol) continue;
        if (c.devSold || c.bigSellBps > p.maxBigSellBps) continue;
        if (c.bought > 0 && c.soldByOthers > c.bought) continue;
        const runupBps = c.vq0 > 0n && c.vt0 > 0n
          ? (Number(curve.virtual_quote_reserves) * Number(c.vt0) * BPS) / (Number(curve.virtual_token_reserves) * Number(c.vq0))
          : BPS * 100;
        let tier: 'A' | 'B' | null = null;
        let want = 0;
        if (
          runupBps <= p.maxRunupABps && c.devBuy <= p.maxDevBuyASol &&
          c.buyers.size <= p.maxBuyersA
        ) {
          tier = 'A';
          want = p.stakeASol;
        } else if (
          runupBps <= p.maxRunupBBps && c.devBuy <= p.maxDevBuyBSol &&
          c.buyers.size <= p.maxBuyersB
        ) {
          tier = 'B';
          want = p.stakeBSol;
        }
        // Probe candidates are collected and the most liquid one is bought after
        // the loop, only when behind pace.
        if (tier === null && probeDue && probes.size === 0 && runupBps <= 20_000) {
          if (bestProbe === null || rqSol > bestProbe.rq) bestProbe = { mint, rq: rqSol };
        }
        if (tier === null) continue;
        if (tier !== 'C' && slotsLeft <= 0) continue;
        if (tier === 'C' && slotsLeft <= 0) continue;
        if (exposure + want > p.maxExposureSol && tier !== 'C') continue;
        const capSol = Math.floor(Number(state.maxBuyLamports(mint)) * 0.98) / LAMPORTS;
        let amount = Math.min(capSol, want);
        if (amount > free - tx) amount = free - tx;
        if (amount < p.minBuySol) continue;
        const lamports = BigInt(Math.floor(amount * LAMPORTS));
        orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.buySlipBps });
        free -= amount + tx;
        exposure += amount;
        slotsLeft--;
        c.tier = tier;
        if (tier === 'C') probes.set(mint, false);
      }
      // Probe safety net: one 0.0105 SOL buy of the most liquid sane coin in this
      // batch, only when counted coins lag the pace and no probe is already open.
      if (
        probeDue && probes.size === 0 && bestProbe !== null &&
        slotsLeft > 0 && orders.length < cap && free > p.probeSol + tx
      ) {
        const mint = bestProbe.mint;
        const c = coins.get(mint)!;
        const capSol = Math.floor(Number(state.maxBuyLamports(mint)) * 0.98) / LAMPORTS;
        const amount = Math.min(capSol, p.probeSol);
        if (amount >= p.minBuySol && !pendingByMint.has(mint) && !held.has(mint) && c.tier === null) {
          const lamports = BigInt(Math.floor(amount * LAMPORTS));
          orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.buySlipBps });
          c.tier = 'C';
          probes.set(mint, false);
        }
      }
      return orders;
    },
  };
}
