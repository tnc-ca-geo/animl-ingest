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
import Zip from 'adm-zip';
import Stack from './lib/stack.js';

const APIKEY = process.env.APIKEY;

export default async function handler() {
    const task = JSON.parse(process.env.TASK);
    const batch = task.Key.replace('.zip', '');
    const StackName = `${process.env.StackName}-${batch}`;

    try {
        const s3 = new S3.S3Client({ region: process.env.AWS_DEFAULT_REGION || 'us-east-1' });
        const cf = new CloudFormation.CloudFormationClient({ region: process.env.AWS_DEFAULT_REGION || 'us-east-1' });
        const ssm = new SSM.SSMClient({ region: process.env.AWS_DEFAULT_REGION || 'us-east-1' });

        const STAGE = process.env.STAGE || 'dev';

        const params = new Map();
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
            variables: {
                input: {
                    _id: batch,
                    eTag: JSON.parse(head.ETag), // Required to remove double escape by AWS
                    processingStart: new Date()
                }
            }
        });

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

        const zip = new Zip(path.resolve(os.tmpdir(), 'input.zip'));

        let total = 0;
        for (const entry of zip.getEntries()) {
            const parsed = path.parse(entry.entryName);
            if (!parsed.ext) continue;
            if (parsed.base[0] === '.') continue;

            const data = entry.getData();
            // Ensure if there are images with the same name they don't clobber on s3
            const key = crypto.createHash('md5').update(data).digest('hex');

            console.log(`ok - writing: ${batch}/${key}${parsed.ext}`);
            await s3.send(new S3.PutObjectCommand({
                Bucket: task.Bucket,
                Key: `${batch}/${key}${parsed.ext}`,
                Body: data
            }));
            total++;
        }

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
            variables: {
                input: {
                    _id: batch,
                    total: total
                }
            }
        });

        await s3.send(new S3.DeleteObjectCommand({
            Bucket: task.Bucket,
            Key: task.Key
        }));

        console.log('ok - extraction complete');
    } catch (err) {
        console.error(err);

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
    }
}

function monitor(StackName) {
    const region = process.env.AWS_DEFAULT_REGION || 'us-east-1';

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
