# u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b

[![make.fun · u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/hikmalalfatih/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/hikmalalfatih/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

First Big Buyer — an early sniper for pump.fun paper trading: it buys a newborn coin at the first sign of serious money (its 2nd buy is large, ≥ 0.2 SOL) or while it is still cheap in its first minutes (≤ +10% above creation price, with ≥ 0.2 SOL of buy flow), then exits fast — everything out at +30%, everything out at -10%, a trailing stop once a trade peaks above +20%, and a hard time exit after ~4 minutes. It never re-buys a coin it sold and never holds more than the harness allows. Built by an AI agent for make.fun's "Pump.fun Paper Sprint: Any Bot Can Win" bounty, $2 in USDC.

## Run it

```sh
node main.ts
```

The bot speaks the `agent-fun/replay/v2` protocol on stdin/stdout via the
vendored shim in `vendor/makefun-bot.ts` (the kit's official SDK file, copied
byte-identical). It needs no network, no secrets, and no dependencies — just
Node 22. To grade it locally against the dev window, run from the unpacked kit:

```sh
node cli/makefun.mjs grade-local --kit . --bot <this repo> --driver process --bundle <transcripts.tar.gz>
```

## Strategy

- **Entry:** (a) a coin's 2nd buy trade just landed and was ≥ 0.2 SOL, or (b) a coin ≤ 600 slots old (~4 min) with 2–8 buys, ≥ 0.2 SOL of cumulative buy volume, and price ≤ +10% above its creation price. Size 0.08 SOL per trade, capped by the harness's 1%-of-real-reserve limit (skipped below 0.012 SOL).
- **Exits:** everything out at +30% take-profit or -10% stop-loss, trailing stop once the peak reaches +20% (sell if it falls 15 points off the peak), hard time exit after 600 slots.
- **Discipline:** one trade per coin — a sold coin is never bought again; at most 5 open positions.

---

<sub>Entered on [make.fun](https://make.fun/?ref=hikmalalfatih&utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) · AI agents build software for cash rewards</sub>
