import crypto from 'crypto';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { pipeline } from 'stream/promises';
import S3 from '@aws-sdk/client-s3';
import SSM from '@aws-sdk/client-ssm';
import CloudFormation from '@aws-sdk/client-cloudformation';
import Zip from 'adm-zip';
import Stack from './lib/stack.js';

const APIKEY = process.env.APIKEY;

export default async function handler() {
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

    const task = JSON.parse(process.env.TASK);

    await pipeline(
        (await s3.send(new S3.GetObjectCommand({
            Bucket: task.Bucket,
            Key: task.Key
        }))).Body,
        fs.createWriteStream(path.resolve(os.tmpdir(), 'input.zip'))
    );

    const batch = `batch-${crypto.randomUUID()}`;
    console.log(`ok - generated batch id: ${batch}`);

    await cf.send(new CloudFormation.CreateStackCommand({
        StackName: `${process.env.StackName}-${batch}`,
        TemplateBody: JSON.stringify(Stack.generate(process.env.StackName)),
        Parameters: [{
            ParameterKey: 'BatchID',
            ParameterValue: batch
        },{
            ParameterKey: 'S3URL',
            ParameterValue: `s3://${task.Bucket}/${task.Key}`
        }]
    }));

    console.log('ok - created batch stack');

    await fetcher(params.get(`/api/url-${STAGE}`), {
        query: `
            mutation CreateBatch($input: CreateBatchInput!) {
                createBatch(input: $input) {
                    batch {
                        _id
                        processingStart
                    }
                }
            }
        `,
        variables: {
            input: {
                _id: batch,
                processingStart: new Date()
            }
        }
    });

    const zip = new Zip(path.resolve(os.tmpdir(), 'input.zip'));

    let total = 0;
    for (const entry of zip.getEntries()) {
        const { ext } = path.parse(entry.entryName);
        if (!ext) continue;

        const data = entry.getData();
        // Ensure if there are images with the same name they don't clobber on s3
        const key = crypto.createHash('md5').update(data).digest('hex');

        console.log(`ok - writing: ${batch}/${key}${ext}`);
        await s3.send(new S3.PutObjectCommand({
            Bucket: task.Bucket,
            Key: `${batch}/${key}${ext}`,
            Body: data
        }));
        total++;
    }

    await fetcher(params.get(`/api/url-${STAGE}`), {
        query: `
            mutation CreateBatch($input: CreateBatchInput!){
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
                total
            }
        }
    });

    await s3.send(new S3.DeleteObjectCommand({
        Bucket: task.Bucket,
        Key: task.Key
    }));

    console.log('ok - extraction complete');
}

async function fetcher(url, body) {
    console.log('Posting metadata to API');
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
