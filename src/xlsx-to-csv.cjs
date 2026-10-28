#!/usr/bin/env node
// §4.1 converter: normalize an .xlsx/.xls into the canonical CSV the publish path reads.
// Headers verbatim, values as-is. Usage: node src/xlsx-to-csv.cjs <in.xlsx> [out.csv] [sheet]
const XLSX = require('xlsx');
const fs = require('fs');
const [inFile, outFile, sheetName] = process.argv.slice(2);
if (!inFile) { console.error('usage: node src/xlsx-to-csv.cjs <in.xlsx> [out.csv] [sheet]'); process.exit(2); }
const wb = XLSX.readFile(inFile);
const sheet = sheetName || wb.SheetNames[0];
const ws = wb.Sheets[sheet];
if (!ws) { console.error(`sheet "${sheet}" not found; sheets: ${wb.SheetNames.join(', ')}`); process.exit(1); }
const csv = XLSX.utils.sheet_to_csv(ws, { blankrows: false });
const out = outFile || inFile.replace(/\.(xlsx|xls)$/i, '.csv');
fs.writeFileSync(out, csv);
console.log(`converted "${sheet}" -> ${out} (${csv.trim().split('\n').length - 1} data rows)`);
