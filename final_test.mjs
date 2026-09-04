import { verifyConceptStocksTool, analyzeConceptPersistenceTool } from './packages/trading-agent/dist/tools/concept-analysis.js';

console.log('=== 华为昇腾 — 概念持续性分析 ===');
try {
  const r1 = await analyzeConceptPersistenceTool.execute('final-1', { concept: '华为昇腾', days: 30 });
  console.log(r1.content[0].text);
} catch (e) {
  console.error('持续性分析失败:', e.message);
}

console.log('\n=== 华为昇腾 — 概念股相关性筛选（新方法）===');
const start = Date.now();
try {
  const r2 = await verifyConceptStocksTool.execute('final-2', { concept: '华为昇腾', minCorrelation: 0.1, lookbackDays: 60 });
  console.log(r2.content[0].text);
} catch (e) {
  console.error('筛选失败:', e.message);
}
console.log(`\n耗时: ${((Date.now() - start) / 1000).toFixed(1)}s`);
