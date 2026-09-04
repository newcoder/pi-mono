const fs = require('fs');
const path = 'D:/projects/pi-mono/packages/trading-agent/src/main.ts';
let content = fs.readFileSync(path, 'utf8');

const insertBefore = '\t\t// --db-stats\n\t\tif (args.includes("--db-stats")) {';
const newBlock = `\t\t// --sync-all-fundamentals [--batch-size <n>]
\t\tif (args.includes("--sync-all-fundamentals")) {
\t\t\tconst batchSizeIdx = args.indexOf("--batch-size");
\t\t\tconst batchSizeStr = batchSizeIdx >= 0 ? args[batchSizeIdx + 1] : undefined;
\t\t\tconst batchSize = batchSizeStr ? parseInt(batchSizeStr, 10) : 100;
\t\t\tconsole.log(`Syncing all A-share fundamentals (batch=${batchSize})...`);
\t\t\tconst count = await sync.syncAllFundamentals(batchSize);
\t\t\tconsole.log(`Synced ${count} total fundamentals records.`);
\t\t\tstore.close();
\t\t\treturn true;
\t\t}

${insertBefore}`;

if (!content.includes(insertBefore)) {
    console.log('Target not found');
    process.exit(1);
}

content = content.replace(insertBefore, newBlock);
fs.writeFileSync(path, content, 'utf8');
console.log('Added --sync-all-fundamentals command');
