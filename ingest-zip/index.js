import crypto from 'crypto';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { pipeline } from 'stream/promises';
import {
    S3Client,
    GetObjectCommand,
    PutObjectCommand,
    DeleteObjectCommand
} from '@aws-sdk/client-s3';
import {
    CloudFormationClient,
    CreateStackCommand,
} from '@aws-sdk/client-cloudformation';
import Zip from 'adm-zip';
import Stack from './lib/stack.js';

async function handler() {
    const s3 = new S3Client({ region: process.env.AWS_DEFAULT_REGION || 'us-east-1' });
    const cf = new CloudFormationClient({ region: process.env.AWS_DEFAULT_REGION || 'us-east-1' });

    const task = JSON.parse(process.env.TASK);

    await pipeline(
        (await s3.send(new GetObjectCommand({
            Bucket: task.Bucket,
            Key: task.Key
        }))).Body,
        fs.createWriteStream(path.resolve(os.tmpdir(), 'input.zip'))
    );

    const batch = `batch-${crypto.randomUUID()}`;

    await cf.send(new CreateStackCommand({
        StackName: `${process.env.StackName}-${batch}`,
        TemplateBody: JSON.stringify(Stack)
    });

    const zip = new Zip(path.resolve(os.tmpdir(), 'input.zip'));

    for (const entry of zip.getEntries()) {
        const { ext } = path.parse(entry.entryName);
        const data = entry.getData();
        // Ensure if there are images with the same name they don't clobber on s3
        const key = crypto.createHash('md5').update(data).digest('hex');

        console.log(`ok - writing: ${batch}/${key}${ext}`);
        await s3.send(new PutObjectCommand({
            Bucket: task.Bucket,
            Key: `${batch}/${key}${ext}`,
            Body: data
        }));
    }

    await s3.send(new DeleteObjectCommand({
        Bucket: task.Bucket,
        Key: task.Key
    }));

    console.log('ok - extraction complete');
}

if (import.meta.url === `file://${process.argv[1]}`) handler();
