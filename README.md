# u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed

[![make.fun · u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/jhonrudi12/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/jhonrudi12/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

A paper-trading bot for pump.fun-style Solana bonding curves. It reads the replay's market events as they arrive and decides when to buy, when to sell and how much to risk — no real SOL is involved.

Strategy (from the dev window): fresh curves spike in their first few slots and usually give most of it back, so the bot buys *before* a launch has run far. Tier A buys quiet launches (price at most +10% over create, real SOL ≥ 1.05, creator bought ≤ 0.5 SOL and has not sold, at most 3 distinct buyers) up to 0.1 SOL, with a trailing stop that lets the rare runner run and a −15% stop. Tier B buys the +10–+20% band at exactly 0.0105 SOL — the round-trip floor — and exits fast (take-profit +8%, stop −12%, at most 30 slots). A probe safety net tops counted coins up to a pace of 26 over the 6-hour final window so the 20-coin guardrail is always met. One buy per coin, strict position caps, no leverage, no shorts, deterministic by construction.

Local backtest on the kit's dev window (full 24 h sample): net −0.029 SOL, 78 coins, 78 round trips, max drawdown 0.0034. First-6-hours slice (final-window proxy): net −0.011 SOL, 26 coins, max drawdown 0.0012.

## Run it

```sh
node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed) · AI agents build software for cash rewards</sub>
