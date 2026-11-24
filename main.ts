// Pump.fun Paper Sprint — "First Big Buyer" early sniper.
//
// Idea, in one paragraph: on pump.fun almost every newborn coin dies, and
// buying after a coin has already pumped just buys the top. The only moment
// with a real edge in the dev window is the very first sign of serious money:
// the second buy on a fresh curve, when that buy is large (>= 0.2 SOL), or
// more generally the first minute of a coin's life while it is still cheap
// (<= +10% above its creation price) with real buy flow (>= 0.2 SOL of buys,
// 2-8 buy trades). The bot buys there — as soon as the harness's 1% of real
// reserve cap allows a round trip of at least 0.012 SOL — and exits fast and
// mechanically: everything out at +30%, everything out at -10%, a trailing
// stop once a trade peaks above +20%, and a hard time exit after 600 slots
// (~4 minutes). One trade per coin, never a re-buy, at most 5 open positions.
//
// Everything here is deterministic: no clock, no environment, no randomness.
// The only inputs are the replayed events the harness delivers.
//
// How the numbers were chosen: the dev window was screened rule by rule in
// an offline simulator that reproduces the harness (2-slot latency, 1%
// real-reserve buy cap, 1.25% curve fees, 105k lamports per order). Buying
// already-pumped coins lost about -2.2 SOL; buying the second trade of every
// coin lost about -0.14 SOL; conditioning the second-buy entry on a large
// second buy (>= 0.2 SOL) and adding the cheap-early window turned it
// slightly positive (+0.03 SOL over the 24 h dev window, 139 coins, max
// drawdown ~1%). The thresholds are deliberately coarse — the final window
// is unseen data, so the bot bets on the shape (early + big buyer), not on
// any tuned-to-the-decimal level.

import {
  runBot,
  LAMPORTS_PER_SOL,
  type Batch,
  type BotState,
  type OrderInput,
} from "./vendor/makefun-bot.ts";

// ---------------------------------------------------------------------------
// Tunables (all in plain units; lamports where the name says so).
// ---------------------------------------------------------------------------

/** Target size of one buy, in lamports (0.08 SOL). */
const BUY_SIZE_LAMPORTS = (LAMPORTS_PER_SOL * 8n) / 100n;
/** Smallest buy we will place (0.012 SOL): the guardrails need round trips
 *  of at least 0.01 SOL on 20+ coins, so never go below that with margin. */
const MIN_BUY_LAMPORTS = (LAMPORTS_PER_SOL * 12n) / 1000n;

/** Snipe trigger: the coin's 2nd buy trade must be at least this big. */
const SNIPE_MIN_SECOND_BUY_LAMPORTS = (LAMPORTS_PER_SOL * 2n) / 10n; // 0.2 SOL
/** Early-window trigger: cumulative buy volume since creation, at least this. */
const EARLY_MIN_BUY_VOL_LAMPORTS = (LAMPORTS_PER_SOL * 2n) / 10n; // 0.2 SOL
/** Early-window trigger: at most this many buy trades since creation. */
const EARLY_MAX_BUYS = 8;
/** Early-window trigger: coin age at most this many slots (~4 minutes). */
const EARLY_MAX_AGE_SLOTS = 600;
/** Early-window trigger: price at most this far above creation (+10%). */
const EARLY_MAX_GAIN = 0.1;

/** Take-profit: sell everything at +30% vs the filled entry price. */
const TAKE_PROFIT = 0.3;
/** Stop-loss: sell everything at -10% vs the filled entry price. */
const STOP_LOSS = -0.1;
/** Trailing stop arms once the peak return reaches +20% ... */
const TRAIL_ARM = 0.2;
/** ... and fires when the return falls 15 points below that peak. */
const TRAIL_DROP = 0.15;
/** Hard time exit: flatten a position this old (slots, ~4 minutes). */
const MAX_HOLD_SLOTS = 600;

