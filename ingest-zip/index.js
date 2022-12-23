import crypto from 'crypto';
import os from 'os';
import path from 'path';
import AWS from 'aws-sdk';
import fs from 'fs';
import { pipeline } from 'stream/promises';
import Zip from 'adm-zip';

const s3 = new AWS.S3({ region: process.env.AWS_DEFAULT_REGION || 'us-east-1' });

async function handler() {
    const task = JSON.parse(process.env.TASK);

    await pipeline(
        s3.getObject({
            Bucket: task.Bucket,
            Key: task.Key
        }).createReadStream(),
       fs.createWriteStream(path.resolve(os.tmpdir(), 'input.zip'))
   );

   const batch = `batch-${crypto.randomUUID()}`;

    const zip = new Zip(path.resolve(os.tmpdir(), 'input.zip'));

    for (const entry of zip.getEntries()) {
        const {ext} = path.parse(entry.entryName);
        const data = entry.getData();
        // Ensure if there are images with the same name they don't clobber on s3
        const key = crypto.createHash('md5').update(data).digest('hex');

        console.log(`ok - writing: ${batch}/${key}${ext}`);
        await s3.putObject({
            Bucket: task.Bucket,
            Key: `${batch}/${key}${ext}`,
            Body: data
        }).promise();
    }

    await s3.deleteObject({
        Bucket: task.Bucket,
        Key: task.Key
    }).promise();

    console.log('ok - extraction complete');
}

if (import.meta.url === `file://${process.argv[1]}`) handler();
