import os from 'os';
import crypto from 'node:crypto';
import path from 'path';
import fs from 'fs';
import { pipeline } from 'stream/promises';
import stream from 'stream';
import S3 from '@aws-sdk/client-s3';
import SSM from '@aws-sdk/client-ssm';
import CloudFormation from '@aws-sdk/client-cloudformation';
import EventStream from './lib/cfstream.js';
import StreamZip from 'node-stream-zip';
import Stack from './lib/stack.js';

const APIKEY = process.env.APIKEY;

// If this is changed also update ingest-image
const SUPPORTED_FILE_TYPES = ['.jpg', '.png'];

export default async function handler() {
    const task = JSON.parse(process.env.TASK);
    const batch = task.Key.replace('.zip', '');
    const StackName = `${process.env.StackName}-${batch}`;
    const STAGE = process.env.STAGE || 'dev';

    const params = new Map();

    try {
        const s3 = new S3.S3Client({ region: process.env.AWS_DEFAULT_REGION || 'us-west-2' });
        const cf = new CloudFormation.CloudFormationClient({ region: process.env.AWS_DEFAULT_REGION || 'us-west-2' });
        const ssm = new SSM.SSMClient({ region: process.env.AWS_DEFAULT_REGION || 'us-west-2' });

        for (const param of (await ssm.send(new SSM.GetParametersCommand({
            Names: [`/api/url-${STAGE}`],
            WithDecryption: true
        }))).Parameters) {
            console.log(`ok - setting ${param.Name}`);
            params.set(param.Name, param.Value);
        }

        const head = await s3.send(new S3.HeadObjectCommand({
            Bucket: task.Bucket,
            Key: task.Key
        }));

        await pipeline(
            (await s3.send(new S3.GetObjectCommand({
                Bucket: task.Bucket,
                Key: task.Key
            }))).Body,
            fs.createWriteStream(path.resolve(os.tmpdir(), 'input.zip'))
        );

        // Preparse Zip to get a general sense of how many items are in the zip
        // and if it is empty ignore it
        const zip = new StreamZip.async({
            file: path.resolve(os.tmpdir(), 'input.zip'),
            skipEntryNameValidation: true
        });

        let total = 0;
        const entries = await zip.entries();
        for (const entrykey in entries) {
            const entry = entries[entrykey];
            const parsed = path.parse(entry.name);
            if (!parsed.ext) continue;
            if (parsed.base[0] === '.') continue;
            if (!SUPPORTED_FILE_TYPES.includes(parsed.ext)) continue;
            total++;
        }

        zip.close();

        const processingStart = new Date();
        const input = {
            _id: batch,
            eTag: JSON.parse(head.ETag), // Required to remove double escape by AWS
            total: total,
            processingStart
        };

        if (total === 0) input.processingEnd = input.processingStart;

        await fetcher(params.get(`/api/url-${STAGE}`), {
            query: `
                mutation UpdateBatch($input: UpdateBatchInput!){
                    updateBatch(input: $input) {
                        batch {
                            _id
                            total
                        }
                    }
                }
            `,
            variables: { input }
        });

        if (total === 0) {
            console.log('ok - no image files to process');
            return;
        }

        await cf.send(new CloudFormation.CreateStackCommand({
            StackName,
            TemplateBody: JSON.stringify(Stack.generate(process.env.StackName, task, STAGE)),
            Parameters: [{
                ParameterKey: 'BatchID',
                ParameterValue: batch
            },{
                ParameterKey: 'S3URL',
                ParameterValue: `s3://${task.Bucket}/${task.Key}`
            }]
        }));

        await monitor(StackName);

        const prezip = new StreamZip.async({
            file: path.resolve(os.tmpdir(), 'input.zip'),
            skipEntryNameValidation: true
        });

        const preentries = await prezip.entries();
        for (const entrykey in preentries) {
            const entry = preentries[entrykey];
            const parsed = path.parse(entry.name);
            if (!parsed.ext) continue;
            if (parsed.base[0] === '.') continue;
            if (!SUPPORTED_FILE_TYPES.includes(parsed.ext)) continue;

            const data = await prezip.entryData(entry);
            // Ensure if there are images with the same name they don't clobber on s3
            const key = crypto.createHash('md5').update(data).digest('hex');

            console.log(`ok - writing: ${batch}/${key}${parsed.ext}`);
            await s3.send(new S3.PutObjectCommand({
                Bucket: task.Bucket,
                Key: `${batch}/${key}${parsed.ext}`,
                Body: data
            }));
        }

        prezip.close();

        await s3.send(new S3.DeleteObjectCommand({
            Bucket: task.Bucket,
            Key: task.Key
        }));

        console.log('ok - extraction complete');
    } catch (err) {
        console.error(err);

        if (params.has(`/api/url-${STAGE}`)) {
            await fetcher(params.get(`/api/url-${STAGE}`), {
                query: `
                    mutation CreateBatchError($input: CreateBatchErrorInput!) {
                        createBatchError(input: $input) {
                            _id
                            batch
                            error
                            created
                        }
                    }
                `,
                variables: {
                    input: {
                        error: err.message,
                        batch: batch
                    }
                }
            });
        } else {
            console.error('not ok - Failed to post to CreateBatchError');
        }

        throw err;
    }
}

function monitor(StackName) {
    const region = process.env.AWS_DEFAULT_REGION || 'us-west-2';

    return new Promise((resolve, reject) => {
        const events = EventStream(StackName, { region })
            .on('error', (err) => {
                return reject(err);
            });

        const stringify = new stream.Transform({ objectMode: true });
        stringify._transform = (event, enc, cb) => {
            let msg = event.ResourceStatus + ' ' + event.LogicalResourceId;
            if (event.ResourceStatusReason) msg += ': ' + event.ResourceStatusReason;
            cb(null, currentTime() + ' ' + region + ': ' + msg + '\n');
        };

        events.pipe(stringify).pipe(process.stdout);
        stringify.on('end', resolve);
    });
}

function currentTime() {
    const now = new Date();
    const hour = ('00' + now.getUTCHours()).slice(-2);
    const min = ('00' + now.getUTCMinutes()).slice(-2);
    const sec = ('00' + now.getUTCSeconds()).slice(-2);
    return [hour, min, sec].join(':') + 'Z';
}

async function fetcher(url, body) {
    console.log('Posting metadata to API', JSON.stringify(body));
    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': APIKEY
        },
        body: JSON.stringify(body)
    });

    if (!res.ok) {
        const texterr = await res.text();
        let jsonerr;
        try {
            jsonerr = JSON.parse(texterr);
        } catch (err) {
            throw new Error(texterr);
        }

        if (jsonerr.message) throw new Error(jsonerr.message);
        throw new Error(texterr);
    }

    const json = await res.json();

    if (json && Array.isArray(json.errors) && json.errors.length) {
        throw new Error(json.errors[0].message);
    }

    return json;
}

if (import.meta.url === `file://${process.argv[1]}`) handler();
