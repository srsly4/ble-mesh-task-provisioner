import * as fs from 'fs';
import * as path from 'path';
import * as csv from 'fast-csv';

let tids = {};


fs.createReadStream(path.resolve(__dirname, process.argv[2]))
    .pipe(csv.parse({ headers: false }))
    .on('error', error => console.error(error))
    .on('data', row => {
        const tid = parseInt(row[0]);
        // const nodeId = row[1];
        const adc = parseInt(row[2]);
        
        if (!tids[tid]) {
            tids[tid] = [];
        }

        tids[tid].push(adc);
    })
    .on('end', (rowCount) => {
        console.log(`Parsed ${rowCount} rows`);
        for (const taskVals of Object.values(tids)) {
            let min = 4096; let max = 0;
            for (const val of taskVals) {
                min = Math.min(val, min);
                max = Math.max(val, max);
            }
            fs.appendFile(process.argv[3],
                `${(max-min)/4096}\n`, (err) => {
                    if (err)
                        console.warn('Could not log provision time', err);
                })
        }

    });