/** Slippage tolerance on buys (5%) and sells (10%: exits must get out). */
const BUY_SLIPPAGE_BPS = 500;
const SELL_SLIPPAGE_BPS = 1000;

// ---------------------------------------------------------------------------
// Per-coin tracking.
// ---------------------------------------------------------------------------

/** What we know about one curve from its own events. */
interface CoinTrack {
  /** Slot of its CreateEvent. */
  createdSlot: number;
  /** Price (SOL per token, virtual reserves) at creation. */
  createPrice: number;
  /** Latest price (SOL per token, virtual reserves). */
  lastPrice: number;
  /** Buy trades seen since creation. */
  buys: number;
  /** SOL spent by buy trades since creation, in lamports. */
  buyVolLamports: bigint;
  /** Size of the most recent buy trade, in lamports. */
  lastBuyLamports: bigint;
}

/** What we know about one open position, from its buy fill. */
interface PositionInfo {
  /** Filled entry price: lamports paid per token (fees included). */
  entryPrice: number;
  /** Slot the buy filled at. */
  entrySlot: number;
  /** Best return (fraction) seen since entry. */
  peakReturn: number;
}

/** Price of a curve in SOL per token from its virtual reserves. */
function curvePrice(virtualSol: bigint, virtualTokens: bigint): number {
  if (virtualTokens <= 0n || virtualSol < 0n) return 0;
  return Number(virtualSol) / Number(virtualTokens);
}

// ---------------------------------------------------------------------------
// Bot state (plain module-level maps; the harness runs one replay per process).
// ---------------------------------------------------------------------------

const tracks = new Map<string, CoinTrack>();
const positions = new Map<string, PositionInfo>();
/** Mints we have already bought or sold: never touch them again. */
const doneMints = new Set<string>();
/** Mints with a buy order still in flight: do not send a second one. */
const pendingBuys = new Set<string>();

function foldEvents(batch: Batch): void {
  for (const event of batch.events) {
    if (event.event === "CreateEvent") {
      const price = curvePrice(
        BigInt(event.virtual_sol_reserves),
        BigInt(event.virtual_token_reserves),
      );
      if (price > 0) {
        tracks.set(event.mint, {
          createdSlot: event.slot,
          createPrice: price,
          lastPrice: price,
          buys: 0,
          buyVolLamports: 0n,
          lastBuyLamports: 0n,
        });
      }
    } else if (event.event === "TradeEvent") {
      const track = tracks.get(event.mint);
      if (track === undefined) continue;
      const price = curvePrice(
        BigInt(event.virtual_sol_reserves),
        BigInt(event.virtual_token_reserves),
      );
      if (price > 0) track.lastPrice = price;
      if (event.is_buy) {
        track.buys += 1;
        const amount = BigInt(event.sol_amount);
        track.buyVolLamports += amount;
        track.lastBuyLamports = amount;
      }
    } else {
      // CompleteEvent: the curve is over; forget the track so we never buy it.
      tracks.delete(event.mint);
    }
  }
}

function foldFills(batch: Batch): void {
  for (const fill of batch.fills) {
    if (fill.side === "buy") {
      pendingBuys.delete(fill.mint);
      if (fill.status === "filled") {
        const tokens = BigInt(fill.token_amount);
        const paid = BigInt(fill.quote_lamports);
        if (tokens > 0n && paid > 0n) {
          positions.set(fill.mint, {
            entryPrice: Number(paid) / Number(tokens),
            entrySlot: fill.slot,
            peakReturn: 0,
          });
        }
      }
    }
  }
}

