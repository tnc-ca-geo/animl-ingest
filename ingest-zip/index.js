import os from 'os';
import path from 'path';
import AWS from 'aws-sdk';
import fs from 'fs/promises';
import { pipeline } from 'stream/promises';
import Zip from 'adm-zip';

const s3 = new AWS.S3({ region: process.env.AWS_DEFAULT_REGION || 'us-east-1' });

async function handler() {
    const task = JSON.parse(process.env.TASK);

    await promise(
        s3.getObject({
            Bucket: task.Bucket,
            Key: task.Key
        }).createReadStream(),
       fs.createWriteStream(path.resolve(os.tmpdir(), 'input.zip'))
   );

    const zip = new Zip(path.resolve(os.tmpdir(), 'input.zip'));

    for (const entry of zip.getEntries()) {
        console.error(entry);
    }
}

if (import.meta.url === `file://${process.argv[1]}`) handler();
