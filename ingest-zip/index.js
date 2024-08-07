import os from 'os';
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
import asyncPool from 'tiny-async-pool';

const API_KEY = process.env.API_KEY;

// If this is changed also update ingest-image
const SUPPORTED_FILE_TYPES = ['.jpg', '.jpeg', '.png'];
const UPDATE_BATCH_QUERY = `
  mutation UpdateBatch($input: UpdateBatchInput!){
      updateBatch(input: $input) {
          batch {
              _id
              total
          }
      }
  }
`;

export default async function handler() {
  const task = JSON.parse(process.env.TASK);
  const batch = task.Key.replace('.zip', '');
  const StackName = `${process.env.StackName}-${batch}`;
  const STAGE = process.env.STAGE || 'dev';

  const params = new Map();

  try {
    const s3 = new S3.S3Client({ region: process.env.AWS_DEFAULT_REGION || 'us-west-2' });
    const cf = new CloudFormation.CloudFormationClient({
      region: process.env.AWS_DEFAULT_REGION || 'us-west-2',
    });
    const ssm = new SSM.SSMClient({ region: process.env.AWS_DEFAULT_REGION || 'us-west-2' });

    for (const param of (
      await ssm.send(
        new SSM.GetParametersCommand({
          Names: [`/api/url-${STAGE}`],
          WithDecryption: true,
        })
      )
    ).Parameters) {
      console.log(`ok - setting ${param.Name}`);
      params.set(param.Name, param.Value);
    }

    await pipeline(
      (
        await s3.send(
          new S3.GetObjectCommand({
            Bucket: task.Bucket,
            Key: task.Key,
          })
        )
      ).Body,
      fs.createWriteStream(path.resolve(os.tmpdir(), 'input.zip'))
    );

    // Preparse Zip to get a general sense of how many items are in the zip
    // and if it is empty ignore it
    const zip = new StreamZip.async({
      file: path.resolve(os.tmpdir(), 'input.zip'),
      skipEntryNameValidation: true,
    });

    let total = 0;
    const entries = await zip.entries();
    for (const entrykey in entries) {
      const entry = entries[entrykey];
      const parsed = path.parse(entry.name);
      if (!parsed.ext) continue;
      if (parsed.base[0] === '.') continue;
      if (!SUPPORTED_FILE_TYPES.includes(parsed.ext.toLowerCase())) continue;
      total++;
    }

    zip.close();

    const now = new Date();
    const input = {
      _id: batch,
      total: total,
      uploadComplete: now,
    };

    if (total === 0) {
      console.log('ok - no image files to process');
      (input.processingStart = now), (input.processingEnd = now);
    }

    await fetcher(params.get(`/api/url-${STAGE}`), {
      query: UPDATE_BATCH_QUERY,
      variables: { input },
    });

    await cf.send(
      new CloudFormation.CreateStackCommand({
        StackName,
        TemplateBody: JSON.stringify(Stack.generate(process.env.StackName, task, STAGE)),
        Parameters: [
          {
            ParameterKey: 'BatchID',
            ParameterValue: batch,
          },
          {
            ParameterKey: 'S3URL',
            ParameterValue: `s3://${task.Bucket}/${task.Key}`,
          },
        ],
      })
    );

    await monitor(StackName);

    await fetcher(params.get(`/api/url-${STAGE}`), {
      query: UPDATE_BATCH_QUERY,
      variables: {
        input: {
          _id: batch,
          processingStart: new Date(),
        },
      },
    });

    const prezip = new StreamZip.async({
      file: path.resolve(os.tmpdir(), 'input.zip'),
      skipEntryNameValidation: true,
    });

    const preentries = await prezip.entries();
    const images = [];
    for (const entrykey in preentries) {
      const entry = preentries[entrykey];
      images.push(entry);
    }

    console.time('copying images to S3 @ 100 concurrency');

    let maxMemoryUsed = 0;
    for await (const ms of asyncPool(100, images, async (entry) => {
      const parsed = path.parse(entry.name);
      if (!parsed.ext) return `not ok - no extension: ${entry.name}`;
      if (parsed.base[0] === '.') return `not ok - hidden file: ${entry.name}`;
      if (!SUPPORTED_FILE_TYPES.includes(parsed.ext.toLowerCase()))
        return `not ok - unsupported file type: ${entry.name}`;

      const data = await prezip.entryData(entry);

      // NOTE: just for logging memory usage
      if (process.memoryUsage().rss > maxMemoryUsed) {
        maxMemoryUsed = process.memoryUsage().rss;
      }

      await s3.send(
        new S3.PutObjectCommand({
          Bucket: task.Bucket,
          Key: `${batch}/${entry.name}`,
          Body: data,
        })
      );

      return `ok - written: ${batch}/${entry.name}`;
    })) {
      console.log(ms);
    }

    console.timeEnd('copying images to S3 @ 100 concurrency');
    console.log(`max memory used: ${maxMemoryUsed / 1024 / 1024} MB`);

    prezip.close();

    await s3.send(
      new S3.DeleteObjectCommand({
        Bucket: task.Bucket,
        Key: task.Key,
      })
    );

    console.log('ok - extraction complete');

    await fetcher(params.get(`/api/url-${STAGE}`), {
      query: UPDATE_BATCH_QUERY,
      variables: {
        input: {
          _id: batch,
          ingestionComplete: new Date(),
        },
      },
    });
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
            batch: batch,
          },
        },
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
    const events = EventStream(StackName, { region }).on('error', (err) => {
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
      'x-api-key': API_KEY,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    console.error('ERROR: Headers:', JSON.stringify(Object.fromEntries(res.headers)));

    const texterr = await res.text();
    let jsonerr;
    try {
      jsonerr = JSON.parse(texterr);
    } catch (err) {
      throw new Error(texterr);
    }

    console.error('ERROR: Body:', JSON.stringify(jsonerr));
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