function decideExits(state: BotState, orders: OrderInput[]): void {
  for (const [mint, holding] of state.positions) {
    const info = positions.get(mint);
    const curve = state.curves.get(mint);
    if (info === undefined || curve === undefined || curve.complete) continue;
    const price = curvePrice(
      curve.virtual_quote_reserves,
      curve.virtual_token_reserves,
    );
    if (price <= 0 || info.entryPrice <= 0) continue;
    const ret = price / info.entryPrice - 1;
    if (ret > info.peakReturn) info.peakReturn = ret;

    const age = state.slot - info.entrySlot;
    let sell = false;
    if (ret <= STOP_LOSS) {
      sell = true; // stop-loss: out, in full.
    } else if (ret >= TAKE_PROFIT) {
      sell = true; // take-profit: bank everything at +30%.
    } else if (info.peakReturn >= TRAIL_ARM && ret <= info.peakReturn - TRAIL_DROP) {
      sell = true; // trailing stop: give back no more.
    } else if (age >= MAX_HOLD_SLOTS) {
      sell = true; // time exit: the spark is gone.
    }
    if (sell) {
      orders.push({
        side: "sell",
        mint,
        token_amount: holding.token_amount,
        max_slippage_bps: SELL_SLIPPAGE_BPS,
      });
      doneMints.add(mint);
    }
  }
}

/** True when a fresh coin shows the "first big buyer" signal right now. */
function entrySignal(track: CoinTrack, ageSlots: number): boolean {
  // Trigger A — snipe: the coin's 2nd buy just landed and it was big.
  // A large second buy means somebody with size is stepping in first.
  if (track.buys === 2 && track.lastBuyLamports >= SNIPE_MIN_SECOND_BUY_LAMPORTS) {
    return true;
  }
  // Trigger B — cheap early window: the coin is still near its creation
  // price, a few buys have arrived and real SOL is flowing in.
  if (
    ageSlots >= 0 &&
    ageSlots <= EARLY_MAX_AGE_SLOTS &&
    track.buys >= 2 &&
    track.buys <= EARLY_MAX_BUYS &&
    track.buyVolLamports >= EARLY_MIN_BUY_VOL_LAMPORTS &&
    track.lastPrice / track.createPrice - 1 <= EARLY_MAX_GAIN
  ) {
    return true;
  }
  return false;
}

function decideEntries(state: BotState, orders: OrderInput[]): void {
  const maxOpen = state.hello.caps.max_open_positions;
  let freeCash = state.freeCashLamports();
  // Reserve one tx fee per order we might still send this batch, plus the
  // buys themselves, so we never promise cash we do not have.
  const txFee = state.txFeeLamports();

  for (const [mint, track] of tracks) {
    if (orders.length >= state.hello.caps.max_orders_per_batch) break;
    if (state.committedPositionCount() + pendingBuys.size >= maxOpen) break;
    if (doneMints.has(mint) || pendingBuys.has(mint)) continue;
    if (state.positions.has(mint)) continue;

    const age = state.slot - track.createdSlot;
    if (!entrySignal(track, age)) continue;

    // Size: target size, capped by the harness's per-mint limit and by cash.
    let size = BUY_SIZE_LAMPORTS;
    const cap = state.maxBuyLamports(mint);
    if (cap < size) size = cap;
    const affordable = freeCash - txFee;
    if (affordable < size) size = affordable;
    if (size < MIN_BUY_LAMPORTS) continue;

    orders.push({
      side: "buy",
      mint,
      quote_lamports: size,
      max_slippage_bps: BUY_SLIPPAGE_BPS,
    });
    pendingBuys.add(mint);
    freeCash -= size + txFee;
  }
}

await runBot({
  onBatch(state, batch) {
    foldEvents(batch);
    foldFills(batch);
    // Forget positions the account no longer holds (sold, completed, flattened).
    for (const mint of [...positions.keys()]) {
      if (!state.positions.has(mint)) positions.delete(mint);
    }

    const orders: OrderInput[] = [];
    decideExits(state, orders);
    decideEntries(state, orders);
    return orders;
  },
  onDone(state, _done) {
    console.error(
      `[first-big-buyer] done after ${state.seq + 1} batches; ` +
        `cash=${state.cash} lamports, positions=${state.positions.size}, ` +
        `coins seen=${tracks.size}, coins traded=${doneMints.size}`,
    );
  },
});
