import { runPoolBacktest } from './packages/trading-agent/dist/backtest/engine.js';
import { createDataStore, setDataStore } from './packages/trading-agent/dist/data/index.js';
import { join } from 'path';
import { homedir } from 'os';

async function main() {
  const dbPath = join(homedir(), '.trading-agent', 'data', 'market.db');
  const store = createDataStore(dbPath);
  setDataStore(store);
  
  const stocks = [
    { code: '601398', market: 1, name: '工商银行' },
    { code: '601988', market: 1, name: '中国银行' },
    { code: '600941', market: 1, name: '中国移动' },
    { code: '601138', market: 1, name: '工业富联' },
    { code: '300308', market: 0, name: '中际旭创' },
    { code: '601088', market: 1, name: '中国神华' },
    { code: '688256', market: 1, name: '寒武纪' },
    { code: '300502', market: 0, name: '新易盛' },
    { code: '600900', market: 1, name: '长江电力' },
  ];
  
  console.log('Starting pool backtest with', stocks.length, 'stocks...');
  const t0 = Date.now();
  
  const result = await runPoolBacktest(stocks, {
    strategy: 'ma_cross',
    start: '20240101',
    end: '20241231',
    period: 'daily',
    adjust: 'qfq',
    initialCapital: 1_000_000,
    slippage: 0.001,
    commission: 0.0003,
  });
  
  console.log('Done in', Date.now() - t0, 'ms');
  console.log('---');
  console.log('Initial capital:', result.initialCapital);
  console.log('Total trades:', result.trades.length);
  console.log('Buy trades:', result.trades.filter(t => t.direction === 'buy').length);
  console.log('Sell trades:', result.trades.filter(t => t.direction === 'sell').length);
  console.log('Equity curve length:', result.equityCurve.length);
  console.log('Final equity:', result.equityCurve[result.equityCurve.length - 1]?.equity);
  console.log('---');
  console.log('Metrics:');
  console.log('  Total return:', result.metrics.totalReturn.toFixed(2) + '%');
  console.log('  Annualized return:', result.metrics.annualizedReturn.toFixed(2) + '%');
  console.log('  Sharpe:', result.metrics.sharpeRatio.toFixed(2));
  console.log('  Max drawdown:', result.metrics.maxDrawdown.toFixed(2) + '%');
  console.log('  Win rate:', result.metrics.winRate.toFixed(1) + '%');
  console.log('  Total trades:', result.metrics.totalTrades);
  console.log('---');
  console.log('Per-stock stats:');
  const stockStats = new Map();
  for (const s of stocks) stockStats.set(s.code, { buys: 0, sells: 0, pnl: 0 });
  for (const t of result.trades) {
    const stat = stockStats.get(t.code);
    if (!stat) continue;
    if (t.direction === 'buy') stat.buys++;
    if (t.direction === 'sell') { stat.sells++; stat.pnl += t.pnl ?? 0; }
  }
  for (const [code, stat] of stockStats) {
    console.log(`  ${code}: ${stat.buys} buys, ${stat.sells} sells, PnL ${stat.pnl.toFixed(0)}`);
  }
  console.log('---');
  console.log('Last 10 trades:');
  for (const t of result.trades.slice(-10)) {
    if (t.direction === 'buy') {
      console.log(`  ${t.date} ${t.code} BUY ${t.shares} @ ${t.price.toFixed(2)}`);
    } else {
      console.log(`  ${t.date} ${t.code} SELL ${t.shares} @ ${t.price.toFixed(2)} | PnL ${(t.pnl ?? 0).toFixed(0)}`);
    }
  }
}

main().catch(console.error);
